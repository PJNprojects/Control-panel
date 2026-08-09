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

    `send` is a str.format template. For the six no-argument commands it has no
    placeholders and formats to itself; the parameterised one has `{n}` / `{m}`.
    Keeping both cases in one field means `render()` has no special case.
    """

    name: str
    label: str
    send: str
    description: str = ""
    group: str = "general"
    danger: bool = False
    params: List[ParamSpec] = field(default_factory=list)

    def to_json(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "send": self.send,
            "description": self.description,
            "group": self.group,
            "danger": self.danger,
            "params": [p.to_json() for p in self.params],
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
#  Seven entries, one per row of `ESP Gateway/HANDOFF.md` section 2's table.
#  To add an eighth command: add a dict-equivalent Command(...) here. That is
#  the whole change — the API and the UI pick it up automatically.
# ---------------------------------------------------------------------------

COMMANDS: List[Command] = [
    Command(
        name="sleep",
        label="SLEEP",
        send="SLEEP",
        group="power",
        danger=True,
        description=(
            "Stops the packet stream and forces the RFID field off. An overlay, "
            "not a mode change - whatever was running underneath is preserved. "
            "Telemetry goes silent until WAKE."
        ),
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
    ),
    Command(
        name="read_rfid_once",
        label="READ RFID <n> <m>",
        send="READ RFID {n} {m}",
        group="rfid",
        description=(
            "One-shot scan: up to m capture attempts, stopping early once n "
            "CRC-valid reads land. Reverts to whatever mode was active before. "
            "At roughly 70 ms per attempt, m is a rough worst-case time bound."
        ),
        params=[
            ParamSpec(
                name="n",
                label="n - successful reads wanted",
                minimum=0,
                maximum=255,
                default=5,
                help="Stops early once this many CRC-valid reads land.",
            ),
            ParamSpec(
                name="m",
                label="m - attempt cap",
                minimum=0,
                maximum=255,
                default=20,
                help="Hard ceiling on capture attempts (~70 ms each).",
            ),
        ],
    ),
    Command(
        name="read_rfid_loop",
        label="READ RFID LOOP",
        send="READ RFID LOOP",
        group="rfid",
        description="Start continuous scanning.",
    ),
    Command(
        name="stop_rfid_loop",
        label="STOP RFID LOOP",
        send="STOP RFID LOOP",
        group="rfid",
        description=(
            "Stop continuous scanning. Fixed three-word phrase - 'STOP RFID' is "
            "not a shorthand the gateway accepts."
        ),
    ),
    Command(
        name="imu_run",
        label="IMU RUN",
        send="IMU RUN",
        group="imu",
        description="Start populating the IMU fields (ax..gz stop reading '-').",
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
