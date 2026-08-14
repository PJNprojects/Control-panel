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
  // Header slot SLEEP/WAKE's toggle control gets routed into instead of the
  // general commands grid - see the toggle_group === "power" special case in
  // loadCommands() below.
  var powerSlot   = el("power-slot");
  var rawText     = el("raw-text");
  var btnRaw      = el("btn-raw");
  var rawHint     = el("raw-hint");
  var logBox      = el("log");
  var telemetryBox = el("telemetry");
  var telemetryMeta = el("telemetry-meta");
  var autoscroll  = el("autoscroll");
  var btnClear    = el("btn-clear");

  var imuPanel      = el("imu-panel");
  var imuReplayBadge = el("imu-replay-badge");
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
  var scanMInput        = el("scan-m-input");
  var btnScanAutoToggle = el("btn-scan-auto-toggle");
  var scanAutoCountdown     = el("scan-auto-countdown");
  var scanAutoCountdownRing = el("auto-countdown-ring");
  var scanAutoCountdownText = el("auto-countdown-text");

  var imuLogBody         = el("imu-log-body");
  imuLogBody.dataset.empty = "1";
  var imuLogMeta          = el("imu-log-meta");
  var btnImuLogClear      = el("btn-imu-log-clear");
  var btnImuLogDownload   = el("btn-imu-log-download");
  var imuLogPeriodInput   = el("imu-log-period-input");
  var btnImuLogToggle     = el("btn-imu-log-toggle");

  var replayFileInput = el("replay-file");
  var btnReplayPlay   = el("btn-replay-play");
  var btnReplayStop   = el("btn-replay-stop");
  var replayScrub     = el("replay-scrub");
  var replayPosition  = el("replay-position");
  var replayMetaText  = el("replay-meta");

  // ---------------------------------------------------------------------
  //  BLE reconnect handling — the collar's node disconnects, rescans, and
  //  reconnects for every READ RFID (log evidence: "# CattleNode
  //  disconnected - rescanning..." through "# cmd: command channel ready on
  //  aa100002-...", a couple of seconds end to end). The command channel is
  //  gone for that whole window, so firing another READ RFID into it is
  //  pointless at best. The READ RFID button (and the auto-scan timer) are
  //  disabled between those two log lines.
  //
  //  rfidOnceButton is set later, when buildCommandControl() builds
  //  whichever registry entry declares rfid_scan_probe_param - data-driven,
  //  same as everywhere else, not a check for a command named "READ RFID".
  // ---------------------------------------------------------------------
  var BLE_DISCONNECT_MARKER  = /disconnected/i;
  var BLE_READY_MARKER       = /command channel ready/i;
  var BLE_RECONNECT_WATCHDOG_MS = 20000; // fail-safe if "ready" is ever missed/reworded

  var bleReconnecting            = false;
  var bleReconnectWatchdogId     = null;
  var rfidOnceButton             = null;
  var rfidOnceButtonDefaultText  = "";

  // Two independent reasons the button can be unavailable: BLE mid-reconnect
  // (see the block above), or a scan already pending (rfidScanPending(),
  // defined below near armRfidScan()). Both block sending a second READ RFID
  // into a state that can't cleanly resolve it - reconnect because the
  // command channel isn't there yet, pending because a second arm would
  // either overwrite or race the first scan's outcome. Declared here but
  // called from both places since it needs to react to either changing.
  function refreshRfidOnceAvailability() {
    if (!rfidOnceButton) { return; }
    var pending = rfidScanPending(); // function declaration below, hoisted - safe to call from here
    rfidOnceButton.disabled = bleReconnecting || pending;
    rfidOnceButton.textContent = bleReconnecting ? "Reconnecting…"
      : pending ? "Scanning…"
      : rfidOnceButtonDefaultText;
    // Green only for the idle/enabled state ("ready to press") - the
    // moment either blocker is true this class comes back off and the
    // button falls back to its ordinary .primary + :disabled look, which
    // this deliberately does not touch (see the rule's comment in
    // style.css).
    rfidOnceButton.classList.toggle("rfid-once-idle", !bleReconnecting && !pending);
  }

  function setBleReconnecting(isReconnecting) {
    if (bleReconnecting === isReconnecting) { return; }
    bleReconnecting = isReconnecting;
    refreshRfidOnceAvailability();

    if (bleReconnectWatchdogId !== null) {
      clearTimeout(bleReconnectWatchdogId);
      bleReconnectWatchdogId = null;
    }
    if (isReconnecting) {
      // CONFIRMED on real hardware: every single READ RFID makes the collar
      // actually disconnect and reconnect its BLE link once the scan is
      // done - that disconnect/rescan/reconnect cycle IS the scan, on the
      // collar side. So if a scan is currently armed, seeing THIS disconnect
      // fire is direct evidence that this specific armed scan has actually
      // run on the collar - not evidence of what it found, just evidence
      // the cycle happened at all. That is exactly the fact the FOUND-
      // resolution guard in updateImu() needs before it will trust a
      // resolving packet as belonging to this scan rather than being
      // carryover from whatever was true the instant before the button was
      // pressed. It doesn't matter that reconnect hasn't finished yet -
      // observing the disconnect itself is the signal, not the recovery.
      if (rfidScanPending()) { rfidPendingSawDisconnect = true; }
      localNote("collar BLE reconnecting - READ RFID disabled until the command channel is back", "info");
      bleReconnectWatchdogId = setTimeout(function () {
        setBleReconnecting(false);
        localNote("BLE reconnect watchdog timed out - re-enabling READ RFID as a fail-safe", "error");
      }, BLE_RECONNECT_WATCHDOG_MS);
    } else {
      // The link just settled - record when, so renderRfidCards()'s timeout
      // branch can give the actual resolving packet a short grace window to
      // arrive before it's allowed to conclude NO TAG. See
      // rfidLinkSettledAtMs's own comment for the bug this fixes: "the link
      // is back" is not the same fact as "this scan's result has arrived",
      // and treating them as the same fact was silently losing real finds.
      rfidLinkSettledAtMs = Date.now();

      // A scan whose attempt-timeout already elapsed may have been held back
      // waiting for exactly this (see the gate in renderRfidCards()) -
      // resolve it now instead of letting it sit until the next 500ms poll
      // tick. Latency only: the poll would have caught it anyway, which is
      // what keeps a held scan from ever hanging if this nudge is ever
      // missed.
      //
      // Deferred by a tick ON PURPOSE. One of the callers of
      // setBleReconnecting(false) is the telemetry branch of the stream
      // handler, which fires BEFORE that same record is parsed - and that
      // record may be the one carrying the tag. Resolving synchronously
      // there would log NO TAG a few lines before updateImu() got to see
      // the tag that was right there, which is precisely the misverdict
      // this whole change is meant to remove. Letting the current record
      // finish first means the FOUND path gets first refusal, and this
      // then finds nothing pending. The other caller is the "command
      // channel ready" LOG LINE, which has no such record about to run
      // right after it - that's exactly the case rfidLinkSettledAtMs's
      // grace window now covers, since this deferred call alone was never
      // enough to protect it.
      setTimeout(function () { renderRfidCards(Date.now()); }, 0);
    }
  }

  // Scans every '#' log line for the two markers. A normal telemetry record
  // arriving is an independent, even more direct signal that the link is
  // back - handled where the stream dispatches "telemetry" events.
  function watchLogForBleState(text) {
    if (!text) { return; }
    if (BLE_DISCONNECT_MARKER.test(text)) { setBleReconnecting(true); }
    else if (BLE_READY_MARKER.test(text)) { setBleReconnecting(false); }
  }

  // Only the gyro axes get a bar-graph element now (see the OLED port note
  // above updateImu) — ax/ay/az still flow into imuHistory/imuSmoothed for
  // the accel chart, they just don't have a bar to fill.
  var GYRO_BAR_KEYS = ["gx", "gy", "gz"];
  var barFill  = {}, barValue = {};
  GYRO_BAR_KEYS.forEach(function (key) {
    barFill[key]  = el("bar-" + key);
    barValue[key] = el("val-" + key);
  });
  // The two canvases themselves are looked up by createChartView() further
  // down, together with the scrollbar/pause/live controls that belong to the
  // same chart - one place that knows a chart's whole element set, rather
  // than two of its seven elements hoisted up here away from the rest.

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

  // The collar's temperature sensor reports in °C (that's what's on the
  // wire), but the panel is read by people on both sides of the °C/°F
  // divide - showing only one forces a mental conversion every single time
  // someone reads the number. One formula, called from every place a
  // temperature is rendered (highlight card, Scan History table + CSV,
  // Latest-reading grid), so there is exactly one spot to fix if it's ever
  // wrong rather than three copies quietly drifting apart.
  function celsiusToFahrenheit(c) { return c * 9 / 5 + 32; }

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  // DD-MM-YYYY HH:MM:SS, zero-padded, 24-hour - for ON-SCREEN display only
  // (the Scan History table). Deliberately NOT what the CSV export uses:
  // a file meant to be re-sorted/machine-read wants ISO-8601
  // (toISOString(), unambiguous, sorts as text), while a table meant to be
  // read by a person standing at the bench wants a format they don't have
  // to mentally reorder. Takes the same epoch-ms `ts` every scan already
  // carries (Date.now() at log time), so this is pure presentation - no new
  // data, just a different rendering of what's already stored.
  function formatDateTime(ms) {
    var d = new Date(ms);
    return pad2(d.getDate()) + "-" + pad2(d.getMonth() + 1) + "-" + d.getFullYear() +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
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

    // Data-driven hook, not a name check: whichever command declares
    // rfid_scan_probe_param is the one BLE-reconnect handling below needs
    // to disable, since it's the one that can trigger the collar's
    // disconnect/rescan/reconnect cycle.
    if (command.rfid_scan_probe_param) {
      rfidOnceButton = button;
      rfidOnceButtonDefaultText = command.label;
      refreshRfidOnceAvailability();
    }

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
      if (powerSlot) { powerSlot.innerHTML = ""; }

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
        // SLEEP/WAKE's toggle_group is "power" - route its built control
        // straight into the header's #power-slot instead of the general
        // commands grid. Keyed on the GROUP's own identity (the registry's
        // toggle_group value), not on a command name - this file still
        // doesn't know SLEEP or WAKE exist, only that this particular
        // toggle_group is the one the header wants. Any future toggle_group
        // that isn't "power" falls straight through to the normal grid
        // placement below, unaffected.
        if (key === "power" && powerSlot) {
          powerSlot.appendChild(tg.style === "slider"
            ? buildSliderControl(tg)
            : buildPressToggleControl(tg));
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
    { key: "rfid_valid",    label: "rfid valid", unit: "1 = confirmed" },
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
      } else if (field.key === "temperature" && typeof raw === "number") {
        // Temperature has no raw/scaled split the way accel/gyro do - the
        // wire value IS already real degrees C, nothing to convert FROM.
        // But it still gets a second unit line, same spirit as the fields
        // above: the raw cell-value stays °C exactly as sent, and the unit
        // line underneath adds the °F reading alongside it.
        cell.unit.textContent = field.unit + " / " + celsiusToFahrenheit(raw).toFixed(1) + "°F";
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
  //  The charts keep a bounded rolling BUFFER (IMU_HISTORY_LEN samples) in
  //  plain arrays and redraw a <canvas> each packet — not a growing log and
  //  not DOM rows, so memory and paint cost stay flat no matter how long the
  //  session runs. This is deliberately narrower than the "no history"
  //  stance in README.md for the log/telemetry card: that call was about a
  //  full-session transcript, this is a fixed-size recent-trend view.
  //
  //  RETAINED BUFFER vs VISIBLE WINDOW. These used to be the same number:
  //  the buffer held exactly what was drawn, so "look back a bit further"
  //  was not a thing that could be asked for - the older samples were gone,
  //  not merely off-screen. They are now two numbers. IMU_HISTORY_LEN is how
  //  much is KEPT, IMU_CHART_WINDOW is how much is SHOWN, and each chart
  //  carries an offset into the buffer that the scrollbar under it moves.
  //  Everything that made the old design cheap still holds: both numbers are
  //  hard caps, the arrays never grow past the first, and exactly one
  //  window's worth of points is ever drawn regardless of how much is kept.
  // ---------------------------------------------------------------------

  var IMU_CROSSHAIR_MAX_DEG = 45;   // pitch/roll swing mapped to full radius
  var IMU_CROSSHAIR_MAX_PX  = 55;   // stays inside the dial's inner ring
  var IMU_GRAVITY_MAX_MS2   = 20;   // bar full-scale (~2 g headroom)
  var IMU_ACCEL_RANGE_MS2   = 20;   // bar/chart full-scale for ax/ay/az, ±
  var IMU_GYRO_RANGE_RADS   = 5;    // bar/chart full-scale for gx/gy/gz, ±
  var IMU_BAR_TRACK_PX      = 90;   // must match .channel-track height in CSS
  var IMU_SMOOTHING_ALPHA   = 0.22; // EMA factor: lower = smoother, more lag
  // ~3000 samples at the observed ~570ms telemetry period is a bit under
  // half an hour of scrollback, in six Float arrays of 3000 numbers - tens
  // of KB, i.e. nothing. The visible window stays close to the old 150 so
  // the live picture reads the same as it always did; it's the scrollback
  // behind it that's new.
  var IMU_HISTORY_LEN       = 3000; // RETAINED samples per axis (hard cap)
  var IMU_CHART_WINDOW      = 300;  // samples DRAWN at once (the visible window)

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

  // Latest computed display values, kept for the Record IMU capture below
  // (it records "whatever the live path just derived", not a fresh
  // computation) - same smoothed/sticky numbers the dial and bars show, so a
  // recording never disagrees with the widget above it.
  //
  // These are always written from the LIVE telemetry path, including while a
  // replay is playing. That is deliberate and is the reason recording and
  // replay can run at the same time without fighting: the recorder is a tap
  // on the wire, not a screen-grab of the dial. If it read the widgets, a
  // replay would end up recorded into the next file as if the collar had
  // done it.
  var imuLatest = {
    yaw: null, pitch: null, roll: null, gravity: null,
    ax: null, ay: null, az: null, gx: null, gy: null, gz: null
  };

  // Whether the LIVE stream currently has a fresh gyro sample (i.e. whether
  // the dial should be lit or dimmed). Held as state rather than recomputed,
  // because a replay ending needs to restore the dial to the live picture
  // without waiting for the next packet to tell it what that picture was.
  var imuLiveActive = false;

  // Rolling history for the charts, same units as imuSmoothed. Carries the
  // last known value forward on a gap (IMU HALT) so the line visibly
  // flatlines instead of faking a drop to zero.
  var imuHistory = { ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };
  var IMU_SERIES_KEYS = ["ax", "ay", "az", "gx", "gy", "gz"];

  // --- temp / RFID: raw mirror + a scan-scoped held result --------------
  //
  // TWO DIFFERENT CONCEPTS LIVE HERE. Keeping them apart is the whole
  // design, because collapsing them is exactly what produced the bug this
  // panel spent several rounds chasing.
  //
  //   rfidCurrentId / rfidCurrentTemp  = "what does the wire say RIGHT NOW"
  //     Pure pass-through, zero memory: overwritten from every telemetry
  //     record, set to null the moment a record carries '-'. Nothing is
  //     carried forward, ever. This is the same policy pitch/roll/gravity
  //     use right above. Other consumers (Record IMU's per-record capture)
  //     legitimately want this raw view and read these directly.
  //
  //   rfidHeldResult                   = "how did the LAST SCAN come out"
  //     Written only when a scan resolves, cleared only when the next scan
  //     arms. This is not cached sensor data - it is a verdict, and a
  //     verdict is a thing that stays true until it is replaced.
  //
  // WHY THIS IS NOT A REVERT TO THE OLD STICKY CARD (2026-08-13)
  // On 2026-08-10 the operator killed every form of persistence here, and
  // was right to: at that point the panel had no way to tell "genuinely no
  // tag" from "a value the PC is repeating at you", so anything that
  // lingered on screen was indistinguishable from the bug. Two things
  // changed since:
  //
  //   1. Gateway V1.3.5 ships `rfid_valid` - an explicit per-record flag
  //      set by the collar's own 5-reads-in-2s confirmation logic. The
  //      panel no longer infers a verdict by string-comparing against '-';
  //      it is told one. (PROTOCOL_V10.md section 2.3 recommends exactly
  //      this.) That same firmware release also fixed the real upstream
  //      cause of the old stickiness: pre-V1.3.5, rfid_id/temperature were
  //      never reset once a tag was seen. Part of what was being chased
  //      from this side was never a PC-side cache at all.
  //   2. The operator asked for the verdict back, scoped: "so no tag can be
  //      easily detected now" - i.e. glance at the card at ANY time after a
  //      scan and see how that scan came out, not just in the instant it
  //      resolved.
  //
  // So the held result deliberately does NOT clear when an ordinary
  // rfid_valid=0 record arrives outside a scan. Outside a scan nothing is
  // reading, so those records say nothing about the last scan's outcome,
  // and letting them blank the card would defeat the entire point. The
  // holding is bounded and legible: it lasts exactly until the next scan
  // arms, which blanks it back to SCANNING… immediately. That is what
  // makes this different from the old sticky-forever card, which had no
  // event that ever cleared it.
  var RFID_ATTEMPT_MS        = 70;    // matches HANDOFF.md's "~70 ms each attempt"
  var RFID_TIMEOUT_BUFFER_MS = 400;   // slack for serial/BLE round trip + one telemetry period

  var rfidCurrentId    = null; // exactly the most recent record's rfid_id, or null - not sticky
  var rfidCurrentTemp  = null; // exactly the most recent record's temperature, or null - not sticky
  var rfidCurrentValid = false; // exactly the most recent record's rfid_valid flag - not sticky

  // The last resolved scan's verdict, or null if no scan has run yet this
  // session (the never-scanned idle state, which renders as '-'). Shape:
  //   { found: true,  id: "985141001320293", temp: 38.5, at: <ms> }
  //   { found: false, id: null,              temp: null, at: <ms> }
  var rfidHeldResult = null;
  var rfidOneShotDeadline = null; // wall-clock ms after which "no tag" fires, or null if not armed
  var rfidPendingSource   = null; // "manual" | "auto" - who armed the current pending scan, for the history log

  // Has THIS armed scan seen its own BLE disconnect yet? Set true in
  // setBleReconnecting()'s isReconnecting branch (see the comment there),
  // reset false every time a fresh scan is armed. Gates whether a
  // rfid_valid=1 record is trusted as THIS scan's verdict - see the guard in
  // updateImu()'s FOUND-resolution branch for the full reasoning and the
  // timeout-elapsed fallback that keeps this from ever hanging a scan
  // forever if the disconnect signal is somehow missed.
  var rfidPendingSawDisconnect = false;

  // 2026-08-14 ADDITION - fixes a real bug: scans that genuinely found a tag
  // were being logged as NO TAG anyway, even though the card updated to show
  // the tag correctly. Root cause was a gap this variable closes.
  //
  // "command channel ready" (which flips bleReconnecting back to false) is
  // printed by the GATEWAY the moment it finishes re-subscribing to notify -
  // that happens BEFORE the collar has necessarily sent its first fresh
  // packet post-reconnect, let alone before that packet has been printed to
  // serial and reached this tab as an SSE "telemetry" event. So
  // bleReconnecting going false is proof the LINK is back, not proof the
  // scan's actual result has arrived yet - there is a real, if usually
  // small, gap between the two.
  //
  // The old timeout branch in renderRfidCards() only checked bleReconnecting
  // and fired NO TAG the instant it saw false. When that happened to run
  // (the deferred nudge from setBleReconnecting(false), or the 500ms poll)
  // in that gap - after the link settled but before the resolving packet
  // had actually arrived - it declared NO TAG and cleared the pending scan.
  // The genuinely-found packet then showed up moments later, updated
  // rfidHeldResult (that update is unconditional, which is why the card
  // still looked right), but rfidOneShotDeadline was already null, so
  // logScanResult() was never reached. A real find, silently never logged.
  //
  // Fix: don't trust "the link is back" as "nothing more is coming" by
  // itself. Record WHEN it came back, and hold the timeout branch for one
  // more short grace window after that - long enough for one real
  // telemetry line to make the round trip and give the FOUND path (which
  // already gets first refusal - see setBleReconnecting()'s comment) an
  // actual chance to run before NO TAG is allowed to fire. Reset to null
  // whenever a fresh scan arms, same as rfidPendingSawDisconnect, so a
  // stale settle time from a PREVIOUS scan can't shorten a new one's grace
  // window.
  var rfidLinkSettledAtMs = null;
  var RFID_POST_RECONNECT_GRACE_MS = 600; // ~one telemetry round trip, not a scan-length wait

  // The attempt-timeout has elapsed but the collar's BLE link is still
  // mid-reconnect, so the scan is deliberately NOT resolved yet - see the
  // gate in renderRfidCards() for why. Display flag + the reason the card
  // says "WAITING LINK…" instead of "SCANNING…".
  var rfidResolveHeldForLink = false;

  // One log row per scan, guaranteed two ways, not just one:
  //  1. Only one scan is ever allowed to be pending at a time - armRfidScan()
  //     below refuses to arm a second one on top of an unresolved first, and
  //     every caller (manual button, auto-scan timer) checks
  //     rfidScanPending() before sending anything, so overlap shouldn't be
  //     possible in normal operation.
  //  2. Belt and suspenders: each armed scan gets a unique id, and
  //     logScanResult() below refuses to log the same id twice even if
  //     something upstream of it somehow calls it more than once for one
  //     scan. Given the fix was specifically asked for because a log looked
  //     replicated, "shouldn't be possible" wasn't good enough on its own.
  var rfidScanSeq          = 0;
  var rfidPendingScanId    = null; // id of the currently-armed, unresolved scan
  var rfidLastLoggedScanId = null; // id most recently written to history

  function rfidScanPending() { return rfidOneShotDeadline !== null; }

  // Arms both the highlight card's "no tag found" flash AND a scan-history
  // row - one probe, one outcome, recorded in both places. `source` is
  // which control fired the READ RFID <m> (see the Scan History section
  // below for where "manual" and "auto" come from).
  function armRfidScan(attempts, source) {
    if (!attempts || attempts <= 0) { return; }
    if (rfidScanPending()) {
      // Every caller is supposed to check rfidScanPending() first (and the
      // manual button / auto-scan timer are both disabled while pending),
      // so reaching this should be unreachable - refusing beats silently
      // overwriting a still-unresolved scan's deadline, which is exactly
      // the kind of thing that produces a misattributed second log row.
      localNote("a scan is already pending - not starting another", "error");
      return;
    }
    rfidScanSeq += 1;
    rfidPendingScanId = rfidScanSeq;
    var armedAt = Date.now();
    rfidOneShotDeadline = armedAt + attempts * RFID_ATTEMPT_MS + RFID_TIMEOUT_BUFFER_MS;
    rfidPendingSource = source;
    rfidResolveHeldForLink = false;
    // Freshly armed, so this scan hasn't seen its disconnect yet - see the
    // variable's own comment above for what this gates.
    rfidPendingSawDisconnect = false;
    rfidLinkSettledAtMs = null; // no stale grace window carried over from a previous scan
    // The ONLY thing that clears a held verdict. A new scan is starting, so
    // the previous scan's outcome stops being the answer to "what is on the
    // reader" and the card must not keep showing it while the new one runs.
    rfidHeldResult = null;
    refreshRfidOnceAvailability();
    renderRfidCards(armedAt); // show SCANNING… immediately, don't wait for the 500ms tick
  }

  var RFID_CARD_STATES = ["card-idle", "card-fresh", "card-scanning", "card-no-tag"];

  function setCardState(card, state) {
    RFID_CARD_STATES.forEach(function (c) { card.classList.remove(c); });
    card.classList.add(state);
  }

  function renderRfidCards(now) {
    var oneShotTimedOut = rfidOneShotDeadline !== null && now >= rfidOneShotDeadline;
    if (oneShotTimedOut) {
      // "Timed out" is necessary but NOT sufficient to call it "no tag".
      // rfidOneShotDeadline is a pure wall-clock budget started the instant
      // the command was POSTed, and pressing READ RFID also kicks the
      // collar's BLE link into disconnect/rescan/reconnect (a couple of
      // seconds). With a small m the budget can therefore expire while the
      // command channel is still coming back up - i.e. before the collar
      // has had any real chance to attempt a read - and logging "NO TAG"
      // there records a verdict about the link, not about the tag. So hold
      // the scan pending until the link has actually settled.
      //
      // This cannot hang: bleReconnecting is driven false by the "command
      // channel ready" log line, by any telemetry record arriving, or -
      // worst case, if both of those are missed - by the 20s watchdog in
      // setBleReconnecting(). Once it flips, this same branch resolves on
      // the next call, and there are two callers guaranteeing one: the
      // nudge from setBleReconnecting(false) and the 500ms poll at the
      // bottom of this file. Bound on a held scan is therefore the
      // attempt budget + at most ~20s + the grace window just below.
      //
      // 2026-08-14: bleReconnecting alone is NOT enough to conclude the
      // scan's result has arrived, only that the link has. "command channel
      // ready" prints as soon as this gateway re-subscribes to notify -
      // before the collar has necessarily sent, let alone this tab has
      // received, its first fresh post-reconnect packet. Firing NO TAG the
      // instant bleReconnecting went false was concluding "nothing found"
      // in that gap, on packets that hadn't arrived yet - a real find would
      // show up moments later, correctly update the held card (that part is
      // unconditional), but find rfidOneShotDeadline already cleared and
      // never get logged. See rfidLinkSettledAtMs's own comment for the
      // full story. So: hold not just while reconnecting, but for a short
      // grace window after the link settles too, giving one real telemetry
      // round trip a chance to land - and with it, the FOUND-resolution
      // branch a chance to claim this scan first, exactly as intended.
      var withinPostReconnectGrace = rfidLinkSettledAtMs !== null &&
        (now - rfidLinkSettledAtMs) < RFID_POST_RECONNECT_GRACE_MS;
      if (bleReconnecting || withinPostReconnectGrace) {
        rfidResolveHeldForLink = true;
      } else {
        rfidResolveHeldForLink = false;
        rfidOneShotDeadline = null;               // fires once
        // The scan resolved as "no tag". Two records of that, deliberately:
        // Scan History keeps the permanent, timestamped, downloadable one,
        // and the held result keeps the at-a-glance one on the card until
        // the next scan replaces it.
        rfidHeldResult = { found: false, id: null, temp: null, at: now };
        logScanResult(now, null, null, rfidPendingSource, null, rfidPendingScanId);
        rfidPendingSource = null;
        rfidPendingScanId = null;
        refreshRfidOnceAvailability();
      }
    }

    // One state drives both cards - temp and rfid_id come off the same tag
    // read, so they change together. Three states, in strict priority
    // order, and the order is the requirement:
    //
    //   1. a scan is running now          -> SCANNING… / WAITING LINK…
    //   2. a scan has run and resolved    -> that verdict, held
    //   3. no scan has ever run           -> '-'
    //
    // Note what is NOT in that list: the current telemetry record. The card
    // is intentionally not a live mirror of the wire anymore (see the long
    // comment on rfidHeldResult above) - it answers "how did the last scan
    // come out", and an ordinary rfid_valid=0 record arriving while nothing
    // is scanning is not an answer to that question. The raw per-record
    // view still exists for anyone who wants it: the latest-reading card's
    // rfid_id / rfid_valid cells.
    var state;

    if (rfidScanPending()) {
      state = "card-scanning";
      // Same pending state either way - the sub-label just tells the
      // operator WHY it's still spinning, so a long wait reads as "the
      // link hasn't come back yet", not "the panel is stuck".
      imuRfidValue.textContent = rfidResolveHeldForLink ? "WAITING LINK…" : "SCANNING…";
      imuRfidValue.classList.remove("none");
      imuRfidValue.classList.add("scanning");
    } else if (rfidHeldResult !== null && rfidHeldResult.found) {
      state = "card-fresh";
      imuRfidValue.textContent = rfidHeldResult.id;
      imuRfidValue.classList.remove("none", "scanning");
    } else if (rfidHeldResult !== null) {
      // Resolved, and the answer was "nothing there". Amber (--warn), not
      // red: a scan that finds no tag is a perfectly normal outcome, not a
      // fault - same reasoning as the NO TAG rows in Scan History, which
      // already use --warn, so the two readouts agree on colour. Distinct
      // from the grey '-' of state 3 on purpose: "we looked and there was
      // nothing" and "we have not looked yet" are different facts and the
      // operator asked to be able to tell them apart at a glance.
      state = "card-no-tag";
      imuRfidValue.textContent = "NO TAG";
      imuRfidValue.classList.remove("none", "scanning");
    } else {
      state = "card-idle";
      imuRfidValue.textContent = "-";
      imuRfidValue.classList.remove("scanning");
      imuRfidValue.classList.add("none");
    }
    setCardState(imuRfidCard, state);
    setCardState(imuTempCard, state);

    // Temp card doesn't repeat "SCANNING…" in text - the shared border
    // pulse (setCardState above) and the RFID card's own label already
    // say that; this cell just goes blank until there's a real reading.
    // It follows the held result for the same reason the id does: the
    // temperature came off the same tag read, so it is part of the same
    // verdict and has to be held or dropped with it, never separately.
    if (!rfidScanPending() && rfidHeldResult !== null
        && rfidHeldResult.temp !== null && rfidHeldResult.temp !== undefined) {
      imuTempValue.textContent = rfidHeldResult.temp.toFixed(1) + "°C / " +
        celsiusToFahrenheit(rfidHeldResult.temp).toFixed(1) + "°F";
      imuTempValue.classList.remove("none");
    } else {
      imuTempValue.textContent = "-";
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

  function logScanResult(now, tagId, temp, source, gwTs, scanId) {
    // Idempotent guard: if this scanId already produced a row, don't write a
    // second one. scanId is optional (only the two armRfidScan()-driven
    // resolution paths pass it) - null/undefined just skips the check, which
    // is fine, that's not the case that was producing duplicates.
    if (scanId !== null && scanId !== undefined && scanId === rfidLastLoggedScanId) {
      return;
    }
    if (scanId !== null && scanId !== undefined) { rfidLastLoggedScanId = scanId; }
    var entry = {
      ts: now,
      // The same per-scan counter armRfidScan() hands out (rfidScanSeq),
      // already used above for the idempotent dedup guard - stored here too
      // so it can finally be SHOWN, not just checked against. Gives every
      // row a stable, monotonically increasing "which attempt was this"
      // number that survives Clear/re-sort in a way a timestamp alone
      // doesn't (two scans a second apart still sort fine by ts, but the
      // seq is what an operator reads out loud on a call: "scan 47 came
      // back empty").
      seq: (scanId === null || scanId === undefined) ? null : scanId,
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

    var seqCell = document.createElement("td");
    seqCell.textContent = entry.seq !== null ? String(entry.seq) : "-";
    row.appendChild(seqCell);

    var timeCell = document.createElement("td");
    // DD-MM-YYYY HH:MM:SS, not toLocaleTimeString() - this is a table meant
    // to be read by a person at the bench, not sorted by a script (that's
    // what the CSV's ISO timestamp is for), and a real date+time beats a
    // locale-dependent time-only string once a session crosses midnight.
    timeCell.textContent = formatDateTime(entry.ts);
    row.appendChild(timeCell);

    var idCell = document.createElement("td");
    idCell.textContent = entry.found ? entry.tagId : "-";
    row.appendChild(idCell);

    var tempCell = document.createElement("td");
    tempCell.textContent = entry.temp !== null
      ? entry.temp.toFixed(1) + "°C / " + celsiusToFahrenheit(entry.temp).toFixed(1) + "°F"
      : "-";
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
    scanHistoryBody.innerHTML = '<tr><td colspan="7" class="muted">No scans logged yet.</td></tr>';
    scanHistoryBody.dataset.empty = "1";
    scanHistoryMeta.textContent = "0 scans logged";
  });

  function csvEscape(value) {
    var text = value === null || value === undefined ? "" : String(value);
    if (/[",\n]/.test(text)) { return '"' + text.replace(/"/g, '""') + '"'; }
    return text;
  }

  btnScanDownload.addEventListener("click", function () {
    var header = ["scan_seq", "time_iso", "tag_id", "temperature_c", "temperature_f",
      "result", "source", "gateway_timestamp_ms"];
    var lines = [header.join(",")];
    // Exported oldest-first - the natural order to read a CSV in a
    // spreadsheet, even though the table itself shows newest-first.
    // time_iso stays ISO-8601 (toISOString()) here even though the on-screen
    // table now shows DD-MM-YYYY HH:MM:SS - this file is meant to be
    // machine-read/sorted, and ISO is what sorts correctly as plain text and
    // parses unambiguously in a spreadsheet; the human-friendly format is
    // specifically for the table, not this export.
    for (var i = scanHistory.length - 1; i >= 0; i--) {
      var e = scanHistory[i];
      lines.push([
        e.seq !== null ? e.seq : "",
        new Date(e.ts).toISOString(),
        csvEscape(e.tagId),
        e.temp !== null ? e.temp.toFixed(1) : "",
        e.temp !== null ? celsiusToFahrenheit(e.temp).toFixed(1) : "",
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

  // --- Auto-scan: fires READ RFID 1 {m} on a timer (n is hardcoded to 1 in
  // the registry) and logs the result
  // through the exact same armRfidScan()/logScanResult() path as the
  // manual button, tagged source="auto" so the table shows which is which.
  var autoScanOn = false;
  var autoScanTimerId = null;

  // Countdown ring: a read-only visual of the SAME timer above, nothing
  // more. autoScanNextFireAt is the wall-clock ms the currently-scheduled
  // triggerAutoScan() call will fire (set in scheduleNextAutoScan(), the one
  // place that actually knows), and the text ticks off it on its own short
  // interval - separate from the CSS sweep animation, because sampling "how
  // far along is a CSS animation" back out in JS is not something the
  // platform makes cheap, while a few hundred ms of setInterval drift is
  // invisible to a human reading whole seconds.
  var AUTO_COUNTDOWN_TICK_MS = 250;
  var autoScanNextFireAt = null;
  var autoScanCountdownTickId = null;

  // Removing an animation, forcing a reflow, then re-adding it is the
  // standard way to restart a CSS animation from its own beginning - without
  // the forced reflow the browser can coalesce the "none" and the new
  // animation-name into one paint and the restart never visibly happens.
  // Called every time scheduleNextAutoScan() computes a fresh fire time
  // (i.e. once per real timer tick, not on some independent interval), which
  // is what keeps the ring's sweep honest about the actual timer instead of
  // free-running at whatever duration it started with.
  function restartCountdownRing(periodS) {
    scanAutoCountdownRing.style.animation = "none";
    void scanAutoCountdownRing.offsetWidth; // force reflow between remove and re-add
    scanAutoCountdownRing.style.animation = "auto-countdown-sweep " + periodS + "s linear forwards";
  }

  function updateAutoCountdownText() {
    if (autoScanNextFireAt === null) {
      scanAutoCountdownText.textContent = "-";
      return;
    }
    var remainingS = Math.max(0, Math.ceil((autoScanNextFireAt - Date.now()) / 1000));
    scanAutoCountdownText.textContent = remainingS + "s";
  }

  function triggerAutoScan() {
    if (bleReconnecting) {
      localNote("auto-scan: skipped this cycle - BLE still reconnecting", "info");
      return;
    }
    if (rfidScanPending()) {
      // A manual press (or the previous auto tick, on a short period) is
      // still unresolved. Firing another READ RFID on top of it is exactly
      // the overlap that was producing duplicate/misattributed Scan History
      // rows - skip this tick rather than stack a second arm on the first.
      localNote("auto-scan: skipped this cycle - previous scan still pending", "info");
      return;
    }
    // n is hardcoded to 1 in the registry now (commands.py) - not sent as a
    // param at all, since read_rfid_once no longer declares one.
    var m = parseInt(scanMInput.value, 10);
    if (isNaN(m)) {
      localNote("auto-scan: m must be a number", "error");
      return;
    }
    sendCommand("read_rfid_once", { m: m }, null).then(function (ok) {
      if (ok) { armRfidScan(m, "auto"); }
    });
  }

  function scheduleNextAutoScan() {
    if (!autoScanOn) { return; }
    var periodS = Math.max(2, parseInt(scanPeriodInput.value, 10) || 30);
    // This is the one place that actually knows the next fire time, so it's
    // also the one place that resyncs both countdown displays (the ring's
    // sweep and the "Ns" text's reference point) to it - see the two
    // functions' own comments for why they're driven from here rather than
    // free-running independently.
    autoScanNextFireAt = Date.now() + periodS * 1000;
    restartCountdownRing(periodS);
    autoScanTimerId = setTimeout(function () {
      triggerAutoScan();
      scheduleNextAutoScan();
    }, periodS * 1000);
  }

  btnScanAutoToggle.addEventListener("click", function () {
    autoScanOn = !autoScanOn;
    btnScanAutoToggle.classList.toggle("is-on", autoScanOn);
    btnScanAutoToggle.classList.toggle("is-off", !autoScanOn);
    scanAutoCountdown.classList.toggle("is-active", autoScanOn);
    if (autoScanOn) {
      var periodS = Math.max(2, parseInt(scanPeriodInput.value, 10) || 30);
      btnScanAutoToggle.textContent = "Stop Auto-Scan (every " + periodS + "s)";
      if (autoScanCountdownTickId !== null) { clearInterval(autoScanCountdownTickId); }
      autoScanCountdownTickId = setInterval(updateAutoCountdownText, AUTO_COUNTDOWN_TICK_MS);
      triggerAutoScan();          // fire the first one immediately, not after a full period's wait
      scheduleNextAutoScan();     // sets autoScanNextFireAt + starts the ring sweep
    } else {
      btnScanAutoToggle.textContent = "Start Auto-Scan";
      if (autoScanTimerId !== null) { clearTimeout(autoScanTimerId); autoScanTimerId = null; }
      if (autoScanCountdownTickId !== null) { clearInterval(autoScanCountdownTickId); autoScanCountdownTickId = null; }
      autoScanNextFireAt = null;
      updateAutoCountdownText();               // snaps the text back to "-"
      scanAutoCountdownRing.style.animation = "none"; // freeze/neutralize, not left sweeping while hidden
    }
  });

  // ---------------------------------------------------------------------
  //  Record IMU — captures ONE ROW PER TELEMETRY RECORD while recording
  //  (called from updateImu() below, at whatever rate the serial link
  //  actually delivers - full resolution, nothing skipped or sampled), and
  //  auto-saves on a timer: downloads the buffer as CSV, then clears it, so
  //  a long run doesn't sit unsaved in a tab that could get closed by
  //  accident. "Save Until Now" and stopping the recording both trigger the
  //  same save-and-clear on demand. Still browser-tab-only, for the same
  //  reason as the RFID auto-scan above (no new backend surface) - see that
  //  section's comment for the tradeoff that implies.
  //
  //  The variables below still say "imuLog" rather than "recording". That is
  //  not an oversight: the rename was for the OPERATOR-facing language (the
  //  panel heading, the buttons, the log notices), and churning a dozen
  //  identifiers across the file would have buried the parts of this change
  //  that actually do something in a diff full of noise. Where a comment
  //  said "IMU log" as a feature name it now says "recording"; where an
  //  identifier says imuLog it means "the buffer this panel fills".
  //
  //  WHAT THE FILE LOOKS LIKE, because replay parses back exactly this:
  //
  //    # imu_recording=1,avg_sample_rate_hz=1.752,samples=4211,...
  //    time_ms,yaw_deg,pitch_deg,...
  //    1755168000123,12.34,...
  //
  //  One '#'-prefixed metadata line, then the header, then rows oldest-first.
  //  See imuRecordingMetaLine() for the format's reasoning and parseImuCsv()
  //  for the other end of it - they are a matched pair and must be edited
  //  together.
  // ---------------------------------------------------------------------

  // Fail-safe ceiling only, not the normal operating point: at one row per
  // telemetry packet (~600ms) this would take ~3.5 hours to fill even if
  // auto-save is somehow never triggered.
  var IMU_LOG_MAX = 20000;
  var imuLog = [];   // newest first
  var imuLogOn = false;
  var imuAutosaveTimerId = null;

  function fmt(value, digits) {
    return value === null || value === undefined ? "" : value.toFixed(digits);
  }

  // Called from updateImu() for every telemetry record while imuLogOn.
  // Note `now` is Date.now() - PC wall clock, not the gateway's own
  // millis()-since-boot `timestamp` field. Wall clock is what makes a
  // recording line up with the Log panel, with Scan History, and with a
  // second recording made an hour later; the gateway's counter restarts at
  // every reboot and would make two files impossible to relate.
  function captureImuLogRow(now) {
    var entry = {
      ts: now,
      yaw: imuLatest.yaw, pitch: imuLatest.pitch, roll: imuLatest.roll, gravity: imuLatest.gravity,
      ax: imuLatest.ax, ay: imuLatest.ay, az: imuLatest.az,
      gx: imuLatest.gx, gy: imuLatest.gy, gz: imuLatest.gz
    };
    imuLog.unshift(entry);
    if (imuLog.length > IMU_LOG_MAX) { imuLog.length = IMU_LOG_MAX; }
    prependImuLogRow(entry);
    imuLogMeta.textContent = imuLog.length + " sample" + (imuLog.length === 1 ? "" : "s") + " buffered";
  }

  function prependImuLogRow(e) {
    if (imuLogBody.dataset.empty === "1") {
      imuLogBody.innerHTML = "";
      delete imuLogBody.dataset.empty;
    }
    var row = document.createElement("tr");
    var cells = [
      // Raw Unix epoch milliseconds, printed as-is. Deliberately NOT
      // formatDateTime() (Scan History's DD-MM-YYYY HH:MM:SS) and no longer
      // toLocaleTimeString(): this table's job is to be read against the CSV
      // it produces, and the CSV's time column now carries this identical
      // integer. Two rows differenced give the true sample interval in
      // milliseconds with no parsing and no locale in the way - which is the
      // number anyone squinting at this table is actually after. A
      // human-readable clock for "when did this happen" already exists two
      // panels down, on every Log row.
      String(e.ts),
      fmt(e.yaw, 1), fmt(e.pitch, 1), fmt(e.roll, 1), fmt(e.gravity, 2),
      fmt(e.ax, 2), fmt(e.ay, 2), fmt(e.az, 2),
      fmt(e.gx, 2), fmt(e.gy, 2), fmt(e.gz, 2)
    ];
    cells.forEach(function (text) {
      var td = document.createElement("td");
      td.textContent = text === "" ? "-" : text;
      row.appendChild(td);
    });
    imuLogBody.insertBefore(row, imuLogBody.firstChild);
    while (imuLogBody.childElementCount > IMU_LOG_MAX) {
      imuLogBody.removeChild(imuLogBody.lastChild);
    }
  }

  // The CSV's one metadata line, and half of a matched pair with
  // parseImuMetaLine() in the replay section below - change one, change both.
  //
  // WHY A COMMENT LINE AT ALL: CSV has no metadata slot. The sample rate is
  // not a property of any single row, it is a property of the recording, and
  // there is nowhere legitimate to put it. A '#'-prefixed line is this
  // project's existing convention for "this line is not data" - it is exactly
  // what the gateway's wire protocol does, and what the Log panel filters on
  // - so a reader who already knows this system reads it correctly on sight.
  // (Nothing on the gateway ever sees this file; the convention is borrowed
  // for familiarity, not for interoperability.) Spreadsheets import it as a
  // stray text row, which is ugly but harmless and, being comma-separated
  // key=value, still legible in that first row.
  //
  // FORMAT: "# " then comma-separated key=value pairs, values never
  // containing a comma or an '=' beyond the first. Parsing back out is
  // therefore split(",") then split at the first "=", with unknown keys
  // ignored and missing keys absent - so this line can gain fields later
  // without breaking any parser already in the wild.
  //
  // avg_sample_rate_hz is samples/duration_s as asked for. Strictly, N
  // samples span N-1 intervals, so the mean interval is duration/(N-1) and
  // this figure runs high by a factor of N/(N-1) - one part in 4211 on a
  // typical run, i.e. under a millisecond of drift per playback frame. It is
  // reported the simple way on purpose; samples and duration_s are both
  // written alongside it precisely so anyone who cares can recompute it
  // however they like, and so a human can eyeball "4211 samples over 341s,
  // yes, about 12 Hz" without trusting the division at all.
  function imuRecordingMetaLine(rows) {
    var n = rows.length;
    var first = n ? rows[0].ts : null;
    var last  = n ? rows[n - 1].ts : null;
    // Guarded, not assumed: a one-row buffer, or a clock that didn't move
    // between the first and last sample, has no rate. 0 is written rather
    // than NaN/Infinity so the field always parses as a number, and the
    // replay parser treats any non-positive rate as "no usable rate here,
    // fall back to per-row gaps" - see replayFrameMsFromMeta().
    var durationS = (n >= 2 && last > first) ? (last - first) / 1000 : 0;
    var hz = durationS > 0 ? n / durationS : 0;
    return "# imu_recording=1" +
      ",avg_sample_rate_hz=" + hz.toFixed(3) +
      ",samples=" + n +
      ",duration_s=" + durationS.toFixed(3) +
      ",first_ts_ms=" + (first === null ? "" : first) +
      ",last_ts_ms=" + (last === null ? "" : last);
  }

  function downloadImuLogCsv() {
    // Oldest-first in the file even though the buffer is newest-first. Done
    // once, up front, because the metadata line needs the same ordering the
    // rows are written in (first/last timestamp) and computing it off a
    // reversed loop index is the kind of thing that silently reports a
    // negative duration the day someone edits one of the two.
    var rows = imuLog.slice().reverse();

    var header = ["time_ms", "yaw_deg", "pitch_deg", "roll_deg", "gravity_ms2",
      "ax_ms2", "ay_ms2", "az_ms2", "gx_rads", "gy_rads", "gz_rads"];
    var lines = [imuRecordingMetaLine(rows), header.join(",")];
    for (var i = 0; i < rows.length; i++) {
      var e = rows[i];
      lines.push([
        // Unix epoch ms, integer, matching the on-screen table exactly.
        // Was toISOString(). ISO is the right call for Scan History's export
        // (a handful of rows a human sorts in a spreadsheet), and that one is
        // deliberately left alone - but this file is thousands of rows whose
        // whole point is the spacing BETWEEN them. An integer differences in
        // one step; an ISO string has to be parsed first, by every tool, in
        // every language, forever. It is also what replay reads back in.
        e.ts,
        fmt(e.yaw, 2), fmt(e.pitch, 2), fmt(e.roll, 2), fmt(e.gravity, 3),
        fmt(e.ax, 3), fmt(e.ay, 3), fmt(e.az, 3),
        fmt(e.gx, 4), fmt(e.gy, 4), fmt(e.gz, 4)
      ].join(","));
    }
    var blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = "imu_recording_" + stamp + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function clearImuLogBuffer() {
    imuLog = [];
    imuLogBody.innerHTML = '<tr><td colspan="11" class="muted">No samples logged yet.</td></tr>';
    imuLogBody.dataset.empty = "1";
    imuLogMeta.textContent = "0 samples buffered";
  }

  // The one path "Save Until Now", the auto-save timer, and stopping the
  // recording all go through - one file per chunk, buffer always empty right
  // after. Note what this deliberately does NOT do: touch imuLogOn. That is
  // the whole meaning of the "Save Until Now" rename - the tape gets cut, the
  // reel keeps turning, and the next sample lands in a fresh buffer that will
  // become the next file. Stopping is a separate action, on a separate
  // button, that happens to call this on its way out.
  function flushImuLog(reason) {
    if (imuLog.length === 0) {
      if (reason === "auto") { localNote("recording auto-save: nothing buffered, skipped", "info"); }
      return;
    }
    var count = imuLog.length;
    downloadImuLogCsv();
    clearImuLogBuffer();
    localNote("recording saved - " + count + " sample" + (count === 1 ? "" : "s") +
      " (" + reason + ")", "info");
  }

  btnImuLogClear.addEventListener("click", function () {
    // Discard, not save - matches the button's own tooltip. Different from
    // flushImuLog() on purpose: this one does NOT download anything.
    clearImuLogBuffer();
  });

  btnImuLogDownload.addEventListener("click", function () { flushImuLog("manual"); });

  function scheduleNextImuAutosave() {
    if (!imuLogOn) { return; }
    var periodMin = Math.max(1, parseInt(imuLogPeriodInput.value, 10) || 5);
    imuAutosaveTimerId = setTimeout(function () {
      flushImuLog("auto");
      scheduleNextImuAutosave();
    }, periodMin * 60 * 1000);
  }

  btnImuLogToggle.addEventListener("click", function () {
    imuLogOn = !imuLogOn;
    btnImuLogToggle.classList.toggle("is-on", imuLogOn);
    btnImuLogToggle.classList.toggle("is-off", !imuLogOn);
    if (imuLogOn) {
      var periodMin = Math.max(1, parseInt(imuLogPeriodInput.value, 10) || 5);
      // Present tense and an ellipsis: this label has to read as a state the
      // panel is IN, not an action available. Pressing it again stops and
      // saves, unchanged from before the rename.
      btnImuLogToggle.textContent = "Recording… (auto-save every " + periodMin + "m)";
      scheduleNextImuAutosave();
      // Capture itself starts happening on the next updateImu() call, not
      // here - it's driven by telemetry arriving, not by this timer.
    } else {
      btnImuLogToggle.textContent = "Record IMU";
      if (imuAutosaveTimerId !== null) { clearTimeout(imuAutosaveTimerId); imuAutosaveTimerId = null; }
      flushImuLog("stopped");   // don't lose whatever was captured since the last auto-save
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

  // Appends one sample to every live series in lock-step. Was six separate
  // pushHistory(key, value) calls; it is one call now because the buffer
  // reaching its cap has to be handled ONCE for all six - see the offset
  // fix-up at the bottom, which would otherwise run six times per packet and
  // scroll a pinned window six samples for every one that actually dropped.
  function pushLiveHistory(values) {
    var dropped = false;
    IMU_SERIES_KEYS.forEach(function (key) {
      var arr = imuHistory[key];
      var last = arr.length ? arr[arr.length - 1] : 0;
      var value = values[key];
      arr.push(value === null || value === undefined ? last : value);
      if (arr.length > IMU_HISTORY_LEN) { arr.shift(); dropped = true; }
    });

    // The buffer is full and just discarded its oldest sample, so every index
    // into it has shifted down by one. A chart that is FOLLOWING doesn't care
    // (its offset is recomputed from the end each draw), but a chart the
    // operator has scrolled back is pinned by index - leave the offset alone
    // and the window slides forward one sample per packet, i.e. the thing
    // they parked on drifts off the left edge on its own. Decrementing keeps
    // the pinned window showing the same DATA, which is what "I stopped it
    // here" means. Only meaningful for the live source; replay's buffer is
    // built once and never shifts.
    if (dropped && !replayActive) {
      chartViews.forEach(function (view) {
        if (!view.follow) { view.offset = Math.max(0, view.offset - 1); }
      });
    }
  }

  function wrapDeg(deg) { return ((deg % 360) + 360) % 360; }

  function renderYawDial(deg) {
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
    //
    // Replay has to satisfy the same invariant from a file that only stored
    // the WRAPPED yaw, which is what nextReplayDialDeg() below is for - it
    // rebuilds a continuous accumulator on the way in rather than making this
    // function tolerate a wrapped input, so there is still exactly one rule
    // here: whatever you pass in must be continuous.
    imuYawGroup.setAttribute("transform", "rotate(" + deg.toFixed(2) + " 110 110)");
    imuYawValue.textContent = wrapDeg(deg).toFixed(1) + "°";
  }

  // Suppresses the dial/crosshair CSS transition for exactly one committed
  // style change. For TELEPORTS only - seeking the replay scrubber, entering
  // replay, handing back to live - where the new angle is a different moment
  // in time rather than the collar having turned. Same remove/force-reflow/
  // re-add shape as restartCountdownRing() above, for the same reason:
  // without the forced reflow the browser coalesces both class changes into
  // one paint and the suppression never happens.
  function withoutDialTransition(paint) {
    imuDial.classList.add("no-anim");
    paint();
    void imuDial.offsetWidth;
    imuDial.classList.remove("no-anim");
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

  var CHART_COLORS = ["#4da3ff", "#4ccb7c", "#ffb347"]; // x, y, z — matches legend dots

  // ---------------------------------------------------------------------
  //  Charts: a movable window into a retained buffer
  //
  //  Each chart is a small state machine over three things:
  //
  //    paused - stop redrawing. New samples still arrive, still land in the
  //             buffer, and still update every other widget; this chart just
  //             stops painting, so a moment can be read instead of watched
  //             scrolling away. Nothing about capture is affected.
  //    follow - is the window pinned to the newest end of the buffer? True
  //             is the old, only behaviour and stays the default.
  //    offset - index of the leftmost drawn sample when it isn't.
  //
  //  Where the samples come from is a separate question, answered by
  //  chartSource(): the live buffer normally, the loaded recording while a
  //  replay owns the widgets. Both are "an object of six equal-length arrays
  //  plus a count of how many of them count as having arrived", so nothing
  //  below has to know which it is looking at.
  // ---------------------------------------------------------------------

  function chartSource() {
    if (replayActive) {
      // count, not length: everything past the playhead exists in the array
      // but hasn't been "played" yet, and drawing it would let the operator
      // see the future of the recording in the chart while the dial is still
      // in its past. Capping at the playhead makes the chart behave exactly
      // as it does live - it shows what has happened so far, and no more.
      return { series: replaySeries, count: clamp(replay.index + 1, 0, replayCount) };
    }
    return { series: imuHistory, count: imuHistory.ax.length };
  }

  // The canvas has no width attribute in the HTML - CSS gives it a fluid
  // width and this copies that measured width into the backing store so the
  // two stay 1:1. Without it the browser scales a fixed-size bitmap to fit,
  // which is the blurry-stretched-chart look. Cheap to call every draw: the
  // assignment (which also clears the canvas) only happens when the number
  // actually changed.
  function syncCanvasWidth(canvas) {
    var measured = Math.round(canvas.clientWidth);
    // clientWidth is 0 for a hidden element; a canvas of width 0 throws
    // nothing but draws nothing either, and would stick until the next
    // resize. The floor keeps a degenerate layout merely ugly, not blank.
    var target = Math.max(160, measured);
    if (canvas.width !== target) { canvas.width = target; }
  }

  function drawChartSeries(view) {
    var canvas = view.canvas;
    syncCanvasWidth(canvas);
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Zero line solid, half-scale lines dashed, full-scale printed in the
    // corners. The charts are tall enough now to read a value off rather
    // than just see a shape, which is only true if there is something to read
    // it against - an unlabelled trace is a shape no matter how big it gets.
    ctx.strokeStyle = "#2c3542";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "#232a33";
    [0.25, 0.75].forEach(function (fraction) {
      var y = Math.round(h * fraction) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    });
    ctx.restore();

    ctx.fillStyle = "#5a5a5a";
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("+" + view.range, 4, 3);
    ctx.textBaseline = "bottom";
    ctx.fillText("-" + view.range, 4, h - 3);

    var src = chartSource();
    var start = view.offset;
    var end = Math.min(src.count, start + IMU_CHART_WINDOW);
    // Denominator is the WINDOW, not the number of points actually present,
    // so a partially-filled buffer draws left-to-right at the same
    // time-per-pixel it will have once full - the trace grows into the chart
    // instead of stretching to fill it and re-scaling on every packet.
    var span = IMU_CHART_WINDOW - 1;

    view.keys.forEach(function (key, idx) {
      var series = src.series[key];
      if (!series || end - start < 2) { return; }
      ctx.strokeStyle = CHART_COLORS[idx];
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (var i = start; i < end; i++) {
        var x = ((i - start) / span) * w;
        var clamped = clamp(series[i], -view.range, view.range);
        var y = h / 2 - (clamped / view.range) * (h / 2);
        if (i === start) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    });
  }

  // Reconciles the scrollbar with the buffer. Called even for paused charts
  // (from renderCharts) so the range keeps growing under a frozen chart -
  // otherwise pausing would also freeze how far forward you're allowed to
  // scroll, and you could never reach the samples that arrived while frozen.
  function updateChartScroll(view) {
    var count = chartSource().count;
    var maxOffset = Math.max(0, count - IMU_CHART_WINDOW);
    view.offset = view.follow ? maxOffset : clamp(view.offset, 0, maxOffset);

    view.slider.max = String(maxOffset);
    view.slider.value = String(view.offset);
    view.slider.disabled = maxOffset === 0;

    var first = count === 0 ? 0 : view.offset + 1;
    var last = Math.min(count, view.offset + IMU_CHART_WINDOW);
    view.pos.textContent = count === 0
      ? "no samples"
      : first + "-" + last + " / " + count + (view.follow ? " (newest)" : " (held)");
    view.liveBtn.disabled = view.follow && !view.paused;
  }

  function drawChartView(view) {
    updateChartScroll(view);
    drawChartSeries(view);
  }

  // The per-packet entry point. Paused charts get their scrollbar reconciled
  // but not repainted - that IS the pause.
  function renderCharts() {
    chartViews.forEach(function (view) {
      if (view.paused) { updateChartScroll(view); return; }
      drawChartView(view);
    });
  }

  function applyChartButtonState(view) {
    view.pauseBtn.textContent = view.paused ? "Resume" : "Pause";
    view.pauseBtn.classList.toggle("is-paused", view.paused);
  }

  function setChartPaused(view, paused) {
    view.paused = paused;
    // Pausing pins the window where it stands - that is what freezing means,
    // and a "paused but still auto-scrolling" chart would be a contradiction.
    // Resuming snaps back to the newest samples, because that is the only
    // reading of the word "Resume" that matches the button next to it; an
    // operator who wants to resume live capture AND stay parked in the past
    // has the scrollbar for exactly that.
    view.follow = !paused;
    applyChartButtonState(view);
    drawChartView(view);
  }

  function createChartView(spec) {
    var view = {
      canvas: el("chart-" + spec.key),
      keys: spec.keys,
      range: spec.range,
      slider: el("scroll-chart-" + spec.key),
      pauseBtn: el("btn-chart-" + spec.key + "-pause"),
      liveBtn: el("btn-chart-" + spec.key + "-live"),
      pos: el("chart-" + spec.key + "-pos"),
      paused: false,
      follow: true,
      offset: 0
    };

    view.slider.addEventListener("input", function () {
      var value = parseInt(view.slider.value, 10);
      if (isNaN(value)) { return; }
      var maxOffset = parseInt(view.slider.max, 10) || 0;
      view.offset = clamp(value, 0, maxOffset);
      // Dropping the handle at the far right means "follow again" - but only
      // for a chart that isn't frozen. A paused chart stays pinned wherever
      // it was dropped even at the right-hand end, because un-freezing is the
      // Resume button's job and having the scrollbar silently do it too would
      // make a frozen chart start moving without anyone pressing anything.
      view.follow = !view.paused && value >= maxOffset;
      // Unconditional redraw, deliberately not routed through renderCharts():
      // dragging must move a PAUSED chart, or scrolling back through history
      // would only work on the one chart that's still live, which is exactly
      // backwards from what a pause is for.
      drawChartView(view);
    });

    view.pauseBtn.addEventListener("click", function () {
      setChartPaused(view, !view.paused);
    });

    view.liveBtn.addEventListener("click", function () {
      view.paused = false;
      view.follow = true;
      applyChartButtonState(view);
      drawChartView(view);
    });

    applyChartButtonState(view);
    return view;
  }

  var chartViews = [
    createChartView({ key: "accel", keys: ["ax", "ay", "az"], range: IMU_ACCEL_RANGE_MS2 }),
    createChartView({ key: "gyro",  keys: ["gx", "gy", "gz"], range: IMU_GYRO_RANGE_RADS })
  ];

  // The canvas backing store is sized from the element's measured width, so
  // it has to be re-measured whenever that width can change. Redraws every
  // chart including paused ones: a frozen chart still has to fill its new
  // box, and repainting the same frozen window at a new width shows the same
  // data - it does not un-freeze anything.
  window.addEventListener("resize", function () {
    chartViews.forEach(function (view) { drawChartView(view); });
  });

  // ---------------------------------------------------------------------
  //  applyImuSample — the ONE place the IMU widgets are painted
  //
  //  Live telemetry and replay both end here, and neither has a rendering
  //  path of its own. That is the entire point: two implementations of "draw
  //  a sample onto the dial" would agree on the day they were written and
  //  quietly diverge on every day after, and the failure mode is a replay
  //  that shows something the live view never would (or worse, the reverse),
  //  with nothing on screen to suggest which one is lying.
  //
  //  The split is derivation vs. presentation. Everything upstream - unit
  //  conversion, EMA smoothing, integrating gz into a yaw angle, subtracting
  //  the pitch/roll origin - is the LIVE path's job and lives in updateImu().
  //  A recording already went through all of that before it was written, so
  //  replay reads those numbers straight out of the file. By the time either
  //  caller reaches this function there is nothing left to compute, only to
  //  show, which is why this takes finished display values:
  //
  //    yawDial  - continuous, unbounded degrees (see renderYawDial)
  //    pitch,
  //    roll,
  //    gravity  - already origin-relative / already magnitudes, or null
  //    gx,gy,gz - rad/s for the bars, or null
  //    active   - is there a fresh gyro sample (dial lit) or not (dimmed)
  // ---------------------------------------------------------------------
  function applyImuSample(s) {
    setSignedBar("gx", s.gx, IMU_GYRO_RANGE_RADS);
    setSignedBar("gy", s.gy, IMU_GYRO_RANGE_RADS);
    setSignedBar("gz", s.gz, IMU_GYRO_RANGE_RADS);

    renderYawDial(s.yawDial);
    imuDial.classList.toggle("imu-inactive", !s.active);

    if (s.pitch !== null && s.roll !== null && s.gravity !== null) {
      var dx = clamp(s.roll / IMU_CROSSHAIR_MAX_DEG * IMU_CROSSHAIR_MAX_PX,
                      -IMU_CROSSHAIR_MAX_PX, IMU_CROSSHAIR_MAX_PX);
      var dy = clamp(-s.pitch / IMU_CROSSHAIR_MAX_DEG * IMU_CROSSHAIR_MAX_PX,
                      -IMU_CROSSHAIR_MAX_PX, IMU_CROSSHAIR_MAX_PX);
      imuCrosshair.setAttribute("transform", "translate(" + dx.toFixed(1) + " " + dy.toFixed(1) + ")");
      imuPitchValue.textContent = s.pitch.toFixed(1) + "°";
      imuRollValue.textContent  = s.roll.toFixed(1) + "°";

      var pct = clamp(s.gravity / IMU_GRAVITY_MAX_MS2 * 100, 0, 100);
      gravityFill.style.height = pct + "%";
      gravityValue.textContent = s.gravity.toFixed(2) + " m/s²";
    } else {
      imuCrosshair.removeAttribute("transform");
      imuPitchValue.textContent = "-";
      imuRollValue.textContent = "-";
      gravityFill.style.height = "0%";
      gravityValue.textContent = "-";
    }

    // The charts read their own buffer rather than this sample - they draw a
    // window, not a point - but they are painted from here so that "show one
    // sample" is a single call with a single meaning for both callers.
    renderCharts();
  }

  // ---------------------------------------------------------------------
  //  Replay — play a saved Record IMU CSV back through the live widgets
  //
  //  Entirely client-side: FileReader + <input type="file">, no upload, no
  //  Flask route, no file leaving the machine. Same "vanilla JS, no build
  //  step, no new backend surface" line the RFID scan history holds.
  //
  //  SCOPE, stated narrowly because the value of this feature depends on it:
  //  a replay drives the yaw dial, the pitch/roll crosshair, the gravity bar,
  //  the three gyro bars, and the two charts. Nothing else. The Latest
  //  Reading grid, the Log panel and Scan History keep showing the live
  //  collar throughout, and the SSE stream is never touched - not paused, not
  //  disconnected, not filtered. The ONLY mechanism is the replayActive flag
  //  the live render call in updateImu() checks before painting. Anything
  //  RFID-shaped is out of scope by construction rather than by rule: the
  //  recorder stopped capturing temp/rfid columns a revision ago, so a
  //  recording has nothing of the sort in it to replay.
  //
  //  TIMING, and why there are two paths into one loop. The operator asked
  //  for playback stepped at ONE constant rate taken from the recording's
  //  metadata, not at each row's own real-world gap - so a file with a
  //  metadata line plays at exactly 1000/avg_sample_rate_hz per frame, evenly,
  //  and a stutter in the original serial link doesn't come back as a stutter
  //  on screen. A file WITHOUT that line (an export from before this feature,
  //  or one someone hand-edited) is not refused: it falls back to the gap
  //  between consecutive row timestamps. Both feed the same stepper and the
  //  same render call - the ONLY difference between them is where the number
  //  of milliseconds until the next frame comes from.
  // ---------------------------------------------------------------------

  // Frame intervals are clamped into this band.
  //
  // The floor is one display frame. A recording at 200 Hz would ask for a 5ms
  // step, and every one of those steps redraws two canvases and the dial for
  // a picture the monitor cannot show - the eye gets nothing and the CPU pays
  // for all of it. Playback of a faster-than-60Hz recording is therefore
  // slower than the wall clock it was captured against, which is a real
  // tradeoff and the right one: the alternative is dropping frames the
  // operator asked to see. The collar's actual telemetry period is ~570ms, so
  // nothing on this hardware comes close to the floor anyway.
  //
  // The ceiling matters for the per-row fallback path, where the gap is
  // whatever really happened: a file spanning a sleep, a disconnect, or a
  // hand-edited row can carry a gap of minutes, and honouring it literally
  // would leave the panel looking dead. Two seconds renders that as a
  // noticeable pause instead.
  var REPLAY_MIN_FRAME_MS = 16;
  var REPLAY_MAX_FRAME_MS = 2000;

  // The flag the live path checks. Nothing else about the stream changes.
  var replayActive = false;

  // The loaded recording's six axis series, prebuilt in full at load time
  // rather than pushed one frame at a time. That is what makes seeking work:
  // the charts can render any window of a scrubbed-to position instantly,
  // including one the playhead has never reached in this pass, because the
  // data is already there - an incrementally-appended buffer would have to
  // be rebuilt from scratch on every backwards drag of the scrubber.
  var replaySeries = { ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };
  var replayCount = 0;

  // The replay dial's own continuous yaw accumulator. A recording stores yaw
  // WRAPPED into [0,360) (that's what was on screen), and renderYawDial()
  // requires a continuous angle - see its comment for why. This is rebuilt
  // frame by frame by nextReplayDialDeg() taking the shortest way round from
  // wherever the dial currently is, which handles both cases in one rule:
  // sequential playback moves a fraction of a degree at a time, and a scrub
  // across the whole file moves at most 180°, never the long way.
  var replayDialDeg = null;

  var replay = {
    samples: [],   // oldest first, exactly the order the CSV is written in
    index: 0,      // playhead
    playing: false,
    timerId: null,
    frameMs: null, // constant step from metadata, or null = per-row gaps
    meta: null,
    name: ""
  };

  // True while the operator is physically dragging the scrub handle. During
  // playback the stepper writes the handle's position on every frame, which
  // would fight a drag in progress and make the control feel like it's
  // snapping back - so the stepper's writes are suppressed for the duration
  // of the drag. It still renders the frames; it just doesn't move the thing
  // the mouse is holding.
  var replayScrubbing = false;

  // --- CSV parsing ------------------------------------------------------
  //
  // Column mapping is BY HEADER NAME, not by position, and each field
  // accepts its historical spellings. That costs a few lines here and buys
  // the ability to open a file exported by an older build of this panel
  // (time_iso rather than time_ms) without a conversion step, which is
  // exactly the sort of file someone will want to look at.
  var IMU_CSV_COLUMNS = {
    ts:      ["time_ms", "time_iso", "time", "timestamp"],
    yaw:     ["yaw_deg", "yaw"],
    pitch:   ["pitch_deg", "pitch"],
    roll:    ["roll_deg", "roll"],
    gravity: ["gravity_ms2", "gravity"],
    ax: ["ax_ms2", "ax"], ay: ["ay_ms2", "ay"], az: ["az_ms2", "az"],
    gx: ["gx_rads", "gx"], gy: ["gy_rads", "gy"], gz: ["gz_rads", "gz"]
  };

  // Last-resort fallback for a file whose header row was deleted: assume the
  // exact order downloadImuLogCsv() writes. Must stay in step with that
  // function's `header` array.
  var IMU_CSV_DEFAULT_ORDER =
    ["ts", "yaw", "pitch", "roll", "gravity", "ax", "ay", "az", "gx", "gy", "gz"];

  // "# imu_recording=1,avg_sample_rate_hz=1.752,samples=4211,..." -> object.
  // Unknown keys are kept (harmless), keys without an '=' are dropped, and a
  // value may contain '=' since only the first one splits. See
  // imuRecordingMetaLine() for the writing half.
  function parseImuMetaLine(line) {
    var out = {};
    line.replace(/^#+\s*/, "").split(",").forEach(function (part) {
      var at = part.indexOf("=");
      if (at <= 0) { return; }
      out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    });
    return out;
  }

  function mapImuCsvHeader(fields) {
    var lower = fields.map(function (f) { return f.trim().toLowerCase(); });
    var index = {};
    Object.keys(IMU_CSV_COLUMNS).forEach(function (key) {
      var found = -1;
      IMU_CSV_COLUMNS[key].forEach(function (name) {
        if (found === -1) { found = lower.indexOf(name); }
      });
      index[key] = found;
    });
    return index;
  }

  function positionalImuCsvIndex() {
    var index = {};
    IMU_CSV_DEFAULT_ORDER.forEach(function (key, at) { index[key] = at; });
    return index;
  }

  // Accepts both spellings this panel has ever written: a bare epoch-ms
  // integer (current) and an ISO-8601 string (pre-rename exports). Anything
  // else is a row we can't place in time, and parseImuCsv() drops it rather
  // than guessing.
  function parseTimestampCell(text) {
    if (text === null || text === undefined) { return null; }
    var trimmed = String(text).trim();
    if (trimmed === "") { return null; }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) { return Math.round(Number(trimmed)); }
    var parsed = Date.parse(trimmed);
    return isNaN(parsed) ? null : parsed;
  }

  // "" and "-" both mean "the collar didn't say" - fmt() writes the first for
  // a null and the table shows the second, so a hand-edited file can contain
  // either. Both come back as null, which is the same sentinel the live path
  // uses, so a gap in a recording flatlines the chart exactly as a gap in
  // live telemetry does.
  function parseNumCell(text) {
    if (text === null || text === undefined) { return null; }
    var trimmed = String(text).trim();
    if (trimmed === "" || trimmed === "-") { return null; }
    var value = Number(trimmed);
    return isNaN(value) ? null : value;
  }

  // Plain split(","), no quote handling: every column this writer emits is a
  // number or an empty string, so there is nothing that can contain a comma.
  // If that ever stops being true, this is the line to fix.
  function parseImuCsv(text) {
    var lines = String(text).split(/\r\n|\n|\r/);
    var meta = null;
    var index = null;
    var samples = [];
    var skipped = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.trim()) { continue; }

      if (line.charAt(0) === "#") {
        // First comment line wins. Later ones are ignored rather than
        // merged: two metadata lines means someone concatenated two
        // recordings, and silently averaging their rates would produce a
        // playback speed that matches neither half.
        if (meta === null) { meta = parseImuMetaLine(line); }
        continue;
      }

      var fields = line.split(",");
      if (index === null) {
        // A leading letter or underscore in the first field means this is the
        // header row. Everything this file ever puts in column 0 otherwise is
        // a number (epoch ms) or an ISO timestamp, which starts with a digit.
        if (/^[A-Za-z_]/.test(fields[0].trim())) {
          index = mapImuCsvHeader(fields);
          continue;
        }
        index = positionalImuCsvIndex();
        // deliberate fall-through: this line is data, not a header
      }

      var cell = function (key) {
        var at = index[key];
        return (at >= 0 && at < fields.length) ? fields[at] : null;
      };

      var ts = parseTimestampCell(cell("ts"));
      if (ts === null) { skipped += 1; continue; }

      samples.push({
        ts: ts,
        yaw: parseNumCell(cell("yaw")),
        pitch: parseNumCell(cell("pitch")),
        roll: parseNumCell(cell("roll")),
        gravity: parseNumCell(cell("gravity")),
        ax: parseNumCell(cell("ax")), ay: parseNumCell(cell("ay")), az: parseNumCell(cell("az")),
        gx: parseNumCell(cell("gx")), gy: parseNumCell(cell("gy")), gz: parseNumCell(cell("gz"))
      });
    }

    return { samples: samples, meta: meta, skipped: skipped };
  }

  // Metadata present and usable -> one constant frame interval, which is the
  // mode that was actually asked for. Absent, malformed, or a non-positive
  // rate (which imuRecordingMetaLine() writes for a recording too short to
  // have one) -> null, and replayIntervalAt() falls back to per-row gaps.
  function replayFrameMsFromMeta(meta) {
    if (!meta) { return null; }
    var hz = Number(meta.avg_sample_rate_hz);
    if (!isFinite(hz) || hz <= 0) { return null; }
    return clamp(1000 / hz, REPLAY_MIN_FRAME_MS, REPLAY_MAX_FRAME_MS);
  }

  function replayIntervalAt(i) {
    if (replay.frameMs !== null) { return replay.frameMs; }
    var here = replay.samples[i];
    var next = replay.samples[i + 1];
    if (!here || !next) { return 200; }
    return clamp(next.ts - here.ts, REPLAY_MIN_FRAME_MS, REPLAY_MAX_FRAME_MS);
  }

  // Same carry-forward-on-null rule pushLiveHistory() uses, so a gap in a
  // recording draws the same flatline it drew live when it was captured.
  function buildReplaySeries() {
    IMU_SERIES_KEYS.forEach(function (key) { replaySeries[key] = []; });
    replay.samples.forEach(function (sample) {
      IMU_SERIES_KEYS.forEach(function (key) {
        var arr = replaySeries[key];
        var value = sample[key];
        arr.push(value === null || value === undefined
          ? (arr.length ? arr[arr.length - 1] : 0)
          : value);
      });
    });
    replayCount = replay.samples.length;
  }

  // Shortest-way-round from wherever the dial is now to the wrapped angle
  // this frame recorded. See replayDialDeg's declaration for why the file
  // can't just store a continuous angle.
  function nextReplayDialDeg(wrapped) {
    if (wrapped === null || wrapped === undefined) {
      // No yaw in this row: hold the needle rather than snapping to north,
      // matching how the live dial freezes (and dims) on a gap.
      return replayDialDeg === null ? 0 : replayDialDeg;
    }
    if (replayDialDeg === null) { replayDialDeg = wrapped; return replayDialDeg; }
    var delta = wrapped - wrapDeg(replayDialDeg);
    while (delta > 180)  { delta -= 360; }
    while (delta < -180) { delta += 360; }
    replayDialDeg += delta;
    return replayDialDeg;
  }

  // --- ownership of the widgets ----------------------------------------

  // Called whenever the charts' underlying data changes identity: entering or
  // leaving replay, and loading a different recording while already in it.
  // Both a scrolled-back offset and a frozen frame stop meaning what they
  // meant the moment that happens - the offset now indexes a completely
  // different array, and the frozen picture is of data this panel is no
  // longer claiming to show. A chart left frozen on live telemetry, sitting
  // under a REPLAY badge, is exactly the ambiguity that badge exists to
  // remove, so a source swap is the one thing allowed to overrule a pause:
  // the pause was over data that just left the screen.
  function resetChartViewsToEdge() {
    chartViews.forEach(function (view) {
      view.paused = false;
      view.follow = true;
      view.offset = 0;
      applyChartButtonState(view);
    });
  }

  function setReplayActive(on) {
    if (replayActive === on) { return; }
    replayActive = on;
    imuReplayBadge.classList.toggle("is-active", on);
    imuPanel.classList.toggle("is-replaying", on);

    // The dial is about to be driven by a different, unrelated angle
    // sequence; re-anchoring means the first frame after the switch lands
    // wherever it lands instead of the needle sweeping there from the other
    // source's last value.
    replayDialDeg = null;

    resetChartViewsToEdge();

    if (!on) {
      // Hand back immediately with the last known live values rather than
      // leaving the final replayed frame sitting on screen until the next
      // packet happens to arrive - which, if the collar is asleep or halted,
      // could be never.
      withoutDialTransition(function () {
        applyImuSample({
          yawDial: imuYawDeg,
          pitch: imuLatest.pitch,
          roll: imuLatest.roll,
          gravity: imuLatest.gravity,
          gx: imuLatest.gx, gy: imuLatest.gy, gz: imuLatest.gz,
          active: imuLiveActive
        });
      });
    }
  }

  // --- transport --------------------------------------------------------

  function updateReplayPositionText() {
    if (!replay.samples.length) {
      replayPosition.textContent = "no recording loaded";
      return;
    }
    var sample = replay.samples[replay.index];
    var elapsedS = (sample.ts - replay.samples[0].ts) / 1000;
    replayPosition.textContent =
      (replay.index + 1) + " / " + replay.samples.length + "  ·  t+" + elapsedS.toFixed(1) + "s";
  }

  function applyReplayControlState() {
    var loaded = replay.samples.length > 0;
    btnReplayPlay.disabled = !loaded;
    btnReplayStop.disabled = !loaded || !replayActive;
    replayScrub.disabled = !loaded;
    replayScrub.max = String(Math.max(0, replay.samples.length - 1));
    btnReplayPlay.textContent = replay.playing ? "Pause" : "Play";
    btnReplayPlay.classList.toggle("is-playing", replay.playing);
    updateReplayPositionText();
  }

  // Paints the frame at the playhead. `isJump` distinguishes a seek (scrub
  // drag, entering replay) from ordinary stepping - a seek suppresses the
  // dial's CSS transition, because moving 40 seconds through a recording is
  // not the collar rotating and drawing it as a rotation would be a lie the
  // eye believes.
  function renderReplayFrame(isJump) {
    var sample = replay.samples[replay.index];
    if (!sample) { return; }

    var paint = function () {
      applyImuSample({
        yawDial: nextReplayDialDeg(sample.yaw),
        pitch: sample.pitch,
        roll: sample.roll,
        gravity: sample.gravity,
        gx: sample.gx, gy: sample.gy, gz: sample.gz,
        // Faithful to what was recorded: a row captured while the IMU was
        // halted has a null gz, and the dial dims for it here exactly as it
        // dimmed live at the moment it was written.
        active: sample.gz !== null
      });
    };

    if (isJump) { withoutDialTransition(paint); } else { paint(); }

    if (!replayScrubbing) { replayScrub.value = String(replay.index); }
    updateReplayPositionText();
  }

  function replaySeek(index, isJump) {
    if (!replay.samples.length) { return; }
    replay.index = clamp(Math.round(index), 0, replay.samples.length - 1);
    renderReplayFrame(isJump);
  }

  function replayScheduleNext() {
    if (!replay.playing) { return; }
    replay.timerId = setTimeout(function () {
      replay.timerId = null;
      if (!replay.playing) { return; }
      if (replay.index >= replay.samples.length - 1) {
        // Pause at the end rather than loop or stop. Looping would make it
        // impossible to tell a short recording from a stuck one, and stopping
        // would yank the widgets back to live the moment the interesting part
        // finished, which is the opposite of what someone watching it wants.
        replayPause();
        localNote("replay reached the end of the recording", "info");
        return;
      }
      replaySeek(replay.index + 1, false);
      replayScheduleNext();
    }, replayIntervalAt(replay.index));
  }

  function replayPause() {
    replay.playing = false;
    if (replay.timerId !== null) { clearTimeout(replay.timerId); replay.timerId = null; }
    applyReplayControlState();
  }

  function replayPlay() {
    if (!replay.samples.length) { return; }
    setReplayActive(true);
    // Pressing Play while parked on the last frame means "again", not
    // "advance zero frames and stop".
    if (replay.index >= replay.samples.length - 1) { replay.index = 0; }
    // Paint the playhead BEFORE the first timer tick. Without this, pressing
    // Play after a Stop would leave the last LIVE picture sitting on the
    // widgets underneath a REPLAY badge for up to one whole frame interval -
    // precisely the "is this the collar or a recording?" ambiguity the badge
    // exists to remove.
    renderReplayFrame(true);
    replay.playing = true;
    applyReplayControlState();
    replayScheduleNext();
  }

  function stopReplay(reason) {
    replayPause();
    setReplayActive(false);
    // The file stays loaded on purpose - Stop is "give the dial back", not
    // "eject". Pressing Play again re-takes the widgets from wherever the
    // playhead was left.
    applyReplayControlState();
    localNote("replay " + reason + " - IMU widgets back on live telemetry", "info");
  }

  function loadReplayCsv(text, name) {
    var parsed = parseImuCsv(text);

    if (parsed.samples.length < 2) {
      localNote("replay: " + name + " has " + parsed.samples.length +
        " usable sample rows - nothing to play", "error");
      return;
    }

    // Any previous playback is torn down BEFORE the new file is installed,
    // so a running timer can't fire once against the new sample array with
    // the old file's index.
    replayPause();

    replay.samples = parsed.samples;
    replay.meta = parsed.meta;
    replay.name = name;
    replay.index = 0;
    replay.frameMs = replayFrameMsFromMeta(parsed.meta);
    buildReplaySeries();

    // Done explicitly rather than left to setReplayActive() below, which is a
    // no-op when a replay is ALREADY running - loading a second file straight
    // over the first is exactly the case where a stale dial anchor and a
    // stale chart offset would otherwise survive into the new recording.
    replayDialDeg = null;
    resetChartViewsToEdge();

    var timingNote = replay.frameMs !== null
      ? (1000 / replay.frameMs).toFixed(2) + " Hz (metadata)"
      : "per-row gaps (no metadata line)";
    replayMetaText.textContent =
      name + " · " + parsed.samples.length + " samples · " + timingNote;

    // Loading takes the widgets immediately, paused on frame 0. The
    // alternative - stay live until Play is pressed - means the scrubber does
    // nothing visible until then, and it also leaves the operator staring at
    // a live dial one second after asking to look at a recording, which reads
    // as "the file didn't load".
    setReplayActive(true);
    replaySeek(0, true);
    applyReplayControlState();

    localNote("replay loaded " + name + " - " + parsed.samples.length + " samples, " +
      timingNote + (parsed.skipped ? ", " + parsed.skipped + " unparseable row(s) skipped" : ""),
      "info");
  }

  replayFileInput.addEventListener("change", function () {
    var file = replayFileInput.files && replayFileInput.files[0];
    if (!file) { return; }
    var reader = new FileReader();
    reader.onerror = function () {
      localNote("replay: could not read " + file.name, "error");
    };
    reader.onload = function () { loadReplayCsv(String(reader.result), file.name); };
    reader.readAsText(file);
    // Cleared so that re-picking the SAME file fires "change" again - without
    // this, reloading a file you just overwrote on disk silently does nothing.
    replayFileInput.value = "";
  });

  btnReplayPlay.addEventListener("click", function () {
    if (replay.playing) { replayPause(); } else { replayPlay(); }
  });

  btnReplayStop.addEventListener("click", function () { stopReplay("stopped"); });

  replayScrub.addEventListener("input", function () {
    var value = parseInt(replayScrub.value, 10);
    if (isNaN(value)) { return; }
    // Dragging while playing is allowed and keeps playing - the stepper picks
    // up from wherever the handle was dropped on its next tick, because it
    // reads replay.index rather than carrying an index of its own.
    if (!replayActive) { setReplayActive(true); }
    replaySeek(value, true);
  });

  // Pointer events rather than mousedown/mouseup so a touchscreen or pen drag
  // suppresses the stepper's write-back the same way a mouse drag does. The
  // release listener is on window because a drag very often ends with the
  // cursor somewhere else entirely.
  replayScrub.addEventListener("pointerdown", function () { replayScrubbing = true; });
  window.addEventListener("pointerup", function () { replayScrubbing = false; });
  window.addEventListener("pointercancel", function () { replayScrubbing = false; });

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

    imuLatest.ax = axV; imuLatest.ay = ayV; imuLatest.az = azV;
    imuLatest.gx = gxV; imuLatest.gy = gyV; imuLatest.gz = gzV;

    // Capture into the live buffer happens unconditionally, including while
    // a replay owns the widgets. Replay suspends DRAWING live data, not
    // collecting it - a scrollback buffer with a hole in it wherever someone
    // reviewed a recording would be worse than useless, and stopping the
    // replay would then reveal a gap that never happened on the wire.
    pushLiveHistory({ ax: axV, ay: ayV, az: azV, gx: gxV, gy: gyV, gz: gzV });

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
        // No modulo here — see the comment in renderYawDial() for why the
        // accumulator has to stay unbounded.
        imuYawDeg -= gzV * dtSec * (180 / Math.PI);
      }
      imuLastGyroTs = ts;
      imuLiveActive = true;
    } else {
      imuLiveActive = false;
    }
    imuLatest.yaw = wrapDeg(imuYawDeg);

    // --- pitch/roll + gravity magnitude, all from the smoothed accel vector.
    if (axV !== null && ayV !== null && azV !== null) {
      var pitchDeg = Math.atan2(-axV, Math.sqrt(ayV * ayV + azV * azV)) * (180 / Math.PI);
      var rollDeg  = Math.atan2(ayV, azV) * (180 / Math.PI);

      if (!imuHasOrigin) {
        imuPitchOrigin = pitchDeg;
        imuRollOrigin  = rollDeg;
        imuHasOrigin = true;
      }

      imuLatest.pitch = pitchDeg - imuPitchOrigin;
      imuLatest.roll  = rollDeg - imuRollOrigin;
      imuLatest.gravity = Math.sqrt(axV * axV + ayV * ayV + azV * azV);
    } else {
      imuLatest.pitch = null;
      imuLatest.roll = null;
      imuLatest.gravity = null;
    }

    // Everything above this line DERIVES; nothing above it draws. The single
    // call below is the only place the live path touches the IMU widgets,
    // and skipping it is the whole of "replay owns the dial" - the stream is
    // never disconnected, the buffer is never paused, the Latest Reading grid
    // and the Log panel above carry on exactly as usual. The only thing that
    // stops while a replay is up is live pixels landing on the five widgets
    // the replay is driving, so the two can't scribble over each other.
    if (!replayActive) {
      applyImuSample({
        yawDial: imuYawDeg,
        pitch: imuLatest.pitch,
        roll: imuLatest.roll,
        gravity: imuLatest.gravity,
        gx: gxV, gy: gyV, gz: gzV,
        active: imuLiveActive
      });
    }

    // --- temp + RFID: the raw mirror first. These three stay pure
    // pass-through - exactly what THIS record said, nothing carried from
    // the previous one. The held verdict is derived from them below; it
    // never writes back into them. See the state block above.
    var now = Date.now();
    rfidCurrentId = (data.rfid_id === null || data.rfid_id === undefined) ? null : data.rfid_id;
    rfidCurrentTemp = (data.temperature === null || data.temperature === undefined) ? null : data.temperature;
    // The authoritative freshness signal as of gateway V1.3.5. Prefer it
    // over a null-check on rfid_id: PROTOCOL_V10.md section 2.3 says the two
    // always agree and that the flag exists precisely so this code doesn't
    // have to infer a verdict from a sentinel. Accepts 1 or true so the
    // frontend doesn't care whether the backend ever switches int/bool.
    rfidCurrentValid = (data.rfid_valid === 1 || data.rfid_valid === true);

    // The flag is what makes this a "found", not the id: a record carrying an
    // id with rfid_valid=0 does NOT resolve a scan, which is the whole point
    // of preferring the explicit signal. The id is required too, but only as
    // a malformed-record guard - PROTOCOL_V10.md section 2.3 guarantees the
    // two agree, so a record where they don't is broken, and a broken record
    // should not be allowed to write a verdict (it would put a literal
    // "null" on the card and a contradictory NO TAG row in Scan History).
    // Skipping it leaves the scan pending, so it resolves on the next good
    // record or on the timeout, which is the right failure mode.
    if (rfidCurrentValid && rfidCurrentId !== null) {
      if (rfidOneShotDeadline !== null) {
        // A scan is armed and a confirmed read just landed. Before trusting
        // it as THIS scan's result, require actual evidence that this
        // scan's own attempt cycle ran on the collar - not just a timeout
        // budget that hasn't expired yet.
        //
        // WHY THIS GUARD EXISTS: it is now CONFIRMED hardware behaviour
        // (not a guess) that every single READ RFID makes the collar
        // disconnect and reconnect its BLE link once the scan completes -
        // that disconnect/reconnect cycle IS the scan happening. Without
        // this guard, a confirmed read arriving milliseconds after the
        // button is pressed could just be carryover from whatever the wire
        // was already saying the instant before the command went out -
        // stale information from BEFORE this scan started, not evidence of
        // what THIS scan found. Requiring the disconnect first (tracked in
        // rfidPendingSawDisconnect, set from setBleReconnecting() - see its
        // comment) means a FOUND verdict can only be produced by a read that
        // arrived after the collar actually cycled for this attempt.
        //
        // The `now >= rfidOneShotDeadline` half is the safety net, not the
        // normal path: if disconnect-detection ever fails to fire (a missed
        // or reworded log line, anything upstream of the regex), falling
        // back to the OLD trusting behaviour ONCE THE ATTEMPT BUDGET HAS
        // ALREADY ELAPSED is better than blocking resolution forever - by
        // that point a genuine NO-TAG timeout would have fired anyway, so
        // there is nothing left to lose by trusting the read instead.
        var canResolve = rfidPendingSawDisconnect || now >= rfidOneShotDeadline;
        if (canResolve) {
          // This is that scan's result: log it once, then disarm. Scan
          // History still only ever records armed scans - a confirmed read
          // arriving with nothing pending (the else branch below) is normal
          // telemetry and is not logged, unchanged.
          logScanResult(now, rfidCurrentId, rfidCurrentTemp, rfidPendingSource, data.timestamp, rfidPendingScanId);
          rfidHeldResult = { found: true, id: rfidCurrentId, temp: rfidCurrentTemp, at: now };
          rfidOneShotDeadline = null;
          rfidPendingSource = null;
          rfidPendingScanId = null;
          // Unchanged path, and it still wins: a tag arriving during the
          // extended "waiting for link" hold resolves the scan as FOUND
          // right here, exactly as it did before that hold existed.
          rfidResolveHeldForLink = false;
        }
        // else: neither signal has fired yet - still within budget, and no
        // disconnect observed for this scan. Deliberately do NOT touch
        // rfidHeldResult, do NOT log anything, do NOT clear the pending
        // deadline. The card just keeps showing SCANNING… - this same
        // branch gets another chance on the next telemetry record, on the
        // 500ms poll at the bottom of this file, and the disconnect nudge
        // in setBleReconnecting() once it actually arrives.
      } else {
        // No scan pending. The card's held verdict is still updated: a
        // confirmed read is the strongest statement the hardware can make
        // about what is in front of the reader right now, and it is
        // strictly more current than whatever the previous scan concluded -
        // refusing to show it would mean displaying a stale verdict while
        // better information sat on the wire. Still only ever set by a
        // confirmed read and only ever cleared by the next scan arming;
        // rfid_valid=0 records never touch it, which is what keeps this from
        // being the old sticky card. This path is unaffected by the
        // disconnect guard above - there is no pending scan for a stray
        // record to be wrongly attributed to.
        rfidHeldResult = { found: true, id: rfidCurrentId, temp: rfidCurrentTemp, at: now };
      }
      refreshRfidOnceAvailability();
    }
    renderRfidCards(now);

    // Full-resolution capture: one row per telemetry record, at whatever
    // rate the serial link is actually delivering them - see the Record IMU
    // section above for why this isn't a periodic sample.
    if (imuLogOn) { captureImuLogRow(now); }
  }

  btnImuReset.addEventListener("click", function () {
    imuYawDeg = 0;
    imuLatest.yaw = 0;
    // Re-captured from the next telemetry record, so the crosshair recenters
    // on whatever orientation the collar is in right now.
    imuHasOrigin = false;
    // The zero applies to the LIVE integration either way, but only repaint
    // the dial if live is what's on it - a replay is showing angles recorded
    // against an origin captured minutes ago on a different run, and snapping
    // its dial to 0 would misrepresent the file. It picks the new origin up
    // naturally when the replay ends and live resumes.
    if (!replayActive) { withoutDialTransition(function () { renderYawDial(0); }); }
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
        // A telemetry record arriving at all is direct proof the link is up
        // - independent of and a bit more certain than matching log text.
        if (bleReconnecting) { setBleReconnecting(false); }
        renderTelemetry(event.data);
      } else if (event.type === "log") {
        watchLogForBleState(event.text);
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
  // Paint the empty charts once at startup so the canvases get sized to the
  // laid-out panel (and their scrollbars/labels get their disabled/"no
  // samples" state) instead of sitting blank and unsized until the first
  // telemetry record - which, on a panel opened before anything is
  // connected, could be a long time.
  chartViews.forEach(function (view) { drawChartView(view); });
  applyReplayControlState();
  loadCommands();
  refreshPorts();
  api("/api/status").then(function (body) { applyStatus(body.status); })
                    .catch(function () { /* server not ready yet; SSE will say */ });
  startStream();

  // The RFID cards have one wall-clock-driven state left: a one-shot scan's
  // timeout, which must not wait on the next telemetry packet to fire — the
  // stream can legitimately go quiet for stretches (README: "nothing here
  // should ever interpret quiet as broken"), and a one-shot's own telemetry
  // can stop right as its timeout elapses. A plain low-rate timer keeps
  // that honest even when nothing is arriving over SSE.
  setInterval(function () { renderRfidCards(Date.now()); }, 500);
})();
