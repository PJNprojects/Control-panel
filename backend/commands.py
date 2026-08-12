"""
The command registry — the single place that knows what this panel can say to
the gateway.

WHY A REGISTRY AND NOT SEVEN ROUTES
-----------------------------------
The obvious way to build this is one Flask route per command (`/api/sleep`,
`/api/wake`, ...) and seven hardcoded <button> tags in the HTML. That works
until the eighth command exists, at which point it needs a Python change, a
route change, an HTML change and a JS change — four places to forget one.

So instead: every command is one entry in COMMANDS below. The HTTP layer has
exactly ONE command endpoint that looks entries up by name, and the browser
builds its buttons from `GET /api/commands` at page load. Adding a command is
adding a dict to this list. Nothing else. No route, no HTML, no JS.

    COMMANDS (this file)
            |
            +--> GET  /api/commands  --> browser renders one control per entry
            |
            +--> POST /api/command   --> render_command() --> serial write

THE GRAMMAR THIS MIRRORS
------------------------
The `send` text of each entry is the exact ASCII the ESP32 gateway's parser
accepts, taken from `ESP Gateway/HANDOFF.md` section 2. The gateway is
case-insensitive and whitespace-tolerant, but we send the canonical uppercase
single-spaced form anyway so that what the operator sees in the log panel is
byte-identical to what the gateway echoes back in its `# cmd: ... -> sent`
acknowledgement. Matching strings are easy to eyeball; almost-matching ones
waste an afternoon.

The gateway does NOT prefix-match and does NOT clamp out-of-range numbers — it
rejects. We therefore validate here too, before touching the serial port, so a
bad value costs a JSON error instead of a round trip and a `# cmd: unknown`.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# The gateway's own input buffer is `#define CMD_LINE_MAX 48` in
# `ESP Gateway/src/main.cpp`, and it discards any line that fills it
# ("# cmd: line too long, discarded"). 48 counts the NUL terminator, so 47
# characters is the real ceiling. Mirrored here so an over-long raw command is
# refused locally with a useful message instead of being silently eaten by the
# far end.
GATEWAY_MAX_LINE_CHARS = 47

# The reserved registry name for the free-text escape hatch. It is deliberately
# ugly so it cannot collide with a real command name added later.
RAW_COMMAND_NAME = "__raw__"


class CommandError(ValueError):
    """A command could not be rendered: unknown name, or bad parameters.

    Raised *before* any serial write is attempted. The HTTP layer turns this
    into a 400 with the message text — these messages are read by a human
    staring at a browser, so they name the offending parameter and its allowed
    range rather than saying "invalid input".
    """


@dataclass(frozen=True)
class ParamSpec:
    """One numeric slot in a command template.

    Only integers exist today because the only parameterised command in the
    gateway's grammar is `READ RFID <n> <m>`, where both slots are plain
    decimals in 0-255 (one byte each on the BLE wire). `kind` is carried
    explicitly anyway so a future string or enum parameter is an addition here
    rather than a redesign of the validator.
    """

    name: str
    label: str
    kind: str = "int"
    minimum: int = 0
    maximum: int = 255
    default: int = 0
    help: str = ""

    def to_json(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "kind": self.kind,
            "min": self.minimum,
            "max": self.maximum,
            "default": self.default,
            "help": self.help,
        }

    def coerce(self, raw: Any) -> int:
        """Validate one supplied value, or raise CommandError.

        Accepts an int, or a string of digits (the browser sends form values as
        strings). Rejects floats-that-look-like-ints ("5.0"), booleans, and
        anything outside the declared range. Rejection, not clamping — the
        gateway rejects too, and a panel that quietly turned 999 into 255 would
        be lying to the operator about what the collar was told to do.
        """
        if self.kind != "int":
            raise CommandError(
                "parameter '%s' has unsupported kind '%s'" % (self.name, self.kind)
            )

        # bool is a subclass of int in Python; True would sail through int()
        # and become 1. Nobody means that here, so refuse it.
        if isinstance(raw, bool):
            raise CommandError("parameter '%s' must be a whole number" % self.name)

        if isinstance(raw, int):
            value = raw
        elif isinstance(raw, str):
            text = raw.strip()
            if not text:
                raise CommandError("parameter '%s' is required" % self.name)
            try:
                value = int(text, 10)
            except ValueError:
                raise CommandError(
                    "parameter '%s' must be a whole number, got %r" % (self.name, raw)
                )
        else:
            raise CommandError(
                "parameter '%s' must be a whole number, got %r" % (self.name, raw)
            )

        if value < self.minimum or value > self.maximum:
            raise CommandError(
                "parameter '%s' must be between %d and %d, got %d"
                % (self.name, self.minimum, self.maximum, value)
            )
        return value


@dataclass(frozen=True)
class Command:
    """One thing the operator can send.

    `send` is a str.format template. For the four no-argument commands it has
    no placeholders and formats to itself; the one parameterised command,
    `read_rfid_once`, has `{m}` (its `n` is baked into the template text as a
    literal `1`, not a placeholder - see the comment on that entry below).
    Keeping both cases in one field means `render()` has no special case.
    """

    name: str
    label: str
    send: str
    description: str = ""
    group: str = "general"
    danger: bool = False
    params: List[ParamSpec] = field(default_factory=list)

    # --- Toggle pairing, optional -------------------------------------
    # Two commands that are really one on/off control (SLEEP+WAKE, IMU
    # RUN+HALT, READ RFID LOOP+STOP RFID LOOP) declare the SAME
    # toggle_group and opposite toggle_state ("on"/"off"). The browser
    # renders any complete pair as a single switch instead of two buttons -
    # this is data on the registry entries, not a special case in the UI,
    # so the "add a command = one entry here" rule from the module
    # docstring still holds for toggle pairs too.
    #
    # toggle_default says which side the switch should show BEFORE any
    # command has been sent this session, taken from the collar's
    # documented boot behaviour (HANDOFF.md section 4): not asleep, IMU
    # halted, RFID loop stopped. It is a starting guess, not a read-back -
    # see the reality check below.
    toggle_group: Optional[str] = None
    toggle_state: Optional[str] = None    # "on" | "off"
    toggle_style: Optional[str] = None    # "slider" | "press"
    toggle_label: Optional[str] = None    # caption shown on the control
    toggle_default: Optional[str] = None  # "on" | "off"

    # What a "press" toggle's BUTTON ITSELF says in this state, as opposed to
    # `label` (which is this command's own name, used in tooltips/logs). A
    # press-toggle showing its OFF-state button as "STOP RFID LOOP" reads as
    # a live control for something that isn't running - confusing, not
    # merely cosmetic. toggle_text is the fix: each half of a pair says what
    # a status button should say ("Start IMU" / "IMU RUNNING"), independent
    # of the underlying command's own label. Optional - a control falls back
    # to `label` if unset (that's fine for the slider, where "SLEEP"/"WAKE"
    # already read naturally as states).
    toggle_text: Optional[str] = None

    # --- RFID one-shot "no tag found" timeout, optional -----------------
    # READ RFID <n> <m> has no completion signal (README section 6) - the
    # gateway never says "done, found nothing." The one honest thing the
    # browser CAN infer is a time budget: m attempts at ~70ms each
    # (HANDOFF.md), after which "no fresh tag showed up" is a fair
    # best-effort read. rfid_scan_probe_param names which of THIS command's
    # own params holds that attempt count ("m") so the UI can compute the
    # budget generically, without hardcoding this command's name.
    rfid_scan_probe_param: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "send": self.send,
            "description": self.description,
            "group": self.group,
            "danger": self.danger,
            "params": [p.to_json() for p in self.params],
            "toggle_group": self.toggle_group,
            "toggle_state": self.toggle_state,
            "toggle_style": self.toggle_style,
            "toggle_label": self.toggle_label,
            "toggle_default": self.toggle_default,
            "toggle_text": self.toggle_text,
            "rfid_scan_probe_param": self.rfid_scan_probe_param,
        }

    def render(self, params: Optional[Dict[str, Any]] = None) -> str:
        """Turn this entry plus supplied params into the exact ASCII line.

        Unknown parameter names are rejected rather than ignored: if the caller
        sent `{"count": 5}` when the spec says `n`, silently dropping it would
        produce a valid-looking command carrying the default value, which is a
        far worse failure than an error message.
        """
        supplied = dict(params or {})
        values: Dict[str, int] = {}

        for spec in self.params:
            if spec.name not in supplied:
                raise CommandError(
                    "command '%s' requires parameter '%s'" % (self.name, spec.name)
                )
            values[spec.name] = spec.coerce(supplied.pop(spec.name))

        if supplied:
            raise CommandError(
                "command '%s' got unexpected parameter(s): %s"
                % (self.name, ", ".join(sorted(supplied)))
            )

        return self.send.format(**values)


# ---------------------------------------------------------------------------
#  THE REGISTRY
#
#  Five buttoned entries out of the gateway's seven-command grammar (section
#  2 of `ESP Gateway/HANDOFF.md` still documents all seven - READ RFID LOOP
#  and STOP RFID LOOP are deliberately unbuttoned here, see the comment
#  above their spot in the list below).
#  To add an eighth command: add a dict-equivalent Command(...) here. That is
#  the whole change — the API and the UI pick it up automatically.
#
#  THREE OF THEM ARE TOGGLE PAIRS, AND A REALITY CHECK ABOUT WHAT THAT MEANS
#  ---------------------------------------------------------------------------
#  SLEEP/WAKE, IMU RUN/HALT, and READ RFID LOOP/STOP RFID LOOP each render as
#  one switch instead of two buttons (see toggle_group above). The switch
#  position is the LAST STATE THE OPERATOR SENT, not a confirmed hardware
#  state — the gateway has no reply channel ("-> sent is not -> done", see
#  README section 1), so there is no packet that could tell the browser the
#  collar actually obeyed. If a command is rejected the switch snaps back;
#  if it is accepted but the collar ignores it for some other reason, the
#  switch will show the wrong thing and the only ground truth is still what
#  README.md always said it was: read it off the telemetry (IMU columns
#  leaving '-', the stream stopping, etc.), not off this control.
# ---------------------------------------------------------------------------

COMMANDS: List[Command] = [
    Command(
        name="sleep",
        label="SLEEP",
        send="SLEEP",
        group="power",
        description=(
            "Stops the packet stream and forces the RFID field off. An overlay, "
            "not a mode change - whatever was running underneath is preserved. "
            "Telemetry goes silent until WAKE."
        ),
        toggle_group="power",
        toggle_state="off",
        toggle_style="slider",
        toggle_label="SLEEP / WAKE",
        toggle_default="on",   # collar is not asleep by default
    ),
    Command(
        name="wake",
        label="WAKE",
        send="WAKE",
        group="power",
        description=(
            "Clears sleep and resumes exactly what was configured before. You do "
            "NOT need to re-send READ RFID LOOP / IMU RUN afterwards."
        ),
        toggle_group="power",
        toggle_state="on",
        toggle_style="slider",
        toggle_label="SLEEP / WAKE",
        toggle_default="on",
    ),
    Command(
        # n is hardcoded to 1, not a parameter — changed 2026-08-10 at the
        # operator's direction after bench testing: with n>1 (the old
        # default was 5), the command doesn't stop until that many
        # CRC-valid reads land, so the FIRST fresh rfid_id telemetry after
        # sending it is NOT the same thing as "the scan is done" - the
        # command can still be mid-flight, attempting more reads, when this
        # panel's one-shot logic (which resolves on the first fresh read,
        # see armRfidScan()/logScanResult() in app.js) already considered it
        # finished. That mismatch is what produced misleading Scan History
        # rows. n=1 makes "first fresh read" and "command done" the same
        # event, which is what "one scan, one verified read" should mean
        # anyway. m (the attempt cap, still a real parameter) is unaffected -
        # a genuinely empty scan still runs its full attempt budget before
        # this panel calls it a "no tag".
        name="read_rfid_once",
        label="READ RFID <m>",
        send="READ RFID 1 {m}",
        group="rfid",
        description=(
            "One-shot scan: stops as soon as ONE CRC-valid read lands (n is "
            "fixed at 1), or gives up after m attempts. Reverts to whatever "
            "mode was active before. At roughly 70 ms per attempt, m is a "
            "rough worst-case time bound."
        ),
        params=[
            ParamSpec(
                name="m",
                label="m - attempt cap",
                minimum=0,
                maximum=255,
                default=20,
                help="Hard ceiling on capture attempts (~70 ms each).",
            ),
        ],
        rfid_scan_probe_param="m",
    ),
    # READ RFID LOOP / STOP RFID LOOP intentionally have no button (removed
    # 2026-08-10 - continuous scanning didn't fit how this collar is
    # actually operated: the one-shot READ RFID <n> <m> above, plus the
    # auto-scan timer on the Scan History card, cover it with a result you
    # can log. The gateway still accepts both commands - they're one line
    # each in the raw command box below if you ever need them.
    Command(
        name="imu_run",
        label="IMU RUN",
        send="IMU RUN",
        group="imu",
        description="Start populating the IMU fields (ax..gz stop reading '-').",
        toggle_group="imu_run",
        toggle_state="on",
        toggle_style="press",
        toggle_label="IMU",
        toggle_default="off",   # collar boots with the IMU halted
        toggle_text="IMU RUNNING",
    ),
    Command(
        name="imu_halt",
        label="IMU HALT",
        send="IMU HALT",
        group="imu",
        description=(
            "Stop populating the IMU fields. Does NOT silence the link - packets "
            "keep flowing with '-' in the IMU columns. Only SLEEP stops the "
            "stream. Note the word is HALT, not STOP."
        ),
        toggle_group="imu_run",
        toggle_state="off",
        toggle_style="press",
        toggle_label="IMU",
        toggle_default="off",
        toggle_text="Start IMU",
    ),
]

_BY_NAME: Dict[str, Command] = {c.name: c for c in COMMANDS}
if len(_BY_NAME) != len(COMMANDS):
    raise RuntimeError("duplicate command name in COMMANDS registry")


def list_commands() -> List[Dict[str, Any]]:
    """The registry as JSON-safe data, for `GET /api/commands`."""
    return [c.to_json() for c in COMMANDS]


def get_command(name: str) -> Command:
    try:
        return _BY_NAME[name]
    except KeyError:
        raise CommandError("unknown command '%s'" % name)


def validate_raw_text(text: Any) -> str:
    """Validate the free-text escape hatch's payload.

    THE ESCAPE HATCH, AND WHY IT EXISTS
    -----------------------------------
    The registry is authoritative for the buttons, but the gateway's firmware
    can grow a command tomorrow and this panel would need a code change just to
    try it. That is a bad place for a bench tool to be, so there is a raw text
    box wired to the same endpoint under the reserved name `__raw__`, which
    sends what was typed, verbatim, followed by '\\n'.

    Verbatim means verbatim: no uppercasing, no whitespace collapsing. The
    gateway is tolerant of both, and the point of this box is to reproduce
    exactly what an operator would have typed into a dumb terminal — including
    the malformed input they are deliberately testing the parser with.

    Two rules are still enforced, because both are properties of the transport
    rather than opinions about content:

      * No embedded CR or LF. The link is line-oriented, one command per line.
        A pasted newline would send two commands while the UI reported one.
      * Max 47 characters, mirroring the firmware's CMD_LINE_MAX of 48
        (which counts the NUL). Longer input is dropped by the gateway with
        "# cmd: line too long, discarded"; better to say so here.
    """
    if not isinstance(text, str):
        raise CommandError("raw command text must be a string")

    # Trailing newline is what the operator's Enter key means, not content.
    stripped = text.rstrip("\r\n")

    if "\n" in stripped or "\r" in stripped:
        raise CommandError(
            "raw command must be a single line - embedded newlines would send "
            "more than one command"
        )
    if not stripped.strip():
        raise CommandError("raw command text is empty")
    if len(stripped) > GATEWAY_MAX_LINE_CHARS:
        raise CommandError(
            "raw command is %d characters; the gateway discards anything over "
            "%d ('# cmd: line too long, discarded')"
            % (len(stripped), GATEWAY_MAX_LINE_CHARS)
        )
    return stripped


def render_command(name: str, params: Optional[Dict[str, Any]] = None,
                   text: Optional[str] = None) -> str:
    """Resolve a request into the exact ASCII line to write to the port.

    This is the single funnel every command passes through, registry entry or
    raw text alike. It never touches the serial port — it only produces a
    string or raises CommandError, which is what makes it trivial to test
    without hardware.
    """
    if name == RAW_COMMAND_NAME:
        return validate_raw_text(text)
    return get_command(name).render(params)
