# PC Control Panel

A browser front-end for the ESP32 gateway's USB serial link: it shows the
collar's telemetry as it arrives and sends the gateway's seven ASCII commands
back down the same wire.

This is a **bench tool**, not a product. It binds to `127.0.0.1`, has no
authentication, and assumes exactly one operator on one machine with one
gateway plugged in. Everything below is written for the next engineer who has
to change it.

---

## 1. Where this sits

```
  collar (nRF52)                gateway (ESP32)                    this tool
 ┌──────────────┐  BLE notify  ┌───────────────┐  USB serial   ┌──────────────┐
 │  CattleNode  │─────────────>│ aa100001 sub  │──────────────>│  reader      │
 │              │              │  -> 13-field  │   115200 8N1  │  thread      │
 │              │<─────────────│     record    │<──────────────│  writer      │
 └──────────────┘  aa100002    └───────────────┘  ASCII lines  └──────┬───────┘
                   write-only                                         │
                                                          Flask ──────┤
                                                        SSE  │        │ HTTP
                                                             v        v
                                                        ┌──────────────────┐
                                                        │  browser tab     │
                                                        │  log + telemetry │
                                                        └──────────────────┘
```

This tool owns **only** the rightmost box. The wire format it consumes is
defined by `ESP Gateway/HANDOFF.md` — sections 1 (telemetry) and 2 (commands).
That document is the contract. If this tool and that document ever disagree,
that document wins and this code is wrong.

Two properties of the link are worth internalising before changing anything:

- **The stream is event-driven, not polled.** The gateway prints one line per
  BLE notify and nothing in between — currently ~570-600 ms apart, paced by the
  collar's RFID loop. Long silences are normal; `SLEEP` produces total silence
  by design. Nothing here should ever interpret "quiet" as "broken".
- **`-> sent` is not `-> done`.** The gateway acknowledges that bytes left the
  ESP32, not that the collar obeyed. There is no reply channel. You read the
  effect off the telemetry: IMU columns switching from `-` to numbers, an
  `rfid_id` appearing, the stream stopping on `SLEEP`.

---

## 2. Running it

### One click

Windows: double-click `Launch_ControlPanel.bat`. macOS: double-click
`Launch_ControlPanel.command` (first time only, it may need
`chmod +x Launch_ControlPanel.command` and a Gatekeeper "Open anyway"
confirmation — see the comment block at the top of that file). Either one
creates `venv` if missing, installs `requirements.txt` into it only when the
imports are actually absent, starts the server, and opens your browser. Both
scripts do the identical four steps; `backend/app.py` and `requirements.txt`
are plain cross-platform Python, nothing OS-specific in either.

### One click, zero Python required (macOS)

`Launch_ControlPanel_Portable.command` skips the "is Python installed"
question entirely. First run detects the Mac's CPU (Apple Silicon vs Intel)
via `uname -m`, downloads the matching prebuilt CPython 3.12 from
[astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone)
— a relocatable, self-contained interpreter, the macOS analogue of Windows'
"embeddable" zip, since Apple doesn't publish an official equivalent — into
`./python-portable/`, and installs Flask + pyserial into that copy. Every run
after the first is fully offline; nothing is installed system-wide and no
admin password is needed. `python-portable/` is gitignored (60-80MB of binary
distribution) — each machine builds its own, or you copy a already-built one
over by USB to a Mac with no internet at all, matching CPU family.

A Windows equivalent of this (a bundled embeddable Python folder, so no
system Python needed there either) does not exist yet — it's a reasonable
follow-up if a Python-less Windows PC ever comes up, using the official
embeddable zip from python.org the same way this one uses
python-build-standalone.

### By hand

```bat
cd "PC Control Panel"
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python backend\app.py
```

Then open <http://127.0.0.1:5000/>.

Environment variables, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `PANEL_HOST` | `127.0.0.1` | Bind address. Changing this exposes an unauthenticated tool that can drive hardware — don't, unless you mean it. |
| `PANEL_PORT` | `5000` | HTTP port. |
| `PANEL_OPEN_BROWSER` | `1` | Set `0` to stop it launching a browser (used by the test harness). |

### Using it

1. Start the panel. **The gateway does not need to be plugged in yet** — the
   page loads fine with no port.
2. Plug the gateway in, press **Refresh**, pick the COM port, press
   **Connect**.
3. You should see the gateway's boot lines in the log within a second or two,
   including `# cmd: commands = SLEEP | WAKE | ...` and the column header.
4. On bring-up, the **first thing to check** is which connection line appears:
   `# cmd: command channel ready on aa100002-...` means commands will work;
   `# cmd: characteristic aa100002-... NOT found` means the collar is running
   firmware from before the command channel existed. Telemetry still works in
   that state; commands will not.

`Ctrl+C` in the console stops the server and closes the port. It does **not**
send `SLEEP` — the collar carries on doing whatever it was told to do.

### Tests

```bat
python tests\test_harness.py
```

No hardware, no pytest, no COM port. It drives the reader thread with a fake
port (including a simulated cable-pull), checks every rendered command string
byte-for-byte against the handoff's table, and boots a real Flask server on
port 5099 to make real HTTP requests against. Exit code is non-zero on failure.

---

## 3. Architecture

```
backend/
  commands.py          the registry. The only place a command is defined.
  telemetry_parser.py  one line of text -> a typed event dict. Pure, no I/O.
  serial_link.py       the port, the reader thread, the subscriber fan-out.
  app.py               Flask routes. Thin - it validates shape and delegates.
templates/index.html   a shell. Contains no command names.
static/app.js          builds the UI from /api/commands; one EventSource.
static/style.css
tests/test_harness.py  standalone, hardware-free.
```

The dependency direction is one-way and deliberate:

```
    app.py  ──>  commands.py          (pure, no I/O, trivially testable)
       │
       └──────>  serial_link.py  ──>  telemetry_parser.py   (pure)
```

`commands.py` and `telemetry_parser.py` import nothing from the app and touch
no hardware, which is why the bulk of the test harness needs neither.

### Routes

| Route | Purpose |
|---|---|
| `GET /` | The page. |
| `GET /api/commands` | The registry as JSON. Drives the UI. |
| `POST /api/command` | `{name, params}` — the one and only send path. |
| `GET /api/ports` | Serial ports the OS can see. |
| `POST /api/connect` | `{port}` — open it, start the reader. |
| `POST /api/disconnect` | Stop the reader, close the port. |
| `GET /api/status` | Connection state, for page reloads. |
| `GET /api/stream` | `text/event-stream` — the live feed. |

### Why SSE and not WebSockets

The live direction is one-way: lines flow to the browser, and commands go back
as ordinary POSTs. Server-Sent Events is exactly that shape — plain HTTP, no
handshake, no dependency beyond Flask, and the browser reconnects on its own.
Flask-SocketIO would add a dependency, an async worker model and a protocol to
buy a return path nothing uses. Revisit only if something genuinely needs
bidirectional streaming.

### Stream event types

Every SSE frame is one JSON object with a `type`:

| `type` | When | Frontend destination |
|---|---|---|
| `telemetry` | a 13-field record parsed cleanly | the latest-reading card |
| `log` | any `#` line — boot header, `# cmd:` acks, `# panel:` notices | the log panel |
| `status` | connect / disconnect / read failure | the header indicator |
| `ping` | idle keepalive every 15 s | ignored |

A non-`#` line that fails to parse is emitted as a `log` with a `parse_error`
field, never dropped and never faked into a partial record — line noise and a
genuine format change look identical to a parser, and both need to be seen.

### Reader thread and back-pressure

The reader does **bounded** reads (0.1 s timeout) and re-checks a stop flag
between them. It never calls `readline()` with an infinite timeout: the collar
going quiet is a normal state, and a thread parked in a blocking syscall could
not be shut down. This is the same non-blocking accumulator discipline the
gateway's own firmware uses on its command input.

Bytes do not arrive as lines, so `LineAssembler` accumulates and splits on
`\n`. A line longer than 512 characters is discarded with a visible
`# panel:` notice and the assembler resyncs at the next newline.

Each browser tab gets its own bounded queue (2000 events) with a
**drop-oldest** policy. The alternatives were rejected deliberately:

- *Block the reader* — a paused tab would stall the serial thread and back the
  OS driver buffer up until bytes were lost at the hardware level. The worst
  option, because the loss then happens invisibly and off-machine.
- *Drop newest* — keeps stale data and discards the fresh reading, which is
  backwards for a live monitor.

Drops are counted and surfaced as a `# panel: N line(s) dropped` entry, so a
gap is always visible. **This tool keeps no history** — if you need a
transcript, that is a capture-to-file feature, not a bigger queue.

Unplugging the gateway mid-session raises inside the read; that is caught, the
link is marked down, the UI is told, and the thread exits. The Flask process
survives.

### The telemetry panel is a "latest reading" card, not a scrolling table

Judgement call, and it can be revisited. The reasoning: at one record every
~570 ms an all-day table is tens of thousands of DOM rows for data nobody
scrolls back through, and the questions this tool exists to answer are all
about *now* — did the IMU columns come alive after `IMU RUN`, did a tag ID
appear, is `age_ms` climbing. Raw counts and converted units are shown side by
side in each cell, so the card can be read against a raw serial dump directly.
If historical inspection is ever needed, the honest answer is logging to a
file plus a plotter, not a table in a browser.

---

## 4. Adding a new command

**One edit. Add an entry to `COMMANDS` in `backend/commands.py`.** No new
route, no HTML, no JavaScript. `test_registry_extensibility` in the harness
proves this by adding an eighth command at runtime and asserting it appears in
the API and sends correctly.

```python
Command(
    name="calibrate_imu",           # machine name, used in the POST body
    label="CALIBRATE IMU",          # what the button says
    send="CALIBRATE IMU",           # the EXACT ASCII the gateway parses
    group="imu",                    # groups the buttons in the UI
    description="Runs the collar's IMU zero-offset routine.",
)
```

With parameters, use `{placeholder}` slots in `send` and one `ParamSpec` per
slot:

```python
Command(
    name="set_interval",
    label="SET INTERVAL <ms>",
    send="SET INTERVAL {ms}",
    group="general",
    params=[ParamSpec(name="ms", label="ms", minimum=10, maximum=60000,
                      default=1000)],
),
```

Rules the registry enforces for you, so you don't have to:

- Every declared parameter must be supplied; unknown extras are rejected, not
  ignored (silently dropping a mistyped key would send a default value under a
  valid-looking command — a far worse failure than an error message).
- Values are range-checked and **rejected, not clamped**, matching the
  gateway, which also rejects. A panel that quietly turned 999 into 255 would
  be lying about what the collar was told to do.
- Validation happens before the port is touched, so an invalid request is
  guaranteed to put zero bytes on the wire.
- The browser's `min`/`max` attributes mirror the registry but are convenience
  only. The server re-validates everything — anything can POST to
  `/api/command`.

Then: reload the page. The button is there.

### The raw-command escape hatch

The registry is authoritative for the buttons, but firmware moves faster than
this tool. The raw text box posts to the same `/api/command` endpoint under the
reserved name `__raw__`:

```json
{ "name": "__raw__", "text": "SOME NEW COMMAND 7" }
```

The text is sent **verbatim** plus `\n` — no uppercasing, no whitespace
collapsing. The gateway tolerates both, and the point of the box is to
reproduce exactly what an operator would type into a dumb terminal, including
the malformed input they are deliberately testing the parser with.

Two transport rules still apply: no embedded newline (the link is one command
per line; a pasted newline would send two commands while the UI reported one),
and 47 characters max, mirroring the firmware's `CMD_LINE_MAX` of 48 which
counts the NUL. Longer lines are discarded by the gateway with
`# cmd: line too long, discarded`, so it is refused here with a message that
says so.

---

## 5. Constants shared with the firmware

These are duplicated from the gateway's source, not imported — there is no way
to import a C `#define` into Python. Each is verified against its origin, and
any change over there needs a change here.

| Here | Value | Origin |
|---|---|---|
| `serial_link.DEFAULT_BAUD` | 115200 | `#define SERIAL_BAUD 115200`, `ESP Gateway/include/config.h:42` |
| `commands.GATEWAY_MAX_LINE_CHARS` | 47 | `#define CMD_LINE_MAX 48` (counts NUL), `ESP Gateway/src/main.cpp:1159` |
| `telemetry_parser.TELEMETRY_FIELDS` | 13 names | `REC_HEADER`, `ESP Gateway/src/main.cpp` §printTelemetry |
| `telemetry_parser.NONE_SENTINEL` | `-` | `REC_NONE`, same file |

The harness re-derives the field list from the documented header line and
compares, so a rename or reorder on the gateway side fails a test here rather
than silently mis-labelling a column.

### The 12 → 13 field change (gateway V1.3.5)

`rfid_valid` was added at **position 11**, between `rfid_id` and
`ble_connected` — see `ESP Gateway/PROTOCOL_V10.md` §2. Nothing was renamed or
reordered around it; the record simply got one column wider in the middle.

```
timestamp  collar_id  ax ay az  gx gy gz  temperature  rfid_id  rfid_valid  ble_connected  age_ms
                                                                ^^^^^^^^^^ new
```

`rfid_valid` is `0` or `1` and **never `-`**: it is a flag, not a value that
can be "not fresh", so a record with no confirmed read prints `0` rather than
the sentinel. It is stored as a 0/1 int, the same convention as
`ble_connected`, and the parser rejects anything else in that column.

Two things worth knowing about it:

- **It is redundant with `rfid_id`/`temperature` being `-`, on purpose.**
  §2.3 of the protocol says a parser may use either signal; the flag exists so
  it doesn't have to string-compare against `-`. The frontend prefers the flag.
- **The redundancy is new.** Pre-V1.3.5 firmware wrote `rfid_id`/`temperature`
  on a confirmed read and never reset them, so one tag seen once kept
  reprinting for the rest of the session. That was a real firmware-side cause
  of the "sticky RFID" behaviour chased from this side more than once. V1.3.5
  derives RFID freshness per-record from the current packet's flag bit, the
  same way IMU freshness always worked, so the two signals now agree by
  construction.

Because the new column landed exactly where `ble_connected` used to be, an old
parser pointed at new firmware reads *shifted*, not *broken*. The width check
in `parse_telemetry()` is therefore a hard `!=`, not a `>=`, and the harness
asserts that a 12-field line is refused outright.

---

## 6. Known limits

- **One port at a time.** One gateway, one collar, and Windows will not share a
  COM port anyway. Multi-port would be a map of `SerialLink` objects, not a
  change to the class.
- **Single process.** The `link` object is module-level. Under a multi-worker
  WSGI server the workers would fight over the COM port. Do not run this under
  gunicorn; it is a bench tool and the Flask dev server is the right size for
  it.
- **No server-side persistence.** Still true of the log panel and the telemetry
  card - the panel forgets those on restart. It is NOT true of Scan History /
  IMU Log (added since this note was first written): both keep a bounded
  in-memory table with a CSV download, but that memory is the BROWSER TAB's,
  not this process's or disk - closing the tab or reloading the page loses
  whatever hasn't been downloaded yet. If that tradeoff stops being
  acceptable (e.g. unattended multi-hour runs), the fix is a real backend
  store, not a bigger in-tab array.
- **No wall-clock time on the wire.** `timestamp` is milliseconds since the
  *gateway* booted, because that is what the gateway sends. Log timestamps
  and Scan History / IMU Log timestamps in the UI are the PC's own receive
  time and are not the same clock.
- **`READ RFID <m>` has no completion signal from the gateway.** Deliberate,
  and not fixable here: the gateway never learns whether a one-shot scan
  succeeded. (`n`, which used to be a second parameter, is hardcoded to 1 as
  of 2026-08-10 - see the comment on `read_rfid_once` in `commands.py`.) The
  panel now runs a client-side timeout, sized from `m` and the gateway's own
  ~70ms-per-attempt figure, to make its best guess and log a "no tag" result
  in Scan History - that is a UI-side heuristic, not a hardware ack, and it
  is only as good as that ~70ms estimate. A real completion signal would
  still have to be added to the *node's* wire contract first.
