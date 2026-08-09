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
Twelve fields, tab-separated, one per BLE notify. Header, verbatim from the
handoff (and from REC_HEADER in the gateway's `src/main.cpp`):

    # timestamp<TAB>collar_id<TAB>ax<TAB>ay<TAB>az<TAB>gx<TAB>gy<TAB>gz<TAB>temperature<TAB>rfid_id<TAB>ble_connected<TAB>age_ms

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
    "ble_connected",
    "age_ms",
]

FIELD_COUNT = len(TELEMETRY_FIELDS)  # 12

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
    """Parse one 12-field record. Raises ValueError if it is not one.

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

    # 11: ble_connected - always 0 or 1, never '-'.
    ble = _parse_int_or_none(parts[10], "ble_connected")
    if ble not in (0, 1):
        raise ValueError("field 'ble_connected': expected 0 or 1, got %r" % parts[10])
    record["ble_connected"] = ble

    # 12: age_ms - -1 means "no packet ever this session"; 0 is legitimate.
    age = _parse_int_or_none(parts[11], "age_ms")
    record["age_ms"] = None if age == AGE_NONE_SENTINEL else age

    return record


def classify(line: str) -> Dict[str, Any]:
    """Classify and parse one line into an SSE-ready event dict.

    Always returns something — this sits in the path of a live stream and must
    never throw on garbage arriving from a half-open port.

    Three outcomes:
      {"type": "log",       "text": ...}                  '#' line
      {"type": "telemetry", "text": ..., "data": {...}}    good 12-field record
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
