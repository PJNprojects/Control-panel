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

1. Double-click `Launch_ControlPanel.bat` inside this folder. First run creates a
   private `.\venv\` and installs Flask + pyserial into it (needs internet once);
   later runs skip straight to starting the server.
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
- **Command panel** — one button per registry entry (`SLEEP`, `WAKE`,
  `READ RFID <n> <m>`, `READ RFID LOOP`, `STOP RFID LOOP`, `IMU RUN`, `IMU HALT`), plus
  a free-text box for anything not (yet) a button.
- **Log panel** — every `#`-prefixed line from the gateway, scrolling: boot messages,
  the header line once, and a `# cmd: ... -> sent / FAILED (...) / unknown '...'` line
  for every command you send.
- **Latest reading card** — the most recent 12-field telemetry record, decoded (accel
  in m/s², gyro in rad/s, not raw wire integers), not a scrolling history table. This
  tool answers "what's happening right now," not "log everything to a file" — if you
  need history, that's a separate, later feature (log panel included).

## 4. The 7 commands

| Button | What it does | Sent as | Collar-side effect |
|---|---|---|---|
| `SLEEP` | Silences the link entirely — telemetry stops until `WAKE`. Whatever RFID/IMU mode was active underneath is preserved, not reset. | `SLEEP` | Overlay, not a mode change. |
| `WAKE` | Resumes exactly what was running before `SLEEP` — you do not need to re-send `READ RFID LOOP` / `IMU RUN` after waking. | `WAKE` | — |
| `READ RFID <n> <m>` | One-shot scan: stop early after `n` successful CRC-valid reads, or give up after `m` attempts (~70ms each). Reverts to whatever mode was active before. | `READ RFID {n} {m}` | Result shows up in the very next telemetry row's RFID fields — there's no separate "done" signal, watch the log/card. |
| `READ RFID LOOP` | Start continuous scanning. | `READ RFID LOOP` | — |
| `STOP RFID LOOP` | Stop continuous scanning. Fixed 3-word phrase — `STOP RFID` alone is rejected. | `STOP RFID LOOP` | — |
| `IMU RUN` | Start populating accel/gyro fields (they read `-` until this is sent — this is the collar's default boot state). | `IMU RUN` | — |
| `IMU HALT` | Stop populating IMU fields. Telemetry keeps flowing with `-` in those columns — only `SLEEP` stops the stream itself. Note: **HALT**, not STOP. | `IMU HALT` | — |

The panel validates `n`/`m` (0-255) before sending anything — an out-of-range value
never reaches the serial port, you just get an error in the UI. Everything you type or
click is echoed back in the log panel as the exact ASCII sent, so what you see there is
literally what went out the USB cable.

**On a freshly booted collar, nothing scans and no IMU flows until you send
`READ RFID LOOP` (or a one-shot) and `IMU RUN`** — that's the collar's current default,
not a bug in this panel. (Separately tracked: getting the collar to default to
continuous scanning again is its own pending item, not something this tool controls.)

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
