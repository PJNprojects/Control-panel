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

  function sendCommand(name, params, button) {
    if (button) { button.disabled = true; }
    var release = function () { if (button) { button.disabled = false; } };

    return postJSON("/api/command", { name: name, params: params })
      .catch(function (err) {
        // Rejected commands are shown in the log next to the gateway's own
        // acks, so there is one place to look for "what happened when I
        // pressed that", regardless of which side said no.
        localNote("rejected: " + err.message, "error");
      })
      .then(release, release);
  }

  function buildCommandControl(command) {
    var card = document.createElement("div");
    card.className = "cmd" + (command.danger ? " cmd-danger" : "");
    card.dataset.group = command.group || "general";

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
      sendCommand(command.name, params, button);
    });

    card.appendChild(button);

    if (command.description) {
      var note = document.createElement("p");
      note.className = "muted small";
      note.textContent = command.description;
      card.appendChild(note);
    }

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

      // Group in registry order, so related commands sit together without the
      // registry having to be sorted or the UI having to know the group names.
      var groups = [];
      var byGroup = {};
      body.commands.forEach(function (command) {
        var key = command.group || "general";
        if (!byGroup[key]) { byGroup[key] = []; groups.push(key); }
        byGroup[key].push(command);
      });

      groups.forEach(function (key) {
        var row = document.createElement("div");
        row.className = "cmd-group";
        var title = document.createElement("h3");
        title.textContent = key;
        row.appendChild(title);
        var cards = document.createElement("div");
        cards.className = "cmd-row";
        byGroup[key].forEach(function (command) {
          cards.appendChild(buildCommandControl(command));
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
  }

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
})();
