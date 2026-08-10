/*
 * PC Control Panel — frontend.
 *
 * Three jobs, kept separate:
 *
 *   1. Connection strip   — list ports, connect, disconnect, show state.
 *   2. Command panel      — BUILT FROM /api/commands, never hardcoded.
 *   3. Live stream        — one EventSource, events routed by `type`.
 *
 * The rule that matters is (2): this file knows how to render "a command with
 * N integer parameters". It does not know that SLEEP exists. Add an entry to
 * backend/commands.py, reload the page, and the control appears — no edit
 * here, no edit in index.html.
 *
 * Vanilla JS on purpose: no build step, no node_modules, no bundler. The
 * whole tool is `pip install -r requirements.txt` and a .bat file, and it
 * should stay that way.
 */

(function () {
  "use strict";

  var el = function (id) { return document.getElementById(id); };

  var portSelect  = el("port-select");
  var btnRefresh  = el("btn-refresh");
  var btnConnect  = el("btn-connect");
  var statusDot   = el("status-dot");
  var statusText  = el("status-text");
  var commandsBox = el("commands");
  var rawText     = el("raw-text");
  var btnRaw      = el("btn-raw");
  var rawHint     = el("raw-hint");
  var logBox      = el("log");
  var telemetryBox = el("telemetry");
  var telemetryMeta = el("telemetry-meta");
  var autoscroll  = el("autoscroll");
  var btnClear    = el("btn-clear");

  var imuDial       = el("imu-dial");
  var imuYawGroup   = el("yaw-markers");
  var imuCrosshair  = el("crosshair");
  var imuYawValue   = el("imu-yaw-value");
  var imuPitchValue = el("imu-pitch-value");
  var imuRollValue  = el("imu-roll-value");
  var gravityFill   = el("gravity-bar-fill");
  var gravityValue  = el("gravity-bar-value");
  var btnImuReset   = el("btn-imu-reset");
  var imuTempValue  = el("imu-temp-value");
  var imuRfidValue  = el("imu-rfid-value");
  var imuTempCard   = imuTempValue.closest(".highlight-card");
  var imuRfidCard   = imuRfidValue.closest(".highlight-card");

  var scanHistoryBody   = el("scan-history-body");
  scanHistoryBody.dataset.empty = "1"; // matches the placeholder row already in the HTML
  var scanHistoryMeta   = el("scan-history-meta");
  var btnScanClear      = el("btn-scan-clear");
  var btnScanDownload   = el("btn-scan-download");
  var scanPeriodInput   = el("scan-period-input");
  var scanNInput        = el("scan-n-input");
  var scanMInput        = el("scan-m-input");
  var btnScanAutoToggle = el("btn-scan-auto-toggle");

  // Only the gyro axes get a bar-graph element now (see the OLED port note
  // above updateImu) — ax/ay/az still flow into imuHistory/imuSmoothed for
  // the accel chart, they just don't have a bar to fill.
  var GYRO_BAR_KEYS = ["gx", "gy", "gz"];
  var barFill  = {}, barValue = {};
  GYRO_BAR_KEYS.forEach(function (key) {
    barFill[key]  = el("bar-" + key);
    barValue[key] = el("val-" + key);
  });
  var chartAccel = el("chart-accel");
  var chartGyro  = el("chart-gyro");

  var connected = false;
  var rawCommandName = "__raw__";

  // The log is a rolling window, not a transcript. At a record every ~570ms
  // an all-day session would otherwise put tens of thousands of nodes in the
  // DOM and make the tab crawl. Only '#' lines land here, so the rate is low,
  // but the ceiling still matters for a session left running overnight.
  var LOG_MAX_ROWS = 1000;

  var packetCount = 0;

  // ---------------------------------------------------------------------
  //  Small helpers
  // ---------------------------------------------------------------------

  function api(path, options) {
    return fetch(path, options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok || body.ok === false) {
          throw new Error(body.error || ("HTTP " + response.status));
        }
        return body;
      });
    });
  }

  function postJSON(path, payload) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
  }

  function localNote(text, kind) {
    appendLog({ text: "# panel: " + text, origin: "panel", level: kind || "info" });
  }

  // ---------------------------------------------------------------------
  //  Connection strip
  // ---------------------------------------------------------------------

  function refreshPorts() {
    return api("/api/ports").then(function (body) {
      var previous = portSelect.value;
      portSelect.innerHTML = "";
      if (!body.ports.length) {
        var none = document.createElement("option");
        none.value = "";
        none.textContent = "No serial ports found";
        portSelect.appendChild(none);
        return;
      }
      body.ports.forEach(function (port) {
        var option = document.createElement("option");
        option.value = port.device;
        option.textContent = port.description
          ? port.device + " - " + port.description
          : port.device;
        portSelect.appendChild(option);
      });
      if (previous) { portSelect.value = previous; }
    }).catch(function (err) {
      localNote("could not list ports: " + err.message, "error");
    });
  }

  function applyStatus(status) {
    connected = !!(status && status.connected);
    statusDot.className = "dot " + (connected ? "up" : "down");
    if (connected) {
      statusText.textContent = "Connected " + status.port + " @ " + status.baud;
      btnConnect.textContent = "Disconnect";
      btnConnect.className = "danger";
      portSelect.disabled = true;
    } else {
      statusText.textContent = status && status.last_error
        ? "Disconnected - " + status.last_error
        : "Disconnected";
      btnConnect.textContent = "Connect";
      btnConnect.className = "primary";
      portSelect.disabled = false;
    }
  }

  btnConnect.addEventListener("click", function () {
    btnConnect.disabled = true;
    var done = function () { btnConnect.disabled = false; };

    if (connected) {
      postJSON("/api/disconnect")
        .then(function (body) { applyStatus(body.status); })
        .catch(function (err) { localNote(err.message, "error"); })
        .then(done, done);
      return;
    }

    var port = portSelect.value;
    if (!port) { localNote("pick a port first", "error"); done(); return; }

    postJSON("/api/connect", { port: port })
      .then(function (body) { applyStatus(body.status); })
      .catch(function (err) { localNote("connect failed: " + err.message, "error"); })
      .then(done, done);
  });

  btnRefresh.addEventListener("click", refreshPorts);

  // ---------------------------------------------------------------------
  //  Command panel — generated, not written
  // ---------------------------------------------------------------------

  // Resolves to true/false (never rejects) so a caller can react to whether
  // the send actually succeeded — e.g. arming the RFID "no tag found"
  // timeout only makes sense once bytes actually went out.
  function sendCommand(name, params, button) {
    if (button) { button.disabled = true; }
    var release = function () { if (button) { button.disabled = false; } };

    return postJSON("/api/command", { name: name, params: params })
      .then(function () { return true; })
      .catch(function (err) {
        // Rejected commands are shown in the log next to the gateway's own
        // acks, so there is one place to look for "what happened when I
        // pressed that", regardless of which side said no.
        localNote("rejected: " + err.message, "error");
        return false;
      })
      .then(function (ok) { release(); return ok; });
  }

  // Toggle controls post the same /api/command endpoint as everything else,
  // but need to know whether the send succeeded (to snap back on rejection)
  // rather than sendCommand's fire-and-forget-with-a-log-line behaviour.
  function sendToggleCommand(name) {
    return postJSON("/api/command", { name: name, params: {} })
      .then(function () { return true; })
      .catch(function (err) {
        localNote("rejected: " + err.message, "error");
        return false;
      });
  }

  function toggleTooltip(tg) {
    return "ON = " + tg.on.label + ": " + (tg.on.description || tg.on.send) +
      "   OFF = " + tg.off.label + ": " + (tg.off.description || tg.off.send) +
      "   (shows the last state you sent - the gateway has no reply channel, " +
      "so this is not a confirmed hardware ack; read the telemetry for that.)";
  }

  // SLEEP/WAKE — an iOS-style slider. One flick, one command either way.
  function buildSliderControl(tg) {
    var card = document.createElement("div");
    card.className = "cmd cmd-toggle";
    card.setAttribute("data-tooltip", toggleTooltip(tg));

    var caption = document.createElement("div");
    caption.className = "toggle-caption";
    caption.textContent = tg.label;
    card.appendChild(caption);

    var wrap = document.createElement("label");
    wrap.className = "slider-switch";

    var input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", tg.label);

    var track = document.createElement("span");
    track.className = "slider-track";
    var knob = document.createElement("span");
    knob.className = "slider-knob";
    track.appendChild(knob);

    wrap.appendChild(input);
    wrap.appendChild(track);
    card.appendChild(wrap);

    var stateText = document.createElement("div");
    stateText.className = "toggle-state-text";
    card.appendChild(stateText);

    function applyVisual(isOn) {
      wrap.classList.toggle("is-on", isOn);
      wrap.classList.toggle("is-off", !isOn);
      stateText.textContent = isOn ? tg.on.label : tg.off.label;
      input.checked = isOn;
    }
    applyVisual(tg.defaultOn);

    input.addEventListener("change", function () {
      var turningOn = input.checked;
      var toSend = turningOn ? tg.on : tg.off;
      input.disabled = true;
      sendToggleCommand(toSend.name).then(function (ok) {
        input.disabled = false;
        // On success, adopt the new state. On rejection, snap the switch
        // back to what it actually was - never claim a state that was never
        // sent.
        applyVisual(ok ? turningOn : !turningOn);
      });
    });

    return card;
  }

  // IMU RUN/HALT, READ RFID LOOP/STOP RFID LOOP — a button that stays
  // "pressed" (color + label change) until pressed again.
  function buildPressToggleControl(tg) {
    var card = document.createElement("div");
    card.className = "cmd cmd-toggle";
    card.setAttribute("data-tooltip", toggleTooltip(tg));

    var caption = document.createElement("div");
    caption.className = "toggle-caption";
    caption.textContent = tg.label;
    card.appendChild(caption);

    var button = document.createElement("button");
    button.className = "press-toggle";

    var isOn = tg.defaultOn;

    // toggle_text is what a STATUS button should say ("Start IMU" /
    // "IMU RUNNING"), separate from the underlying command's own label
    // ("IMU HALT") - falls back to the label if a registry entry doesn't
    // set it, so this still works for any future toggle pair that skips it.
    function applyVisual() {
      var active = isOn ? tg.on : tg.off;
      button.textContent = active.toggle_text || active.label;
      button.classList.toggle("is-on", isOn);
      button.classList.toggle("is-off", !isOn);
    }
    applyVisual();

    button.addEventListener("click", function () {
      var turningOn = !isOn;
      var toSend = turningOn ? tg.on : tg.off;
      button.disabled = true;
      sendToggleCommand(toSend.name).then(function (ok) {
        button.disabled = false;
        if (ok) { isOn = turningOn; }
        applyVisual();
      });
    });

    card.appendChild(button);
    return card;
  }

  function buildCommandControl(command) {
    var card = document.createElement("div");
    card.className = "cmd" + (command.danger ? " cmd-danger" : "");
    card.dataset.group = command.group || "general";
    // Description moved off the card (it was always-visible text, which is
    // most of what made the panel tall) and into a hover tooltip instead.
    card.setAttribute("data-tooltip",
      (command.description ? command.description + "  " : "") + "sends: " + command.send);

    var button = document.createElement("button");
    button.className = command.danger ? "danger" : "primary";
    button.textContent = command.label;
    button.title = command.description || command.send;

    var inputs = {};

    if (command.params && command.params.length) {
      var form = document.createElement("div");
      form.className = "cmd-params";

      command.params.forEach(function (spec) {
        var wrap = document.createElement("label");
        wrap.className = "param";
        wrap.textContent = spec.name;
        wrap.title = spec.label + (spec.help ? " - " + spec.help : "");

        var input = document.createElement("input");
        input.type = "number";
        // Mirrors the registry's own bounds. Convenience only — the server
        // re-validates every value, because anything can POST to /api/command.
        input.min = spec.min;
        input.max = spec.max;
        input.step = 1;
        input.value = spec.default;
        input.setAttribute("aria-label", spec.label);

        wrap.appendChild(input);
        form.appendChild(wrap);
        inputs[spec.name] = input;
      });

      card.appendChild(form);
    }

    button.addEventListener("click", function () {
      var params = {};
      Object.keys(inputs).forEach(function (key) {
        params[key] = inputs[key].value;
      });
      sendCommand(command.name, params, button).then(function (ok) {
        // Data-driven, not a check for "is this READ RFID <n> <m>": any
        // command that declares rfid_scan_probe_param gets this treatment,
        // same pattern as toggle_group. See the field's comment in
        // commands.py for why this timeout exists and what it can't know.
        if (!ok || !command.rfid_scan_probe_param) { return; }
        var probeInput = inputs[command.rfid_scan_probe_param];
        var attempts = probeInput ? parseInt(probeInput.value, 10) : NaN;
        if (!isNaN(attempts)) { armRfidScan(attempts, "manual"); }
      });
    });

    card.appendChild(button);

    return card;
  }

  function loadCommands() {
    return api("/api/commands").then(function (body) {
      commandsBox.innerHTML = "";

      if (body.raw_command) {
        rawCommandName = body.raw_command.name;
        rawText.maxLength = body.raw_command.max_chars;
        rawHint.textContent =
          "Sent exactly as typed, one line, max " + body.raw_command.max_chars +
          " characters (the gateway discards longer lines).";
      }

      // Commands that declare a matching toggle_group (SLEEP+WAKE,
      // IMU RUN+HALT, READ RFID LOOP+STOP RFID LOOP) render as one switch
      // instead of two buttons. This reads it off the registry data, same as
      // everything else here - the UI still doesn't know "SLEEP" exists,
      // it knows "two commands that share a toggle_group and opposite
      // toggle_state form a switch."
      var toggleGroups = {};
      var standalone = [];
      body.commands.forEach(function (command) {
        if (!command.toggle_group) { standalone.push(command); return; }
        var tg = toggleGroups[command.toggle_group] ||
          (toggleGroups[command.toggle_group] = { uiGroup: command.group || "general" });
        tg[command.toggle_state] = command;
        tg.style = command.toggle_style || "press";
        tg.label = command.toggle_label || command.toggle_group;
        tg.defaultOn = command.toggle_default === "on";
      });

      // Group in registry order, so related commands sit together without the
      // registry having to be sorted or the UI having to know the group names.
      var groups = [];
      var byGroup = {};
      function ensureGroup(key) {
        if (!byGroup[key]) { byGroup[key] = []; groups.push(key); }
        return byGroup[key];
      }
      standalone.forEach(function (command) {
        ensureGroup(command.group || "general").push({ kind: "cmd", command: command });
      });
      Object.keys(toggleGroups).forEach(function (key) {
        var tg = toggleGroups[key];
        // Defensive: a group missing either half (e.g. mid-edit registry)
        // falls back to plain buttons rather than silently disappearing.
        if (!tg.on || !tg.off) {
          if (tg.on) { ensureGroup(tg.uiGroup).push({ kind: "cmd", command: tg.on }); }
          if (tg.off) { ensureGroup(tg.uiGroup).push({ kind: "cmd", command: tg.off }); }
          return;
        }
        ensureGroup(tg.uiGroup).push({ kind: "toggle", toggle: tg });
      });

      groups.forEach(function (key) {
        var row = document.createElement("div");
        row.className = "cmd-group";
        var title = document.createElement("h3");
        title.textContent = key;
        row.appendChild(title);
        var cards = document.createElement("div");
        cards.className = "cmd-row";
        byGroup[key].forEach(function (item) {
          if (item.kind === "toggle") {
            cards.appendChild(item.toggle.style === "slider"
              ? buildSliderControl(item.toggle)
              : buildPressToggleControl(item.toggle));
          } else {
            cards.appendChild(buildCommandControl(item.command));
          }
        });
        row.appendChild(cards);
        commandsBox.appendChild(row);
      });
    }).catch(function (err) {
      commandsBox.innerHTML =
        '<p class="error">Could not load the command registry: ' +
        err.message + "</p>";
    });
  }

  function sendRaw() {
    var text = rawText.value;
    if (!text.trim()) { return; }
    btnRaw.disabled = true;
    postJSON("/api/command", { name: rawCommandName, text: text })
      .then(function () { rawText.select(); })
      .catch(function (err) { localNote("rejected: " + err.message, "error"); })
      .then(function () { btnRaw.disabled = false; },
            function () { btnRaw.disabled = false; });
  }

  btnRaw.addEventListener("click", sendRaw);
  rawText.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); sendRaw(); }
  });

  // ---------------------------------------------------------------------
  //  Log panel
  // ---------------------------------------------------------------------

  function appendLog(event) {
    var row = document.createElement("div");
    row.className = "log-row";

    if (event.origin === "panel") { row.classList.add("log-panel-note"); }
    if (event.level === "error") { row.classList.add("log-error"); }
    if (event.parse_error) { row.classList.add("log-error"); }
    if (/->\s*FAILED|unknown|too long/i.test(event.text || "")) {
      row.classList.add("log-error");
    } else if (/->\s*sent/i.test(event.text || "")) {
      row.classList.add("log-ok");
    }

    var time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date().toLocaleTimeString();

    var text = document.createElement("span");
    text.className = "log-text";
    text.textContent = event.parse_error
      ? event.text + "    [unparsed: " + event.parse_error + "]"
      : event.text;

    row.appendChild(time);
    row.appendChild(text);
    logBox.appendChild(row);

    while (logBox.childElementCount > LOG_MAX_ROWS) {
      logBox.removeChild(logBox.firstChild);
    }
    if (autoscroll.checked) { logBox.scrollTop = logBox.scrollHeight; }
  }

  btnClear.addEventListener("click", function () { logBox.innerHTML = ""; });

  // ---------------------------------------------------------------------
  //  Telemetry panel — "latest reading" card
  // ---------------------------------------------------------------------

  // Field order matches the wire order, which matches the gateway's own
  // header line, so the card can be read against a raw serial dump directly.
  var FIELDS = [
    { key: "timestamp",     label: "timestamp",  unit: "ms since gw boot" },
    { key: "collar_id",     label: "collar",     unit: "" },
    { key: "ax",            label: "ax",         unit: "cm/s²", scale: 0.01, scaled: "m/s²" },
    { key: "ay",            label: "ay",         unit: "cm/s²", scale: 0.01, scaled: "m/s²" },
    { key: "az",            label: "az",         unit: "cm/s²", scale: 0.01, scaled: "m/s²" },
    { key: "gx",            label: "gx",         unit: "mrad/s", scale: 0.001, scaled: "rad/s" },
    { key: "gy",            label: "gy",         unit: "mrad/s", scale: 0.001, scaled: "rad/s" },
    { key: "gz",            label: "gz",         unit: "mrad/s", scale: 0.001, scaled: "rad/s" },
    { key: "temperature",   label: "temp",       unit: "°C implant" },
    { key: "rfid_id",       label: "rfid_id",    unit: "FDX-B tag" },
    { key: "ble_connected", label: "ble link",   unit: "1 = up" },
    { key: "age_ms",        label: "age",        unit: "ms since packet" }
  ];

  var cells = null;

  function buildTelemetryCard() {
    telemetryBox.innerHTML = "";
    cells = {};
    FIELDS.forEach(function (field) {
      var cell = document.createElement("div");
      cell.className = "cell";

      var label = document.createElement("div");
      label.className = "cell-label";
      label.textContent = field.label;

      var value = document.createElement("div");
      value.className = "cell-value none";
      value.textContent = "-";

      var unit = document.createElement("div");
      unit.className = "cell-unit";
      unit.textContent = field.unit;

      cell.appendChild(label);
      cell.appendChild(value);
      cell.appendChild(unit);
      telemetryBox.appendChild(cell);
      cells[field.key] = { value: value, unit: unit, spec: field };
    });
  }

  function renderTelemetry(data) {
    if (!cells) { buildTelemetryCard(); }
    packetCount += 1;

    FIELDS.forEach(function (field) {
      var cell = cells[field.key];
      var raw = data[field.key];

      if (raw === null || raw === undefined) {
        // A sentinel from the wire. It means "the collar did not say this was
        // fresh" and is rendered as the same '-' the gateway printed - NOT as
        // zero, and not as a stale previous value.
        cell.value.textContent = "-";
        cell.value.classList.add("none");
        cell.unit.textContent = field.unit;
        return;
      }

      cell.value.classList.remove("none");
      cell.value.textContent = String(raw);

      // Scaling is presentation, so it happens here rather than in the parser.
      // Both forms are shown: the raw count is what is on the wire and what
      // you would see in a terminal, the converted value is what it means.
      if (field.scale && typeof raw === "number") {
        cell.unit.textContent =
          (raw * field.scale).toFixed(field.scale === 0.01 ? 2 : 3) +
          " " + field.scaled;
      } else {
        cell.unit.textContent = field.unit;
      }
    });

    telemetryMeta.textContent =
      packetCount + " record" + (packetCount === 1 ? "" : "s") +
      " - last at " + new Date().toLocaleTimeString();

    updateImu(data);
  }

  // ---------------------------------------------------------------------
  //  IMU orientation widget — yaw dial + pitch/roll crosshair + gravity bar
  //  + 6-axis bar graphs + rolling time graphs.
  //
  //  Same maths the gateway's TFT does, kept in one place so both displays
  //  agree on what "level" and "north" mean:
  //
  //  - Pitch/roll come from the accelerometer's gravity vector (the usual
  //    atan2 tilt formulas). That only means what it says while gravity is
  //    the dominant force on the collar — mid-swing readings will lie, same
  //    as any single-sensor tilt display. There is no gyro/accel fusion.
  //  - Yaw has no absolute reference (no magnetometer on this collar), so
  //    it is the running integral of gz since the last reset — it drifts,
  //    and "Reset origin" is the only way to re-zero it. That is a hardware
  //    limitation, not a bug in this widget.
  //  - Gravity magnitude is |a| = sqrt(ax^2+ay^2+az^2). Stationary and
  //    level, it should sit near 9.81 (the dashed reference line).
  //
  //  EVERY value shown here — dial, bars, charts — is passed through a
  //  single exponential moving average (EMA) first. Raw BLE/serial samples
  //  are visibly jittery frame to frame; the EMA plus the CSS transitions on
  //  the dial/crosshair/bars is what makes it read as smooth motion instead
  //  of noise. Filtering happens once, in one place, so the dial and the
  //  bars and the charts never disagree with each other.
  //
  //  The charts keep a bounded rolling window (IMU_HISTORY_LEN samples) in
  //  plain arrays and redraw a <canvas> each packet — not a growing log and
  //  not DOM rows, so memory and paint cost stay flat no matter how long the
  //  session runs. This is deliberately narrower than the "no history"
  //  stance in README.md for the log/telemetry card: that call was about a
  //  full-session transcript, this is a fixed-size recent-trend view.
  // ---------------------------------------------------------------------

  var IMU_CROSSHAIR_MAX_DEG = 45;   // pitch/roll swing mapped to full radius
  var IMU_CROSSHAIR_MAX_PX  = 55;   // stays inside the dial's inner ring
  var IMU_GRAVITY_MAX_MS2   = 20;   // bar full-scale (~2 g headroom)
  var IMU_ACCEL_RANGE_MS2   = 20;   // bar/chart full-scale for ax/ay/az, ±
  var IMU_GYRO_RANGE_RADS   = 5;    // bar/chart full-scale for gx/gy/gz, ±
  var IMU_BAR_TRACK_PX      = 90;   // must match .channel-track height in CSS
  var IMU_SMOOTHING_ALPHA   = 0.22; // EMA factor: lower = smoother, more lag
  var IMU_HISTORY_LEN       = 150;  // rolling window length for the charts

  var imuYawDeg      = 0;     // accumulated since last reset, degrees
  var imuLastGyroTs  = null;  // last telemetry timestamp with a fresh gz
  var imuHasOrigin   = false; // has a pitch/roll baseline been captured yet
  var imuPitchOrigin = 0;
  var imuRollOrigin  = 0;

  // Smoothed values, in physical units (m/s^2, rad/s). null = not yet
  // anchored (or IMU currently halted) — re-anchors to the next raw sample
  // rather than decaying toward it, so resuming after IMU HALT doesn't draw
  // a slow fake ramp from zero.
  var imuSmoothed = { ax: null, ay: null, az: null, gx: null, gy: null, gz: null };

  // Rolling history for the charts, same units as imuSmoothed. Carries the
  // last known value forward on a gap (IMU HALT) so the line visibly
  // flatlines instead of faking a drop to zero.
  var imuHistory = { ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };

  // --- temp / RFID: sticky last-known reading + a best-effort "no tag
  // found" call-out ---------------------------------------------------
  //
  // The wire's rfid_id field is per-RECORD freshness, not a persistent
  // value (see telemetry_parser.py): most records read '-' simply because
  // no *new* scan landed in that particular ~600ms BLE cycle, not because
  // scanning failed. Blanking the card to '-' every time that happens would
  // make it flicker constantly during a perfectly normal READ RFID LOOP and
  // wouldn't tell you anything. So instead: hang onto the last tag actually
  // seen and its temperature, and only change the DISPLAYED state on real
  // events - a fresh read (green), going quiet for a while (amber/stale,
  // still showing the last tag so you don't lose it), or, for the one-shot
  // READ RFID <n> <m> button specifically, an explicit "NO TAG FOUND" if no
  // fresh read shows up within roughly n*m's attempt budget.
  //
  // That one-shot case is the ONLY place this panel has real grounds to
  // call something "failed" - the gateway has no completion signal for it
  // (README section 6), so this is a client-side timeout heuristic built
  // from the command's own parameters, not a hardware ack. It is disarmed
  // the instant a fresh tag shows up, and it only fires once per send.
  var RFID_ATTEMPT_MS        = 70;    // matches HANDOFF.md's "~70 ms each attempt"
  var RFID_TIMEOUT_BUFFER_MS = 400;   // slack for serial/BLE round trip + one telemetry period
  var RFID_STALE_MS          = 3000;  // no fresh read in this long -> shown as stale, not silently frozen
  var RFID_NO_TAG_FLASH_MS   = 4000;  // how long "NO TAG FOUND" stays up after a one-shot times out

  var rfidLastId       = null;  // sticky - last tag actually seen this session
  var rfidLastTemp      = null; // sticky - its temperature reading
  var rfidLastSeenTs    = null; // wall-clock ms of the last fresh read
  var rfidOneShotDeadline = null; // wall-clock ms after which "no tag" fires, or null if not armed
  var rfidNoTagFlashUntil = null; // wall-clock ms until which "NO TAG FOUND" stays displayed
  var rfidPendingSource   = null; // "manual" | "auto" - who armed the current pending scan, for the history log

  // Arms both the highlight card's "no tag found" flash AND a scan-history
  // row - one probe, one outcome, recorded in both places. `source` is
  // which control fired the READ RFID <n> <m> (see the Scan History
  // section below for where "manual" and "auto" come from).
  function armRfidScan(attempts, source) {
    if (!attempts || attempts <= 0) { return; }
    rfidOneShotDeadline = Date.now() + attempts * RFID_ATTEMPT_MS + RFID_TIMEOUT_BUFFER_MS;
    rfidPendingSource = source;
  }

  var RFID_CARD_STATES = ["card-idle", "card-fresh", "card-stale", "card-warn"];

  function setCardState(card, state) {
    RFID_CARD_STATES.forEach(function (c) { card.classList.remove(c); });
    card.classList.add(state);
  }

  function renderRfidCards(now) {
    var oneShotTimedOut = rfidOneShotDeadline !== null && now >= rfidOneShotDeadline;
    if (oneShotTimedOut) {
      rfidOneShotDeadline = null;               // fires once
      rfidNoTagFlashUntil = now + RFID_NO_TAG_FLASH_MS;
      logScanResult(now, null, null, rfidPendingSource);
      rfidPendingSource = null;
    }

    // One state drives both cards - temp and rfid_id come off the same tag
    // read, so they go stale/fresh/idle together.
    var state;

    if (rfidNoTagFlashUntil !== null && now < rfidNoTagFlashUntil) {
      state = "card-warn";
      imuRfidValue.textContent = "NO TAG FOUND";
      imuRfidValue.classList.remove("none", "stale");
      imuRfidValue.classList.add("warn");
    } else {
      rfidNoTagFlashUntil = null;
      if (rfidLastId !== null) {
        var isStale = (now - rfidLastSeenTs) >= RFID_STALE_MS;
        state = isStale ? "card-stale" : "card-fresh";
        imuRfidValue.textContent = rfidLastId;
        imuRfidValue.classList.remove("none", "warn");
        imuRfidValue.classList.toggle("stale", isStale);
      } else {
        state = "card-idle";
        imuRfidValue.textContent = "-";
        imuRfidValue.classList.remove("warn", "stale");
        imuRfidValue.classList.add("none");
      }
    }
    setCardState(imuRfidCard, state);
    setCardState(imuTempCard, state);

    if (rfidLastTemp !== null) {
      imuTempValue.textContent = rfidLastTemp.toFixed(1) + "°C";
      imuTempValue.classList.remove("none");
      imuTempValue.classList.toggle("stale", state === "card-stale");
    } else {
      imuTempValue.textContent = "-";
      imuTempValue.classList.remove("stale");
      imuTempValue.classList.add("none");
    }
  }

  // ---------------------------------------------------------------------
  //  RFID scan history — a log of resolved scan attempts (manual button
  //  presses and the auto-scan timer below), each row a timestamp + a
  //  found-or-not verdict. This is deliberately IN THE BROWSER TAB, not on
  //  the server: no new Flask route, no file on disk, consistent with the
  //  rest of this file staying "vanilla JS, no build step, no dependency."
  //  The real tradeoff, stated plainly rather than glossed over: it's gone
  //  if the tab is closed or the page reloads, and long unattended runs
  //  should have the CSV downloaded periodically rather than trusted to
  //  stay in memory forever. Bounded at SCAN_HISTORY_MAX for the same
  //  reason the log panel and the IMU charts are bounded - flat memory and
  //  paint cost regardless of session length.
  // ---------------------------------------------------------------------

  var SCAN_HISTORY_MAX = 2000;
  var scanHistory = [];   // newest first

  function logScanResult(now, tagId, temp, source, gwTs) {
    var entry = {
      ts: now,
      tagId: tagId || null,
      temp: (temp === null || temp === undefined) ? null : temp,
      found: tagId !== null && tagId !== undefined,
      source: source || "manual",
      gwTs: (gwTs === null || gwTs === undefined) ? null : gwTs
    };
    scanHistory.unshift(entry);
    if (scanHistory.length > SCAN_HISTORY_MAX) { scanHistory.length = SCAN_HISTORY_MAX; }
    prependScanRow(entry);
    scanHistoryMeta.textContent = scanHistory.length + " scan" +
      (scanHistory.length === 1 ? "" : "s") + " logged";
  }

  function prependScanRow(entry) {
    if (scanHistoryBody.dataset.empty === "1") {
      scanHistoryBody.innerHTML = "";
      delete scanHistoryBody.dataset.empty;
    }
    var row = document.createElement("tr");

    var timeCell = document.createElement("td");
    timeCell.textContent = new Date(entry.ts).toLocaleTimeString();
    row.appendChild(timeCell);

    var idCell = document.createElement("td");
    idCell.textContent = entry.found ? entry.tagId : "-";
    row.appendChild(idCell);

    var tempCell = document.createElement("td");
    tempCell.textContent = entry.temp !== null ? entry.temp.toFixed(1) + "°C" : "-";
    row.appendChild(tempCell);

    var resultCell = document.createElement("td");
    resultCell.textContent = entry.found ? "FOUND" : "NO TAG";
    resultCell.className = entry.found ? "scan-result-found" : "scan-result-none";
    row.appendChild(resultCell);

    var sourceCell = document.createElement("td");
    sourceCell.className = "scan-source";
    sourceCell.textContent = entry.source;
    row.appendChild(sourceCell);

    var gwCell = document.createElement("td");
    gwCell.textContent = entry.gwTs !== null ? String(entry.gwTs) : "-";
    row.appendChild(gwCell);

    scanHistoryBody.insertBefore(row, scanHistoryBody.firstChild);
    while (scanHistoryBody.childElementCount > SCAN_HISTORY_MAX) {
      scanHistoryBody.removeChild(scanHistoryBody.lastChild);
    }
  }

  btnScanClear.addEventListener("click", function () {
    scanHistory = [];
    scanHistoryBody.innerHTML = '<tr><td colspan="6" class="muted">No scans logged yet.</td></tr>';
    scanHistoryBody.dataset.empty = "1";
    scanHistoryMeta.textContent = "0 scans logged";
  });

  function csvEscape(value) {
    var text = value === null || value === undefined ? "" : String(value);
    if (/[",\n]/.test(text)) { return '"' + text.replace(/"/g, '""') + '"'; }
    return text;
  }

  btnScanDownload.addEventListener("click", function () {
    var header = ["time_iso", "tag_id", "temperature_c", "result", "source", "gateway_timestamp_ms"];
    var lines = [header.join(",")];
    // Exported oldest-first - the natural order to read a CSV in a
    // spreadsheet, even though the table itself shows newest-first.
    for (var i = scanHistory.length - 1; i >= 0; i--) {
      var e = scanHistory[i];
      lines.push([
        new Date(e.ts).toISOString(),
        csvEscape(e.tagId),
        e.temp !== null ? e.temp.toFixed(1) : "",
        e.found ? "FOUND" : "NO_TAG",
        e.source,
        e.gwTs !== null ? e.gwTs : ""
      ].join(","));
    }
    var blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = "rfid_scan_history_" + stamp + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // --- Auto-scan: fires READ RFID {n} {m} on a timer and logs the result
  // through the exact same armRfidScan()/logScanResult() path as the
  // manual button, tagged source="auto" so the table shows which is which.
  var autoScanOn = false;
  var autoScanTimerId = null;

  function triggerAutoScan() {
    var n = parseInt(scanNInput.value, 10);
    var m = parseInt(scanMInput.value, 10);
    if (isNaN(n) || isNaN(m)) {
      localNote("auto-scan: n/m must be numbers", "error");
      return;
    }
    sendCommand("read_rfid_once", { n: n, m: m }, null).then(function (ok) {
      if (ok) { armRfidScan(m, "auto"); }
    });
  }

  function scheduleNextAutoScan() {
    if (!autoScanOn) { return; }
    var periodS = Math.max(2, parseInt(scanPeriodInput.value, 10) || 30);
    autoScanTimerId = setTimeout(function () {
      triggerAutoScan();
      scheduleNextAutoScan();
    }, periodS * 1000);
  }

  btnScanAutoToggle.addEventListener("click", function () {
    autoScanOn = !autoScanOn;
    btnScanAutoToggle.classList.toggle("is-on", autoScanOn);
    btnScanAutoToggle.classList.toggle("is-off", !autoScanOn);
    if (autoScanOn) {
      var periodS = Math.max(2, parseInt(scanPeriodInput.value, 10) || 30);
      btnScanAutoToggle.textContent = "Auto-Scan Running (every " + periodS + "s)";
      triggerAutoScan();          // fire the first one immediately, not after a full period's wait
      scheduleNextAutoScan();
    } else {
      btnScanAutoToggle.textContent = "Start Auto-Scan";
      if (autoScanTimerId !== null) { clearTimeout(autoScanTimerId); autoScanTimerId = null; }
    }
  });

  function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }

  function emaUpdate(key, raw) {
    if (raw === null || raw === undefined) { imuSmoothed[key] = null; return null; }
    imuSmoothed[key] = (imuSmoothed[key] === null)
      ? raw
      : imuSmoothed[key] + IMU_SMOOTHING_ALPHA * (raw - imuSmoothed[key]);
    return imuSmoothed[key];
  }

  function pushHistory(key, value) {
    var arr = imuHistory[key];
    var last = arr.length ? arr[arr.length - 1] : 0;
    arr.push(value === null ? last : value);
    if (arr.length > IMU_HISTORY_LEN) { arr.shift(); }
  }

  function setYawTransform() {
    // The rotate() angle is the UNBOUNDED accumulator, on purpose. Wrapping
    // it into [0,360) before setting the transform was the cause of the
    // "spins like crazy at 0/360" bug: the CSS transition on #yaw-markers
    // animates FROM the old angle TO the new one, and a wrap from e.g.
    // 359.8deg to 0.2deg is a 359.6deg jump to the transition even though
    // the dial only actually moved 0.4deg - so it spun almost all the way
    // around every time it crossed the seam. Letting the angle climb past
    // 360 (or below 0) forever keeps the transform continuous, so the CSS
    // transition only ever animates the real, small delta. The readout text
    // is the only place that gets wrapped, and that's just string
    // formatting - it doesn't feed back into the rotation.
    imuYawGroup.setAttribute("transform", "rotate(" + imuYawDeg.toFixed(2) + " 110 110)");
    var displayYaw = ((imuYawDeg % 360) + 360) % 360;
    imuYawValue.textContent = displayYaw.toFixed(1) + "°";
  }

  function setSignedBar(key, value, range) {
    var fill = barFill[key];
    var half = IMU_BAR_TRACK_PX / 2;
    if (value === null) {
      fill.style.top = half + "px";
      fill.style.height = "0px";
      barValue[key].textContent = "-";
      return;
    }
    var frac = clamp(value / range, -1, 1);
    var barPx = Math.abs(frac) * half;
    if (frac >= 0) {
      fill.style.top = (half - barPx) + "px";
      fill.style.height = barPx + "px";
    } else {
      fill.style.top = half + "px";
      fill.style.height = barPx + "px";
    }
    barValue[key].textContent = value.toFixed(2);
  }

  function drawChart(canvas, keys, colors, range) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = "#2c3542";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    keys.forEach(function (key, idx) {
      var series = imuHistory[key];
      if (series.length < 2) { return; }
      ctx.strokeStyle = colors[idx];
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      series.forEach(function (v, i) {
        var x = (i / (IMU_HISTORY_LEN - 1)) * w;
        var clamped = clamp(v, -range, range);
        var y = h / 2 - (clamped / range) * (h / 2);
        if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
      });
      ctx.stroke();
    });
  }

  var CHART_COLORS = ["#4da3ff", "#4ccb7c", "#ffb347"]; // x, y, z — matches legend dots

  function updateImu(data) {
    var ts = data.timestamp;

    // Convert raw wire units to physical units, then smooth. Accel is
    // centi-m/s^2 -> m/s^2 (*0.01); gyro is milli-rad/s -> rad/s (*0.001).
    var axV = emaUpdate("ax", data.ax === null ? null : data.ax * 0.01);
    var ayV = emaUpdate("ay", data.ay === null ? null : data.ay * 0.01);
    var azV = emaUpdate("az", data.az === null ? null : data.az * 0.01);
    var gxV = emaUpdate("gx", data.gx === null ? null : data.gx * 0.001);
    var gyV = emaUpdate("gy", data.gy === null ? null : data.gy * 0.001);
    var gzV = emaUpdate("gz", data.gz === null ? null : data.gz * 0.001);

    pushHistory("ax", axV); pushHistory("ay", ayV); pushHistory("az", azV);
    pushHistory("gx", gxV); pushHistory("gy", gyV); pushHistory("gz", gzV);

    // Gyro rate bars only — accel's equivalent is the crosshair, not a bar
    // (see the OLED port note above updateImu).
    setSignedBar("gx", gxV, IMU_GYRO_RANGE_RADS);
    setSignedBar("gy", gyV, IMU_GYRO_RANGE_RADS);
    setSignedBar("gz", gzV, IMU_GYRO_RANGE_RADS);

    drawChart(chartAccel, ["ax", "ay", "az"], CHART_COLORS, IMU_ACCEL_RANGE_MS2);
    drawChart(chartGyro,  ["gx", "gy", "gz"], CHART_COLORS, IMU_GYRO_RANGE_RADS);

    // --- yaw: integrate the smoothed gz (rad/s) over elapsed wall time
    // between consecutive fresh gyro samples. IMU HALT / no packet yet
    // means gz is null - the dial freezes and dims rather than snapping to
    // zero, same "don't invent a value" rule the telemetry card follows.
    //
    // Sign is negated: on hardware, spinning the collar counter-clockwise
    // (viewed from above) produced a clockwise dial — the gz axis convention
    // on this chip runs opposite to the on-screen rotation sense, so the
    // integration is flipped here to match what an operator actually sees
    // happen to the physical collar.
    if (gzV !== null && ts !== null && ts !== undefined) {
      if (imuLastGyroTs !== null && ts > imuLastGyroTs) {
        var dtSec = (ts - imuLastGyroTs) / 1000;
        // No modulo here — see the comment in setYawTransform() for why the
        // accumulator has to stay unbounded.
        imuYawDeg -= gzV * dtSec * (180 / Math.PI);
      }
      imuLastGyroTs = ts;
      imuDial.classList.remove("imu-inactive");
    } else {
      imuDial.classList.add("imu-inactive");
    }
    setYawTransform();

    // --- pitch/roll + gravity magnitude, all from the smoothed accel vector.
    if (axV !== null && ayV !== null && azV !== null) {
      var pitchDeg = Math.atan2(-axV, Math.sqrt(ayV * ayV + azV * azV)) * (180 / Math.PI);
      var rollDeg  = Math.atan2(ayV, azV) * (180 / Math.PI);

      if (!imuHasOrigin) {
        imuPitchOrigin = pitchDeg;
        imuRollOrigin  = rollDeg;
        imuHasOrigin = true;
      }

      var relPitch = pitchDeg - imuPitchOrigin;
      var relRoll  = rollDeg - imuRollOrigin;

      var dx = clamp(relRoll  / IMU_CROSSHAIR_MAX_DEG * IMU_CROSSHAIR_MAX_PX,
                      -IMU_CROSSHAIR_MAX_PX, IMU_CROSSHAIR_MAX_PX);
      var dy = clamp(-relPitch / IMU_CROSSHAIR_MAX_DEG * IMU_CROSSHAIR_MAX_PX,
                      -IMU_CROSSHAIR_MAX_PX, IMU_CROSSHAIR_MAX_PX);

      imuCrosshair.setAttribute("transform", "translate(" + dx.toFixed(1) + " " + dy.toFixed(1) + ")");
      imuPitchValue.textContent = relPitch.toFixed(1) + "°";
      imuRollValue.textContent  = relRoll.toFixed(1) + "°";

      var magnitude = Math.sqrt(axV * axV + ayV * ayV + azV * azV);
      var pct = clamp(magnitude / IMU_GRAVITY_MAX_MS2 * 100, 0, 100);
      gravityFill.style.height = pct + "%";
      gravityValue.textContent = magnitude.toFixed(2) + " m/s²";
    } else {
      imuCrosshair.removeAttribute("transform");
      imuPitchValue.textContent = "-";
      imuRollValue.textContent = "-";
      gravityFill.style.height = "0%";
      gravityValue.textContent = "-";
    }

    // --- temp + RFID: record a fresh sighting if this packet has one, then
    // let renderRfidCards() decide what the card actually shows (sticky
    // last-known / stale / "no tag found" - see the comment on that state
    // block above for why it isn't as simple as "show data.rfid_id").
    var now = Date.now();
    if (data.rfid_id !== null && data.rfid_id !== undefined) {
      rfidLastId = data.rfid_id;
      rfidLastTemp = (data.temperature === null || data.temperature === undefined)
        ? rfidLastTemp : data.temperature;
      rfidLastSeenTs = now;
      // A fresh tag showed up while a scan was armed and pending -> that IS
      // the probe's result. Log it once, then disarm; a fresh tag arriving
      // with nothing pending (e.g. mid READ RFID LOOP) is just normal
      // telemetry and isn't logged - see the note on the panel above.
      if (rfidOneShotDeadline !== null) {
        logScanResult(now, data.rfid_id, rfidLastTemp, rfidPendingSource, data.timestamp);
      }
      rfidOneShotDeadline = null;
      rfidPendingSource = null;
    }
    renderRfidCards(now);
  }

  btnImuReset.addEventListener("click", function () {
    imuYawDeg = 0;
    setYawTransform();
    // Re-captured from the next telemetry record, so the crosshair recenters
    // on whatever orientation the collar is in right now.
    imuHasOrigin = false;
    localNote("IMU origin reset (yaw zeroed, pitch/roll re-centered)", "info");
  });

  // ---------------------------------------------------------------------
  //  The stream
  // ---------------------------------------------------------------------

  function startStream() {
    var source = new EventSource("/api/stream");

    source.onmessage = function (message) {
      var event;
      try { event = JSON.parse(message.data); } catch (e) { return; }

      if (event.type === "telemetry") {
        renderTelemetry(event.data);
      } else if (event.type === "log") {
        appendLog(event);
      } else if (event.type === "status") {
        applyStatus(event.status);
      }
      // "ping" is a keepalive and is deliberately ignored.
    };

    source.onerror = function () {
      // EventSource reconnects by itself; this is informational only, and is
      // deliberately not treated as "the serial port went away" - the two are
      // different failures and conflating them would mislead the operator.
      statusDot.classList.add("stale");
    };

    source.onopen = function () {
      statusDot.classList.remove("stale");
    };
  }

  // ---------------------------------------------------------------------

  buildTelemetryCard();
  loadCommands();
  refreshPorts();
  api("/api/status").then(function (body) { applyStatus(body.status); })
                    .catch(function () { /* server not ready yet; SSE will say */ });
  startStream();

  // The RFID cards have wall-clock-driven states (stale after N seconds
  // quiet, "NO TAG FOUND" after a one-shot's timeout) that must not wait on
  // the next telemetry packet to appear — the stream can legitimately go
  // quiet for stretches (README: "nothing here should ever interpret quiet
  // as broken"), and a one-shot's own telemetry can stop right as its
  // timeout elapses. A plain low-rate timer keeps those states honest even
  // when nothing is arriving over SSE.
  setInterval(function () { renderRfidCards(Date.now()); }, 500);
})();
