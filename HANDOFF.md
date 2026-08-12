# PC Control Panel — Handoff

**Last updated: 2026-08-10, commit `963a5ae` / tag `V1.0.0`. Built, syntax-checked, and
tested against a synthetic serial harness — never connected to a real gateway yet.**

This is the operator's answer to "how do I actually connect to the gateway and send
commands to the collar." For the code architecture (why a registry, how to add a
command), see `README.md` in this folder instead — this doc is about using the tool,
not building it.

---

## 1. What this is, in one sentence

A browser page, backed by a small local Flask server on your PC, that opens the
gateway's USB serial port, shows you the live telemetry/ack stream, and lets you fire
the gateway's 7 ASCII commands (plus a raw text box) without opening a serial terminal
yourself.

```
Browser (this UI)  <-- SSE/HTTP -->  Flask on your PC  <-- USB serial, 115200 -->  ESP32 Gateway  <-- BLE -->  Collar
```

## 2. First run

1. Double-click `Launch_ControlPanel.bat` (Windows) or `Launch_ControlPanel.command`
   (macOS) inside this folder. First run creates a private `venv` and installs
   Flask + pyserial into it (needs internet once); later runs skip straight to
   starting the server. On macOS, if double-clicking does nothing the first time,
   see the note at the top of `Launch_ControlPanel.command` — it needs its
   executable bit set once (`chmod +x Launch_ControlPanel.command`) and Gatekeeper
   may ask you to confirm opening it.

   **No Python on the Mac at all, or need it to run on a fully offline Mac?**
   Use `Launch_ControlPanel_Portable.command` instead. First run downloads a
   self-contained CPython build (matched to that Mac's own CPU, Apple Silicon
   or Intel) into `./python-portable` and installs Flask/pyserial into it —
   no Homebrew, no system Python, nothing outside this folder. Every run after
   that is fully offline. To get it onto a Mac with no internet at all: run it
   once on any Mac of the same CPU family that does have internet, then copy
   the whole project folder (including the now-populated `python-portable`)
   over by USB/AirDrop.
2. It opens your browser at `http://127.0.0.1:5000/` automatically. If it doesn't,
   open that address yourself.
3. **You do not need the gateway plugged in yet to reach this point.** The page loads
   and shows all 7 command buttons before anything is connected — they just won't do
   anything useful until step 4.
4. Plug the ESP32 gateway into USB. In the page, press **Refresh** on the port
   dropdown, pick the right `COM` port (Windows Device Manager -> Ports (COM & LPT)
   will confirm which one if more than one shows up), then **Connect**.
5. You should immediately see the gateway's boot lines appear in the log panel
   (`# ...` lines), followed by the `#` header line, followed by telemetry rows once
   a collar is connected over BLE on the gateway's side.

Closing the browser tab does **not** stop anything on the gateway or collar — it's a
passive relay. Ctrl+C in the console window stops the local Flask server; the hardware
keeps doing whatever it was doing.

## 3. What you'll see

- **Top bar** — port dropdown, Connect/Disconnect, a status dot.
- **Commands + IMU Orientation** — one shared card. The command side has three
  columns (RFID, POWER, IMU); POWER and IMU render as toggle controls, not plain
  buttons — see section 4. Below the buttons, a free-text box for anything not
  (yet) a button. Below that, the IMU dial/bars/charts from section 4b.
- **RFID Scan History** — a table of resolved `READ RFID` attempts (manual button
  presses and the auto-scan timer), each row a timestamp plus FOUND or NO TAG.
  Has its own period/`m` controls (n is fixed at 1, see section 4) and a
  "Download CSV" button.
- **IMU Log** — same idea, periodic snapshots of yaw/pitch/roll/gravity/ax..gz
  instead of scan verdicts. Own period control, own CSV download.
- **Log panel** — every `#`-prefixed line from the gateway, scrolling: boot messages,
  the header line once, and a `# cmd: ... -> sent / FAILED (...) / unknown '...'` line
  for every command you send.
- **Latest reading card** — the most recent 12-field telemetry record, decoded (accel
  in m/s², gyro in rad/s, not raw wire integers), not a scrolling history table. This
  tool answers "what's happening right now," not "log everything to a file."

Scan History and IMU Log ARE the "log everything to a file" feature the original
version of this doc said didn't exist yet — with one caveat worth repeating: both
live in the browser tab's memory only. No new Flask route, nothing written to disk.
Closing the tab or reloading the page loses whatever hasn't been downloaded as CSV
yet, and the auto-scan/auto-log timers pause the way any browser tab timer does
when the tab is backgrounded for a long time. Download the CSV before you close the
tab if the run mattered.

## 4. The commands

Five of the gateway's seven ASCII commands have a control in this panel. Two —
`READ RFID LOOP` and `STOP RFID LOOP` — were deliberately unbuttoned: continuous
scanning didn't fit how this collar gets operated day to day, and the one-shot
`READ RFID <m>` plus the Scan History auto-scan timer cover the same need with
a result you can actually log. The gateway still accepts both; type them into the
raw command box if you ever need them.

**`n` is hardcoded to 1, not a control.** It used to be a second parameter
(default 5 — stop early once 5 CRC-valid reads land), but that meant the FIRST
fresh `rfid_id` after sending the command wasn't necessarily "the scan is done" —
the collar could still be mid-attempt toward n=5 when this panel's one-shot
timeout logic (see `commands.py`'s comment on `read_rfid_once`) had already
decided the read was resolved, which produced misleading Scan History rows. n=1
makes "one CRC-valid read landed" and "the command is done" the same event —
`READ RFID <m>` sends `READ RFID 1 {m}` on the wire, always.

**SLEEP / WAKE** is a slider switch, not two buttons. Right = WAKE (green), left =
SLEEP (grey). **IMU** and the **READ RFID <m>** button's neighbors follow a
press-and-stays-pressed pattern: press once to start, the button turns green and
says what's now running (`IMU RUNNING`); press again to stop, it greys out and
says what pressing it will do next (`Start IMU`).

**None of these switches are a confirmed hardware state.** The gateway has no reply
channel — `-> sent` is not `-> done` — so a switch shows the last thing YOU told the
collar, not a read-back of what it's actually doing. If a send is rejected the
switch snaps back on its own; if the collar silently ignores an accepted command for
some other reason, the switch will show the wrong thing and the only real ground
truth is still the telemetry (IMU columns leaving `-`, a tag ID appearing, etc).

| Control | What it does | Sent as | Collar-side effect |
|---|---|---|---|
| `SLEEP` / `WAKE` slider | Silences the link entirely (`SLEEP`) or resumes exactly what was running before (`WAKE`). Whatever RFID/IMU mode was active underneath `SLEEP` is preserved, not reset — you do not need to re-send `READ RFID LOOP` / `IMU RUN` after waking. | `SLEEP` / `WAKE` | `SLEEP` is an overlay, not a mode change. |
| `READ RFID <m>` | One-shot scan: stops as soon as ONE CRC-valid read lands (`n` is fixed at 1), or gives up after `m` attempts (~70ms each). Reverts to whatever mode was active before. Disabled automatically while the collar's BLE link is mid disconnect/rescan/reconnect (see below). | `READ RFID 1 {m}` | Result shows up in the very next telemetry row's RFID fields — there's no separate "done" signal, watch the log/card/Scan History. |
| `IMU` toggle (RUN / HALT) | Starts or stops populating accel/gyro fields (they read `-` until RUN is sent — HALT is the collar's default boot state). | `IMU RUN` / `IMU HALT` | Does NOT silence the link — packets keep flowing with `-` in the IMU columns under HALT. Only `SLEEP` stops the stream itself. |

The panel validates `n`/`m` (0-255) before sending anything — an out-of-range value
never reaches the serial port, you just get an error in the UI. Everything you type or
click is echoed back in the log panel as the exact ASCII sent, so what you see there is
literally what went out the USB cable.

**On a freshly booted collar, nothing scans and no IMU flows until you send a
READ RFID (or the raw `READ RFID LOOP`) and `IMU RUN`** — that's the collar's
current default, not a bug in this panel.

### 4a. What happens when you press READ RFID

The collar's BLE node disconnects, rescans for the implant, and reconnects — every
time. In the log panel that looks like:

```
# cmd: READ RFID 5 20 -> sent
# CattleNode disconnected - rescanning...
# Scanning for CattleNode (service aa100000-...)...
# Found service aa100000-... (name=CattleNode), connecting...
# Connected. Discovering service...
# Subscribed - waiting for CompactFusedPacket data...
# cmd: command channel ready on aa100002-...
```

The command channel (and therefore any command, not just another RFID read) is
gone for that couple-of-seconds window. This panel watches the log for exactly
those two lines — `disconnected` and `command channel ready` — and disables the
READ RFID button (and pauses the auto-scan timer for that cycle) in between, so
you can't stack a second read into a channel that isn't there yet. A fresh
telemetry record arriving is treated as an even more direct "we're back" signal.
There's a 20s watchdog that force-re-enables the button if the "ready" line is ever
missed or reworded on the gateway side, so a wording change over there can't wedge
the button disabled forever — but it also means that specific string is worth
keeping in sync between the two projects.

## 5. Reality check before you trust any of this

This panel has been tested against a **fake** serial port only — a synthetic byte
stream standing in for a real gateway, in a sandbox with no COM port available. It has
never been pointed at real hardware. Separately, the gateway's own `aa100002` command
channel and the collar's handler for it have also never been proven against each other
on real hardware as of this writing.

So the honest first-use plan is: treat plugging this into the real gateway as **bring-up**,
not "should just work." Specifically check, in order:

1. Does `Connect` succeed and do boot lines appear in the log at all? (Proves: serial
   link, baud rate, port selection.)
2. Does `SLEEP` silence the stream and `WAKE` resume it? (Proves: the collar's
   `aa100002` characteristic exists and is reachable — this is the one most likely to
   fail first, since it's the newest, least-tested piece on the collar side.)
3. Does `IMU RUN` make the accel/gyro columns in the "latest reading" card stop
   reading `-`?
4. Does `READ RFID LOOP` with a tag present make the RFID fields populate?

If step 2 does nothing, don't assume this panel is broken — check whether the collar
firmware actually flashed has the `aa100002` handler at all (it was, as of this
writing, uncommitted and never flashed).

## 6. If something goes wrong

- **Port doesn't show up in the dropdown** — press Refresh after plugging in; Windows
  sometimes needs a second for the COM port to register.
- **"Access is denied" / port won't open** — something else has it open (Arduino
  IDE's Serial Monitor, PlatformIO's monitor, another browser tab of this same panel).
  Close the other one first.
- **Connected, but no lines ever appear** — check the gateway is actually powered and
  running `esp32_gateway` (not `hw_stress_test` or `ble_receive_test` — those are
  separate PlatformIO envs that don't talk this protocol).
- **Lines appear but a command's ack never shows** — the log panel shows a bounded
  buffer (drop-oldest under load, with a `# panel: N line(s) dropped` notice if it
  happens) — at the gateway's actual telemetry rate this is very unlikely to matter,
  but it's there if the port is ever flooded.

---

See `README.md` for the code layout and how to add an 8th command to the registry.
