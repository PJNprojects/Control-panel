"""
Standalone test harness — run it with `python tests/test_harness.py`.

WHY THIS IS NOT PYTEST
----------------------
Two reasons. First, requirements.txt is deliberately two lines long and a bench
PC that can run the panel should be able to run its tests without installing a
third thing. Second, everything here is either a pure function or a thread
driven by a fake port, so there is nothing pytest would be doing that a plain
assert does not.

WHAT IT COVERS, AND WHY EACH ONE
--------------------------------
  1. LineAssembler        bytes do not arrive as lines. This is the piece most
                          likely to be quietly wrong, because the naive version
                          passes every bench test and fails on real traffic.
  2. Reader thread        driven with a synthetic gateway: boot header, records,
                          an injected ack, a record split across three reads,
                          then a simulated unplug. Checks classification, checks
                          that the exception does not escape, checks the thread
                          exits.
  3. Clean shutdown       an idle port and a stop flag: the thread must leave
                          within one read timeout, not hang.
  4. Command registry     all five buttoned commands rendered byte-for-byte against the
                          table in ESP Gateway/HANDOFF.md section 2.
  5. Validation           out-of-range / unknown / malformed input rejected AND
                          proven to have attempted no serial write.
  6. Telemetry parser     sentinels stay None, never 0.
  7. Live app             Flask actually boots with no port connected and serves
                          / and /api/commands over real HTTP.

No real COM port is touched anywhere in this file.
"""

import json
import os
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "backend"))

import serial  # noqa: E402  (for SerialException in the fake unplug)

import commands as registry  # noqa: E402
import telemetry_parser as parser  # noqa: E402
from serial_link import LineAssembler, SerialLink, Subscriber  # noqa: E402


PASS = 0
FAIL = 0


def check(condition, description, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print("  [ok]   %s" % description)
    else:
        FAIL += 1
        print("  [FAIL] %s" % description)
        if detail:
            print("         %s" % detail)


def section(title):
    print("\n=== %s ===" % title)


# ---------------------------------------------------------------------------
#  A fake serial port
# ---------------------------------------------------------------------------


class FakePort:
    """Duck-types just enough of serial.Serial for _pump_loop.

    Driven by a script of items:
        bytes      -> returned from the next read()
        "idle"     -> read() returns b"" after a short pause, as a real port
                      does when its timeout expires with no data
        Exception  -> raised from read(), i.e. the cable was pulled
    When the script runs out it idles forever, which is what lets the
    stop-flag test have something to stop.
    """

    def __init__(self, script):
        self.script = list(script)
        self.is_open = True
        self.closed = False
        self.reads = 0

    @property
    def in_waiting(self):
        if self.script and isinstance(self.script[0], bytes):
            return len(self.script[0])
        return 0

    def read(self, size=1):
        self.reads += 1
        if not self.script:
            time.sleep(0.01)
            return b""
        item = self.script.pop(0)
        if isinstance(item, bytes):
            return item
        if isinstance(item, BaseException):
            raise item
        time.sleep(0.01)
        return b""

    def close(self):
        self.closed = True
        self.is_open = False


def drain(subscriber):
    events = []
    while True:
        try:
            events.append(subscriber.queue.get_nowait())
        except Exception:
            break
    return events


# ---------------------------------------------------------------------------
#  1. LineAssembler
# ---------------------------------------------------------------------------


def test_line_assembler():
    section("1. LineAssembler - bytes to lines")

    a = LineAssembler()
    check(a.feed(b"123\tC0") == [], "partial line is held, not emitted")
    out = a.feed(b"01\tx\n")
    check(out == ["123\tC001\tx"], "line completed across two reads", repr(out))

    a = LineAssembler()
    out = a.feed(b"one\ntwo\nthree\n")
    check(out == ["one", "two", "three"], "three lines in one chunk", repr(out))

    a = LineAssembler()
    out = a.feed(b"crlf\r\n")
    check(out == ["crlf"], "CRLF stripped to bare text", repr(out))

    a = LineAssembler()
    out = a.feed(b"\n\n  \nreal\n")
    check(out == ["real"], "blank lines produce no events", repr(out))

    a = LineAssembler()
    out = a.feed(b"a" * 600)
    check(any("over-long" in line for line in out),
          "over-long line discarded with a visible notice", repr(out))
    out2 = a.feed(b"tail\nnext\n")
    check(out2 == ["next"],
          "tail of a discarded line is swallowed, next line resyncs", repr(out2))

    a = LineAssembler()
    byte_at_a_time = []
    for byte in b"# hdr\n42\n":
        byte_at_a_time.extend(a.feed(bytes([byte])))
    check(byte_at_a_time == ["# hdr", "42"],
          "one byte per read still assembles correctly", repr(byte_at_a_time))


# ---------------------------------------------------------------------------
#  2. Reader thread against a synthetic gateway
# ---------------------------------------------------------------------------

HEADER = ("# timestamp\tcollar_id\tax\tay\taz\tgx\tgy\tgz\t"
          "temperature\trfid_id\tble_connected\tage_ms")
RECORD_1 = "123457\tC001\t-37\t12\t981\t5\t-3\t128\t38.5\t985141001320293\t1\t1"
RECORD_2 = "124030\tC001\t-\t-\t-\t-\t-\t-\t-\t-\t1\t0"
ACK = "# cmd: READ RFID 5 20 -> sent"


def test_reader_thread_stream():
    section("2. Reader thread - synthetic gateway stream")

    link = SerialLink()
    sub = link.subscribe()

    unplug = serial.SerialException(
        "ClearCommError failed (PermissionError(13, 'The device does not "
        "recognize the command.', None, 22))"
    )

    port = FakePort([
        (HEADER + "\n").encode(),            # boot header
        (RECORD_1 + "\n").encode(),          # a full record
        "idle",
        (ACK + "\n").encode(),               # a command acknowledgement
        # the same record arriving in three pieces, with idles between
        RECORD_2[:10].encode(),
        "idle",
        RECORD_2[10:30].encode(),
        RECORD_2[30:].encode() + b"\n",
        "idle",
        unplug,                              # cable pulled
    ])

    link._stop.clear()
    crashed = []
    try:
        link._pump_loop(port)
    except BaseException as exc:               # must never happen
        crashed.append(exc)

    check(not crashed, "reader loop did not let the unplug exception escape",
          repr(crashed))

    events = drain(sub)
    logs = [e for e in events if e["type"] == "log"]
    telem = [e for e in events if e["type"] == "telemetry"]

    check(len(telem) == 2, "exactly two telemetry records classified",
          "got %d" % len(telem))
    check(any(e["text"] == HEADER for e in logs),
          "boot header classified as a log line, not telemetry")
    check(any(e["text"] == ACK for e in logs),
          "'# cmd: ... -> sent' ack classified as a log line")
    check(any("serial read failed" in e["text"] for e in logs),
          "unplug reported to the UI as a log line",
          repr([e["text"] for e in logs]))

    if len(telem) == 2:
        first = telem[0]["data"]
        check(first["ax"] == -37 and first["az"] == 981 and first["gz"] == 128,
              "record 1 IMU fields parsed", repr(first))
        check(first["temperature"] == 38.5
              and first["rfid_id"] == "985141001320293",
              "record 1 temperature and tag id parsed", repr(first))
        check(first["ble_connected"] == 1 and first["age_ms"] == 1,
              "record 1 link state and age parsed", repr(first))

        second = telem[1]["data"]
        check(second["timestamp"] == 124030 and second["age_ms"] == 0,
              "split-across-three-reads record reassembled intact", repr(second))
        check(all(second[f] is None for f in ("ax", "ay", "az", "gx", "gy", "gz")),
              "'-' sentinels became None, NOT 0", repr(second))

    check(port.closed, "port closed by the loop's cleanup after the failure")
    check(link.status()["connected"] is False,
          "link reports disconnected after the failure", repr(link.status()))
    check(link._last_error is not None, "failure reason retained for the UI")


# ---------------------------------------------------------------------------
#  3. Clean shutdown of an idle reader
# ---------------------------------------------------------------------------


def test_reader_thread_shutdown():
    section("3. Reader thread - clean shutdown while idle")

    link = SerialLink()
    port = FakePort([])          # idles forever, never sends a newline
    link._stop.clear()

    thread = threading.Thread(target=link._pump_loop, args=(port,), daemon=True)
    thread.start()
    time.sleep(0.15)
    check(thread.is_alive(), "reader thread is running against an idle port")

    started = time.time()
    link._stop.set()
    thread.join(timeout=2.0)
    elapsed = time.time() - started

    check(not thread.is_alive(),
          "reader thread exited on the stop flag - no blocking readline() hang")
    check(elapsed < 1.0,
          "exit took %.3fs, within one bounded read timeout" % elapsed)
    check(not port.closed,
          "a requested stop leaves closing to disconnect(), not the thread")


# ---------------------------------------------------------------------------
#  4. Command registry - byte-for-byte against HANDOFF.md section 2
# ---------------------------------------------------------------------------

# Left column of the table in ESP Gateway/HANDOFF.md section 2. Only five of
# its seven rows have a registry entry (and therefore a button) - READ RFID
# LOOP / STOP RFID LOOP were deliberately unbuttoned (see the comment above
# their old spot in commands.py's COMMANDS list); both are still valid
# gateway commands, reachable through the raw command box, just not tested
# here since there's no registry entry for render_command to render.
# read_rfid_once's n is hardcoded to 1 (see the comment on it in
# commands.py) - only m is a real parameter now.
EXPECTED = {
    "sleep":          ("SLEEP",             {}),
    "wake":           ("WAKE",              {}),
    "read_rfid_once": ("READ RFID 1 20",    {"m": 20}),
    "imu_run":        ("IMU RUN",           {}),
    "imu_halt":       ("IMU HALT",          {}),
}


def test_command_registry():
    section("4. Command registry - exact wire text")

    names = [c.name for c in registry.COMMANDS]
    check(len(names) == 5, "registry holds exactly five buttoned commands", repr(names))
    check(set(names) == set(EXPECTED), "registry names match the expected set",
          repr(sorted(names)))

    for name, (expected, params) in EXPECTED.items():
        try:
            got = registry.render_command(name, params)
        except Exception as exc:
            check(False, "%s renders" % name, repr(exc))
            continue
        check(got == expected,
              "%-16s -> %r" % (name, expected),
              "got %r" % got)
        check(got.encode("ascii") == expected.encode("ascii"),
              "%-16s is pure ASCII, byte-for-byte" % name)

    # Whitespace-normalised numbers: the gateway echoes "READ RFID 1 20" for
    # input "read   rfid  1  020", and so must we, so the echo matches.
    check(registry.render_command("read_rfid_once", {"m": " 020 "})
          == "READ RFID 1 20",
          "string params normalise to canonical decimal form")
    check(registry.render_command("read_rfid_once", {"m": 0})
          == "READ RFID 1 0",
          "range endpoint 0 is accepted")
    check(registry.render_command("read_rfid_once", {"m": 255})
          == "READ RFID 1 255",
          "range endpoint 255 is accepted")


def test_command_validation():
    section("5. Validation - rejected before any serial write")

    def rejects(description, fn):
        try:
            result = fn()
        except registry.CommandError as exc:
            check(True, "%s -- rejected: %s" % (description, exc))
            return
        except Exception as exc:
            check(False, "%s -- wrong exception type" % description, repr(exc))
            return
        check(False, "%s -- NOT rejected" % description, "returned %r" % result)

    rejects("m=999 out of range",
            lambda: registry.render_command("read_rfid_once", {"m": 999}))
    rejects("m=256 just over the byte ceiling",
            lambda: registry.render_command("read_rfid_once", {"m": 256}))
    rejects("m=-1 below range",
            lambda: registry.render_command("read_rfid_once", {"m": -1}))
    rejects("m missing entirely",
            lambda: registry.render_command("read_rfid_once", {}))
    rejects("non-numeric m",
            lambda: registry.render_command("read_rfid_once", {"m": "banana"}))
    rejects("unexpected extra parameter",
            lambda: registry.render_command("read_rfid_once", {"m": 20, "z": 1}))
    # n used to be a real parameter (up through 2026-08-09); it is now
    # hardcoded to 1 in the send template, so supplying it must be rejected
    # the same as any other unrecognised key - proves the old n knob is
    # actually gone, not just hidden from the UI.
    rejects("n is no longer a parameter - supplying it is rejected",
            lambda: registry.render_command("read_rfid_once", {"n": 1, "m": 20}))
    rejects("unknown command name",
            lambda: registry.render_command("self_destruct", {}))
    rejects("params on a no-argument command",
            lambda: registry.render_command("sleep", {"n": 1}))
    rejects("empty raw text",
            lambda: registry.render_command(registry.RAW_COMMAND_NAME,
                                            text="   "))
    rejects("raw text with an embedded newline",
            lambda: registry.render_command(registry.RAW_COMMAND_NAME,
                                            text="SLEEP\nWAKE"))
    rejects("raw text over the gateway's 47-char line limit",
            lambda: registry.render_command(registry.RAW_COMMAND_NAME,
                                            text="X" * 48))

    # The escape hatch sends what was typed, untouched.
    check(registry.render_command(registry.RAW_COMMAND_NAME,
                                  text="read   rfid  banana")
          == "read   rfid  banana",
          "raw command is verbatim - no uppercasing, no space collapsing")
    check(registry.render_command(registry.RAW_COMMAND_NAME, text="WAKE\n")
          == "WAKE",
          "a trailing newline in raw text is the Enter key, and is stripped")


def test_http_layer_no_write_on_reject():
    section("6. HTTP layer - a rejected command writes zero bytes")

    import app as panel_app

    writes = []
    original = panel_app.link.send_line
    panel_app.link.send_line = lambda text: (writes.append(text), text)[1]

    client = panel_app.app.test_client()
    try:
        response = client.post("/api/command",
                               json={"name": "read_rfid_once",
                                     "params": {"m": 999}})
        body = response.get_json()
        check(response.status_code == 400, "out-of-range POST returns HTTP 400",
              "got %d" % response.status_code)
        check(body.get("ok") is False and "between 0 and 255" in body.get("error", ""),
              "error names the parameter and its range", repr(body))
        check(writes == [], "NO serial write attempted", repr(writes))

        response = client.post("/api/command", json={"name": "nope"})
        check(response.status_code == 400 and not writes,
              "unknown command rejected, still no write", repr(writes))

        response = client.post("/api/command", json={})
        check(response.status_code == 400 and not writes,
              "missing name rejected, still no write", repr(writes))

        response = client.post("/api/command",
                               json={"name": "read_rfid_once",
                                     "params": {"m": 20}})
        body = response.get_json()
        check(response.status_code == 200 and body.get("sent") == "READ RFID 1 20",
              "valid command reaches the write path with exact text", repr(body))
        check(writes == ["READ RFID 1 20"], "exactly one write, exact text",
              repr(writes))

        writes.clear()
        response = client.post("/api/command",
                               json={"name": registry.RAW_COMMAND_NAME,
                                     "text": "SOME FUTURE CMD 7"})
        check(writes == ["SOME FUTURE CMD 7"],
              "raw escape hatch writes arbitrary text verbatim", repr(writes))

        # And the real send_line refuses cleanly when nothing is connected -
        # a 409, not a stack trace.
        panel_app.link.send_line = original
        response = client.post("/api/command", json={"name": "sleep"})
        body = response.get_json()
        check(response.status_code == 409 and "not connected" in body.get("error", ""),
              "command with no port open returns a clean 409", repr(body))
    finally:
        panel_app.link.send_line = original


# ---------------------------------------------------------------------------
#  7. Telemetry parser
# ---------------------------------------------------------------------------


def test_parser():
    section("7. Telemetry parser - fields and sentinels")

    check(parser.TELEMETRY_FIELDS == [
        "timestamp", "collar_id", "ax", "ay", "az", "gx", "gy", "gz",
        "temperature", "rfid_id", "ble_connected", "age_ms"],
        "field list matches HANDOFF.md section 1 order exactly",
        repr(parser.TELEMETRY_FIELDS))

    # Derive the field list straight from the documented header line and
    # compare - this is the check that catches a rename or a reorder.
    header_fields = HEADER.lstrip("#").strip().split("\t")
    check(header_fields == parser.TELEMETRY_FIELDS,
          "parser field list == the gateway's own printed header line",
          "%r vs %r" % (header_fields, parser.TELEMETRY_FIELDS))

    record = parser.parse_telemetry(RECORD_1)
    check(record["timestamp"] == 123457 and record["collar_id"] == "C001",
          "timestamp and collar_id")
    check(record["rfid_id"] == "985141001320293"
          and isinstance(record["rfid_id"], str),
          "rfid_id stays a string - leading zeros would be lost as an int")

    blank = parser.parse_telemetry(RECORD_2)
    check(blank["temperature"] is None and blank["rfid_id"] is None,
          "'-' temperature and tag id are None")
    check(blank["ax"] is None and blank["ax"] != 0,
          "'-' accel is None, never 0")

    never = RECORD_2[:-1] + "-1"
    check(parser.parse_telemetry(never)["age_ms"] is None,
          "age_ms == -1 becomes None, not a negative age")
    zero_age = parser.parse_telemetry(RECORD_2)
    check(zero_age["age_ms"] == 0,
          "age_ms == 0 stays 0 - it is a real value on a fresh line")

    check(parser.classify(HEADER)["type"] == "log", "header classified as log")
    check(parser.classify(ACK)["type"] == "log", "ack classified as log")
    check(parser.classify(RECORD_1)["type"] == "telemetry",
          "record classified as telemetry")

    garbage = parser.classify("not\ta\trecord")
    check(garbage["type"] == "log" and "parse_error" in garbage,
          "malformed non-'#' line surfaces as a log entry with its error",
          repr(garbage))


# ---------------------------------------------------------------------------
#  8. Subscriber drop policy
# ---------------------------------------------------------------------------


def test_subscriber_drop_policy():
    section("8. Subscriber - bounded queue, drop-oldest")

    sub = Subscriber(maxsize=3)
    for index in range(5):
        sub.put({"type": "log", "text": "line-%d" % index})

    texts = [e["text"] for e in drain(sub)]
    check(len(texts) == 3, "queue never grows past its bound", repr(texts))
    check(texts == ["line-2", "line-3", "line-4"],
          "the OLDEST entries were dropped, the newest retained", repr(texts))

    notice = sub.take_drop_notice()
    check(notice is not None and "2 line(s) dropped" in notice["text"],
          "a drop is reported to the tab, never silent", repr(notice))
    check(sub.take_drop_notice() is None,
          "the notice is consumed once, not repeated on every poll")


# ---------------------------------------------------------------------------
#  9. Real HTTP against a real running server, with no serial port
# ---------------------------------------------------------------------------

LIVE_BASE = None


def test_live_server():
    section("9. Live Flask server - boots with no port connected")

    global LIVE_BASE
    import app as panel_app

    port = 5099
    server = threading.Thread(
        target=lambda: panel_app.app.run(host="127.0.0.1", port=port,
                                         threaded=True, debug=False,
                                         use_reloader=False),
        daemon=True,
    )
    server.start()

    base = "http://127.0.0.1:%d" % port
    ready = False
    for _ in range(50):
        try:
            urllib.request.urlopen(base + "/api/status", timeout=1).read()
            ready = True
            break
        except Exception:
            time.sleep(0.1)

    check(ready, "server accepted a request within 5s")
    if not ready:
        return
    LIVE_BASE = base

    with urllib.request.urlopen(base + "/", timeout=3) as response:
        html = response.read().decode("utf-8")
        check(response.status == 200, "GET / -> 200")
    check("Collar Control Panel" in html, "page rendered from the template")
    for name in EXPECTED:
        if name in html:
            check(False, "HTML must not hardcode command '%s'" % name)
            break
    else:
        check(True, "no command name is hardcoded in the served HTML")

    with urllib.request.urlopen(base + "/api/commands", timeout=3) as response:
        body = json.loads(response.read().decode("utf-8"))
    check(response.status == 200 and body["ok"], "GET /api/commands -> 200 ok")
    check(len(body["commands"]) == 5, "five commands served to the browser",
          "got %d" % len(body["commands"]))
    check(body["raw_command"]["name"] == registry.RAW_COMMAND_NAME,
          "raw escape hatch advertised to the browser")
    with_params = [c for c in body["commands"] if c["params"]]
    check(len(with_params) == 1 and with_params[0]["name"] == "read_rfid_once",
          "exactly one command advertises parameters", repr(with_params))
    if with_params:
        specs = {p["name"]: p for p in with_params[0]["params"]}
        check(set(specs) == {"m"}, "its only parameter is m - n is hardcoded now")
        check(all(p["min"] == 0 and p["max"] == 255 for p in specs.values()),
              "m advertises the 0-255 byte range")

    with urllib.request.urlopen(base + "/api/status", timeout=3) as response:
        status = json.loads(response.read().decode("utf-8"))["status"]
    check(status["connected"] is False and status["baud"] == 115200,
          "status reports disconnected at 115200 with no port open",
          repr(status))

    with urllib.request.urlopen(base + "/api/ports", timeout=5) as response:
        ports_body = json.loads(response.read().decode("utf-8"))
    check(ports_body["ok"] and isinstance(ports_body["ports"], list),
          "GET /api/ports enumerates without a port present",
          repr(ports_body))

    # Connecting to a port that does not exist must be a clean JSON error.
    request = urllib.request.Request(
        base + "/api/connect",
        data=json.dumps({"port": "COM_DOES_NOT_EXIST"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=5)
        check(False, "bogus port should not connect")
    except urllib.error.HTTPError as exc:
        body = json.loads(exc.read().decode("utf-8"))
        check(exc.code == 409 and body["ok"] is False and body["error"],
              "bogus port -> clean 409 JSON error, no stack trace",
              repr(body))


# ---------------------------------------------------------------------------
#  10. The SSE stream actually carries events
# ---------------------------------------------------------------------------


def _read_sse_event(stream, timeout=5.0):
    """Read one `data: {...}\\n\\n` frame off an open event-stream."""
    deadline = time.time() + timeout
    payload = None
    while time.time() < deadline:
        raw = stream.readline()
        if not raw:
            return None
        text = raw.decode("utf-8").rstrip("\r\n")
        if text.startswith("data:"):
            payload = text[5:].strip()
        elif text == "" and payload is not None:
            return json.loads(payload)
    return None


def test_sse_stream():
    section("10. SSE stream - events reach the browser")

    if LIVE_BASE is None:
        check(False, "live server was not available for the stream test")
        return

    import app as panel_app
    from telemetry_parser import classify as classify_line

    stream = urllib.request.urlopen(LIVE_BASE + "/api/stream", timeout=10)
    try:
        check(stream.headers.get("Content-Type", "").startswith("text/event-stream"),
              "endpoint declares text/event-stream",
              repr(stream.headers.get("Content-Type")))

        first = _read_sse_event(stream)
        check(first is not None and first.get("type") == "status",
              "a newly-opened tab is told the current connection state first",
              repr(first))

        # Push a synthetic record and an ack through the same broadcast path
        # the reader thread uses, and confirm both come out of the socket
        # correctly classified.
        threading.Timer(0.2, lambda: panel_app.link.broadcast(
            classify_line(RECORD_1))).start()
        event = _read_sse_event(stream)
        check(event is not None and event.get("type") == "telemetry",
              "a record arrives tagged type=telemetry", repr(event))
        if event and event.get("data"):
            check(event["data"]["rfid_id"] == "985141001320293",
                  "its parsed fields survive the JSON round trip")

        threading.Timer(0.2, lambda: panel_app.link.broadcast(
            classify_line(ACK))).start()
        event = _read_sse_event(stream)
        check(event is not None and event.get("type") == "log"
              and event.get("text") == ACK,
              "an ack arrives tagged type=log, text intact", repr(event))
    finally:
        stream.close()


# ---------------------------------------------------------------------------
#  11. The modularity claim, tested rather than asserted
# ---------------------------------------------------------------------------


def test_registry_extensibility():
    section("11. Adding a 6th command = one entry, no other edits")

    import app as panel_app

    eighth = registry.Command(
        name="test_only_probe",
        label="PROBE <k>",
        send="PROBE {k}",
        group="diagnostics",
        description="Temporary entry, added by the test harness only.",
        params=[registry.ParamSpec(name="k", label="k", minimum=0, maximum=255,
                                   default=7)],
    )

    # Exactly the change a future maintainer would make: append to the list.
    registry.COMMANDS.append(eighth)
    registry._BY_NAME[eighth.name] = eighth
    try:
        client = panel_app.app.test_client()
        body = client.get("/api/commands").get_json()
        names = [c["name"] for c in body["commands"]]

        check(len(body["commands"]) == 6,
              "the API now advertises 6 commands with no route change",
              repr(names))
        added = [c for c in body["commands"] if c["name"] == "test_only_probe"]
        check(len(added) == 1, "the new entry is served to the browser")
        if added:
            check(added[0]["label"] == "PROBE <k>"
                  and added[0]["params"][0]["name"] == "k"
                  and added[0]["params"][0]["max"] == 255,
                  "its label and parameter spec reach the UI intact",
                  repr(added[0]))

        writes = []
        original = panel_app.link.send_line
        panel_app.link.send_line = lambda text: (writes.append(text), text)[1]
        try:
            client.post("/api/command",
                        json={"name": "test_only_probe", "params": {"k": 9}})
            check(writes == ["PROBE 9"],
                  "the generic /api/command endpoint sends it with no new route",
                  repr(writes))
            writes.clear()
            response = client.post("/api/command",
                                   json={"name": "test_only_probe",
                                         "params": {"k": 300}})
            check(response.status_code == 400 and writes == [],
                  "and validates it from its own spec, with no new code",
                  repr(writes))
        finally:
            panel_app.link.send_line = original
    finally:
        registry.COMMANDS.remove(eighth)
        del registry._BY_NAME[eighth.name]

    check(len(registry.COMMANDS) == 5, "harness restored the registry to five")


# ---------------------------------------------------------------------------


def main():
    print("PC Control Panel - test harness")
    print("no real serial port is opened by any test below")

    test_line_assembler()
    test_reader_thread_stream()
    test_reader_thread_shutdown()
    test_command_registry()
    test_command_validation()
    test_http_layer_no_write_on_reject()
    test_parser()
    test_subscriber_drop_policy()
    test_live_server()
    test_sse_stream()
    test_registry_extensibility()

    print("\n" + "=" * 46)
    print("passed: %d    failed: %d" % (PASS, FAIL))
    print("=" * 46)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
