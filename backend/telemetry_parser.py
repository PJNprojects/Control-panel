"""
Turning one line of gateway serial output into something the browser can draw.

THE ONE RULE THE WIRE FORMAT HAS
--------------------------------
From `ESP Gateway/HANDOFF.md` section 1:

    This line starts with '#' - any PC-side parser should skip lines starting
    with '#' and treat everything else as data.

That is the entire classification algorithm, and it is deliberately that dumb:
the boot header, the removed-debug lines, and (since gateway V1.3.4) every
command acknowledgement all share the '#' prefix precisely so that adding the
command channel needed no parser change on this side. We do not try to be
cleverer than that. We do not sniff for the header line and hide it — the
header IS the "gateway just booted" marker and an operator wants to see it
arrive.

    line starts with '#'  ->  {"type": "log"}      -> scrolling log panel
    anything else         ->  {"type": "telemetry"} -> latest-reading card

THE RECORD
----------
Thirteen fields, tab-separated, one per BLE notify. Header, verbatim from
`ESP Gateway/PROTOCOL_V10.md` section 2.1 (and from REC_HEADER in the
gateway's `src/main.cpp`):

    # timestamp<TAB>collar_id<TAB>ax<TAB>ay<TAB>az<TAB>gx<TAB>gy<TAB>gz<TAB>temperature<TAB>rfid_id<TAB>rfid_valid<TAB>ble_connected<TAB>age_ms

WHAT CHANGED IN GATEWAY V1.3.5 (and why this file moved with it)
---------------------------------------------------------------
`rfid_valid` is new, and it is inserted in the MIDDLE of the old record — at
position 11, exactly where `ble_connected` used to sit. That is the whole
change: twelve fields became thirteen, nothing was renamed or reordered
around it. A parser built for the old format does not fail loudly against the
new one field-by-field; it reads `ble_connected` out of `rfid_valid`'s column
and `age_ms` out of `ble_connected`'s. The length check in parse_telemetry()
below is what actually catches that, which is why it is a hard equality
against FIELD_COUNT and not a `>=`.

`rfid_valid` is 1 iff the COLLAR's own RFID session-confirmation logic (five
CRC-valid reads of the same tag within 2s) was confirmed on the packet that
produced this record. It is never '-': it is a boolean flag, not a value that
can be "not fresh", so a not-fresh record prints 0.

It carries no information that `rfid_id`/`temperature` being '-' didn't
already carry — PROTOCOL_V10.md section 2.3 is explicit that a parser may use
either signal, and that `rfid_valid` exists so it doesn't have to
string-compare against '-'. It is worth having anyway because the '-' signal
was, until V1.3.5, wrong: pre-V1.3.5 firmware wrote `rfid_id`/`temperature`
only on a confirmed read and then NEVER reset them, so one tag seen once kept
reprinting for the rest of the session. V1.3.5 derives RFID freshness from
the current packet's flag bit, the same way IMU freshness always worked, so
the two signals now agree by construction.

SENTINELS ARE NOT ZEROS
-----------------------
The handoff is emphatic about this and it is the one thing a parser can get
subtly, silently wrong:

    Never treat '-' as zero. A genuinely stationary board reads real, small,
    near-zero numbers in ax/ay/az. '-' means "the collar didn't say this was
    fresh", not "the value is zero".

So '-' becomes None (JSON null), never 0. Same for `age_ms`'s -1, which means
"no packet has ever arrived this session" and would otherwise plot as a
negative age. The frontend renders None as a dash again, which closes the loop
without ever having invented a number.
"""

from typing import Any, Dict, List, Optional

# The '-' that the gateway prints for "not fresh / nothing valid yet".
# `REC_NONE` in the gateway's main.cpp.
NONE_SENTINEL = "-"

# age_ms uses a numeric sentinel instead, because 0 is a legitimate age (it is
# what the line that just arrived reports).
AGE_NONE_SENTINEL = -1

# Lines that are diagnostics rather than records.
LOG_PREFIX = "#"

FIELD_SEPARATOR = "\t"

# Order is load-bearing: it is positional on the wire. Do not sort, do not
# rearrange for readability.
TELEMETRY_FIELDS: List[str] = [
    "timestamp",
    "collar_id",
    "ax",
    "ay",
    "az",
    "gx",
    "gy",
    "gz",
    "temperature",
    "rfid_id",
    "rfid_valid",
    "ble_connected",
    "age_ms",
]

FIELD_COUNT = len(TELEMETRY_FIELDS)  # 13 as of gateway V1.3.5 (was 12)

# Human-facing units, exposed so the UI does not have to hardcode them.
FIELD_UNITS: Dict[str, str] = {
    "timestamp": "ms since gateway boot",
    "collar_id": "",
    "ax": "centi-m/s^2",
    "ay": "centi-m/s^2",
    "az": "centi-m/s^2",
    "gx": "milli-rad/s",
    "gy": "milli-rad/s",
    "gz": "milli-rad/s",
    "temperature": "degC (RFID implant, not ambient)",
    "rfid_id": "country(3) + national ID(12)",
    "rfid_valid": "1 = collar confirmed this read",
    "ble_connected": "1 = link up",
    "age_ms": "ms since last valid packet",
}


def is_log_line(line: str) -> bool:
    """True for '#'-prefixed diagnostics: boot header, acks, status."""
    return line.lstrip().startswith(LOG_PREFIX)


def _parse_int_or_none(raw: str, field: str) -> Optional[int]:
    if raw == NONE_SENTINEL:
        return None
    try:
        return int(raw, 10)
    except ValueError:
        raise ValueError("field '%s': expected integer or '-', got %r" % (field, raw))


def parse_telemetry(line: str) -> Dict[str, Any]:
    """Parse one 13-field record. Raises ValueError if it is not one.

    Returns a dict keyed by TELEMETRY_FIELDS. Sentinels come back as None.
    """
    parts = line.rstrip("\r\n").split(FIELD_SEPARATOR)
    if len(parts) != FIELD_COUNT:
        raise ValueError(
            "expected %d tab-separated fields, got %d" % (FIELD_COUNT, len(parts))
        )

    record: Dict[str, Any] = {}

    # 1: timestamp - millis() since the gateway booted. Never absent.
    record["timestamp"] = _parse_int_or_none(parts[0], "timestamp")

    # 2: collar_id - hardcoded "C001" today. Never absent, kept as text
    #    because it is an identifier, not a number.
    record["collar_id"] = parts[1]

    # 3-8: ax ay az gx gy gz - raw ints, '-' when the collar's last packet had
    #      no fresh IMU reading. Deliberately NOT scaled here; the gateway
    #      sends raw counts and this parser stays a transport-level thing.
    #      Scaling (accel /100 -> m/s^2, gyro /1000 -> rad/s) is presentation
    #      and lives in the UI, where it can be shown alongside the raw value.
    for index, name in enumerate(("ax", "ay", "az", "gx", "gy", "gz"), start=2):
        record[name] = _parse_int_or_none(parts[index], name)

    # 9: temperature - one decimal, or '-' if no tag with a temperature has
    #    been read this session.
    raw_temp = parts[8]
    if raw_temp == NONE_SENTINEL:
        record["temperature"] = None
    else:
        try:
            record["temperature"] = float(raw_temp)
        except ValueError:
            raise ValueError("field 'temperature': expected number or '-', got %r"
                             % raw_temp)

    # 10: rfid_id - digits as text (15 of them; leading zeros matter, so this
    #     must never become an int).
    record["rfid_id"] = None if parts[9] == NONE_SENTINEL else parts[9]

    # 11: rfid_valid - always 0 or 1, never '-'. It is a flag saying whether
    #     the collar confirmed a read on this packet, so "not fresh" is
    #     expressed as 0, not as the '-' sentinel. Validated exactly like
    #     ble_connected below, and stored the same way (0/1 int, not a Python
    #     bool) so the two flag fields stay one convention across the record
    #     and across the JSON that reaches the browser.
    rfid_valid = _parse_int_or_none(parts[10], "rfid_valid")
    if rfid_valid not in (0, 1):
        raise ValueError("field 'rfid_valid': expected 0 or 1, got %r" % parts[10])
    record["rfid_valid"] = rfid_valid

    # 12: ble_connected - always 0 or 1, never '-'.
    ble = _parse_int_or_none(parts[11], "ble_connected")
    if ble not in (0, 1):
        raise ValueError("field 'ble_connected': expected 0 or 1, got %r" % parts[11])
    record["ble_connected"] = ble

    # 13: age_ms - -1 means "no packet ever this session"; 0 is legitimate.
    age = _parse_int_or_none(parts[12], "age_ms")
    record["age_ms"] = None if age == AGE_NONE_SENTINEL else age

    return record


def classify(line: str) -> Dict[str, Any]:
    """Classify and parse one line into an SSE-ready event dict.

    Always returns something — this sits in the path of a live stream and must
    never throw on garbage arriving from a half-open port.

    Three outcomes:
      {"type": "log",       "text": ...}                  '#' line
      {"type": "telemetry", "text": ..., "data": {...}}    good 13-field record
      {"type": "log",       "text": ..., "parse_error":}   anything else

    JUDGEMENT CALL: a non-'#' line that fails to parse is surfaced as a log
    entry carrying its parse_error, not dropped and not faked into a partial
    record. Line noise on a flaky USB cable and a genuine format change look
    identical to a parser; both are things the operator needs to SEE rather
    than have quietly swallowed.
    """
    text = line.rstrip("\r\n")

    if is_log_line(text):
        return {"type": "log", "text": text}

    try:
        return {"type": "telemetry", "text": text, "data": parse_telemetry(text)}
    except ValueError as exc:
        return {"type": "log", "text": text, "parse_error": str(exc)}
