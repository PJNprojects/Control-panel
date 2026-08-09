# Changelog — PC Control Panel

Newest first. Versions here are this component's own; they track nothing in
`ESP Gateway` or `NRF Fuse_Board`, which each keep their own independent
git repository and their own tag series.

---

## V1.0.0 — 2026-08-10

First version. A Flask + pyserial control panel for the ESP32 gateway's USB
serial link, served to a browser on `127.0.0.1:5000`.

### Added

- **Command registry** (`backend/commands.py`) — all seven of the gateway's
  ASCII commands as data, in one list: `SLEEP`, `WAKE`, `READ RFID <n> <m>`,
  `READ RFID LOOP`, `STOP RFID LOOP`, `IMU RUN`, `IMU HALT`. Each entry carries
  its machine name, display label, exact wire text (a `str.format` template)
  and, where applicable, integer parameter specs with min/max.
- **`GET /api/commands`** serves the registry; the frontend builds its controls
  from it at page load. `templates/index.html` contains no command names at
  all — adding an eighth command is one entry in the Python list and nothing
  else. Proven by a test, not just claimed.
- **`POST /api/command`** — a single generic send path for every command,
  registry entry or raw text alike. Looks the name up, validates parameters
  against the registry's own spec, renders the ASCII, writes it with a
  trailing `\n`.
- **Raw-command escape hatch** — reserved name `__raw__` on the same endpoint,
  sending arbitrary typed text verbatim, so an unregistered command can be
  tried without a code change. Enforces only the two transport rules: single
  line, and the gateway's 47-character limit.
- **`backend/serial_link.py`** — port enumeration, connect/disconnect, and a
  background reader thread doing bounded (0.1 s) reads so it can be shut down
  cleanly, with a `LineAssembler` that reassembles records split across reads.
  Per-tab bounded queues (2000 events, drop-oldest) fan the stream out; drops
  are counted and reported rather than silent. An unplugged cable is caught,
  reported, and does not take the Flask process down.
- **`backend/telemetry_parser.py`** — the 12-field tab-separated record, in the
  order the gateway prints it. `-` and `age_ms == -1` become `None`, never `0`.
  `#` lines are classified as logs; a non-`#` line that fails to parse is
  surfaced as a log carrying its parse error rather than dropped.
- **`GET /api/stream`** — Server-Sent Events, one JSON object per line, tagged
  `telemetry` / `log` / `status` / `ping`, so the UI can route records to the
  reading card and diagnostics to the log panel.
- **UI** — port dropdown with Connect/Disconnect and a status indicator; a
  generated command panel; a "latest reading" card showing all 12 fields with
  raw counts and converted units side by side; a scrolling log panel capped at
  1000 rows with follow/clear.
- **`Launch_ControlPanel.bat`** — creates `venv\` if missing, installs
  dependencies only when the imports are actually absent, starts the server and
  opens a browser. Written with no raw parentheses inside `if` blocks, which is
  the bug that broke the first version of `ESP Gateway\launch.bat`.
- **`tests/test_harness.py`** — 105 checks, no hardware, no pytest. Drives the
  reader thread with a synthetic gateway (boot header, records, an injected
  ack, a record split across three reads, a simulated cable-pull), verifies
  every command's wire text byte-for-byte against `ESP Gateway/HANDOFF.md`
  section 2, proves invalid input reaches no serial write, and boots a real
  Flask server to make real HTTP and SSE requests against.

### Decisions worth recording

- **SSE, not WebSockets.** The live direction is one-way; commands are ordinary
  POSTs. SSE is plain HTTP, needs no dependency beyond Flask, and reconnects on
  its own. Flask-SocketIO would have bought a return path nothing uses.
- **Vanilla JS, no build step.** The whole tool stays `pip install` plus a
  double-click. No npm, no bundler, no framework.
- **Latest-reading card, not a scrolling table.** At ~570 ms per record an
  all-day table is tens of thousands of DOM rows nobody scrolls back through,
  and every question this tool answers is about *now*. History, if it is ever
  needed, should be a file on disk, not a browser buffer.
- **Drop-oldest on a bounded per-tab queue.** Blocking the reader would push
  back-pressure all the way to the OS driver buffer and lose bytes invisibly at
  the hardware level; dropping the newest would keep stale data in a live
  monitor. Drop-oldest keeps the tab showing the most recent truth, and every
  drop is reported.
- **Reject, never clamp.** The gateway rejects out-of-range parameters, so this
  does too. Silently turning 999 into 255 would misreport what the collar was
  told to do.
- **Server re-validates everything.** Client-side `min`/`max` mirrors the
  registry as a convenience only. The browser is never the authority on what is
  safe to send to hardware.

### Not done, deliberately

- No `HANDOFF.md`. This component's handoff is written separately by someone
  who has verified the tool against real hardware; a handoff written by the
  author of the code, before either end has met a collar, would be a guess.
- **Never run against a real gateway.** Every test here uses a fake port. The
  wire format is consumed exactly as `ESP Gateway/HANDOFF.md` specifies it, but
  that document itself notes the command channel is unproven end to end — the
  collar's half has never been compiled or flashed. Treat the first real
  connection as a bring-up, not a regression test.
- No logging to disk, no session replay, no multi-collar support, no
  authentication.
