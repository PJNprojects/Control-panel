"""
PC Control Panel — Flask app: HTTP routes over the serial link + registry.

    browser  --HTTP-->  Flask  --pyserial-->  ESP32 gateway  --BLE-->  collar
    browser  <--SSE---  Flask  <-----------   (telemetry + '#' acks)

WHY SSE AND NOT WEBSOCKETS
--------------------------
The live direction is strictly one-way: serial lines flow to the browser and
nothing flows back over that channel — commands are ordinary POSTs. Server-Sent
Events is exactly that shape, is plain HTTP with no handshake, needs no
dependency beyond Flask itself, and reconnects on its own if the tab sleeps.
Flask-SocketIO would add a dependency, an async worker model, and a protocol,
to buy a return path nothing needs. If bidirectional streaming ever IS needed,
that is the moment to reconsider — not before.

ROUTE MAP
---------
    GET  /                 the one page
    GET  /api/commands     the registry, as JSON (drives the UI's buttons)
    POST /api/command      {name, params} or {name:"__raw__", text}
    GET  /api/ports        serial ports the OS can see
    POST /api/connect      {port}
    POST /api/disconnect
    GET  /api/status       connection state, for polling / page reload
    GET  /api/stream       text/event-stream: the live line feed

There is ONE command route, not seven. See backend/commands.py for why.
"""

import json
import os
import sys
import time
import webbrowser
import threading

# Running this file directly (`python backend/app.py`) puts backend/ on
# sys.path, so the sibling modules import flat. Done explicitly as well so the
# app also works when started from another working directory, which is what the
# .bat file and `flask run` both end up doing.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, Response, jsonify, render_template, request  # noqa: E402

import commands as command_registry  # noqa: E402
from commands import CommandError, RAW_COMMAND_NAME  # noqa: E402
from serial_link import (  # noqa: E402
    DEFAULT_BAUD,
    SerialLink,
    SerialLinkError,
    make_keepalive_event,
)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

app = Flask(
    __name__,
    template_folder=os.path.join(PROJECT_ROOT, "templates"),
    static_folder=os.path.join(PROJECT_ROOT, "static"),
)

# One process, one gateway, one link. Module-level because the Flask dev server
# is a single process; if this ever moved behind a multi-worker WSGI server,
# this object is the thing that would have to move with it (each worker would
# otherwise fight over the same COM port). Documented rather than defended
# against, because a bench tool has no business being run under gunicorn.
link = SerialLink(baud=DEFAULT_BAUD)

# How often an idle stream emits a keepalive. Browsers and any intervening
# proxy will quietly close a connection that says nothing for long enough, and
# a SLEEPing collar produces genuinely zero traffic.
SSE_KEEPALIVE_S = 15.0


def _error(message, status=400):
    return jsonify({"ok": False, "error": message}), status


# ---------------------------------------------------------------------------
#  Page
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    return render_template("index.html", baud=link.baud)


# ---------------------------------------------------------------------------
#  Command registry
# ---------------------------------------------------------------------------


@app.route("/api/commands")
def api_commands():
    """The registry verbatim. The browser builds its controls from this.

    `raw_command` describes the escape hatch so the UI does not hardcode the
    reserved name or the length limit either.
    """
    return jsonify(
        {
            "ok": True,
            "commands": command_registry.list_commands(),
            "raw_command": {
                "name": RAW_COMMAND_NAME,
                "max_chars": command_registry.GATEWAY_MAX_LINE_CHARS,
            },
        }
    )


@app.route("/api/command", methods=["POST"])
def api_command():
    """Validate, render, write. In that order, and never out of it.

    The rendering step cannot touch the port, so an invalid request is
    guaranteed to produce zero bytes on the wire. That guarantee is the reason
    validation lives in commands.py rather than inline here.

    Client-side min/max on the number inputs mirrors the registry, but is a
    convenience only — anything can POST here, so the server re-validates. The
    browser is never the authority on what is safe to send to hardware.
    """
    payload = request.get_json(silent=True) or {}
    name = payload.get("name")
    if not isinstance(name, str) or not name:
        return _error("missing 'name'")

    params = payload.get("params") or {}
    if not isinstance(params, dict):
        return _error("'params' must be an object")

    try:
        text = command_registry.render_command(
            name, params=params, text=payload.get("text")
        )
    except CommandError as exc:
        # No serial write has happened and none will.
        return _error(str(exc))

    try:
        link.send_line(text)
    except SerialLinkError as exc:
        return _error(str(exc), status=409)

    return jsonify({"ok": True, "name": name, "sent": text})


# ---------------------------------------------------------------------------
#  Serial connection
# ---------------------------------------------------------------------------


@app.route("/api/ports")
def api_ports():
    try:
        return jsonify({"ok": True, "ports": SerialLink.available_ports()})
    except Exception as exc:  # enumeration itself can fail on odd drivers
        return _error("could not list serial ports: %s" % exc, status=500)


@app.route("/api/connect", methods=["POST"])
def api_connect():
    payload = request.get_json(silent=True) or {}
    port = payload.get("port")
    if not isinstance(port, str) or not port:
        return _error("missing 'port'")
    try:
        status = link.connect(port)
    except SerialLinkError as exc:
        return _error(str(exc), status=409)
    return jsonify({"ok": True, "status": status})


@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    return jsonify({"ok": True, "status": link.disconnect()})


@app.route("/api/status")
def api_status():
    return jsonify({"ok": True, "status": link.status()})


# ---------------------------------------------------------------------------
#  The live stream
# ---------------------------------------------------------------------------


@app.route("/api/stream")
def api_stream():
    """Server-Sent Events: one JSON object per line the gateway sent.

    Each tab gets its own Subscriber (its own bounded queue), so one tab left
    open in a background window cannot slow another down — it just accumulates
    its own drops and is told about them.
    """
    subscriber = link.subscribe()

    def generate():
        try:
            # Tell a freshly-opened tab where things stand, so a page reload
            # mid-session does not show a blank, stateless panel.
            yield _sse({"type": "status", "status": link.status()})
            last_beat = time.time()

            while True:
                notice = subscriber.take_drop_notice()
                if notice is not None:
                    yield _sse(notice)
                try:
                    event = subscriber.queue.get(timeout=1.0)
                except Exception:
                    event = None

                if event is not None:
                    yield _sse(event)
                    continue

                if time.time() - last_beat >= SSE_KEEPALIVE_S:
                    last_beat = time.time()
                    yield _sse(make_keepalive_event())
        except GeneratorExit:
            # The tab closed or navigated away. Normal, not an error.
            raise
        finally:
            link.unsubscribe(subscriber)

    response = Response(generate(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"  # if ever put behind nginx
    response.headers["Connection"] = "keep-alive"
    return response


def _sse(event):
    return "data: %s\n\n" % json.dumps(event)


# ---------------------------------------------------------------------------
#  Entry point
# ---------------------------------------------------------------------------


def _open_browser_later(url, delay=1.2):
    def go():
        time.sleep(delay)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=go, daemon=True).start()


def main():
    host = os.environ.get("PANEL_HOST", "127.0.0.1")
    port = int(os.environ.get("PANEL_PORT", "5000"))
    url = "http://%s:%d/" % (host, port)

    if os.environ.get("PANEL_OPEN_BROWSER", "1") == "1":
        _open_browser_later(url)

    print("PC Control Panel  ->  %s" % url)
    print("Serial baud: %d (matches SERIAL_BAUD in ESP Gateway/include/config.h)"
          % link.baud)
    print("Ctrl+C to stop.")

    try:
        # threaded=True: the SSE generator holds a worker for the life of the
        # tab, so a single-threaded server would answer exactly one request and
        # then appear to hang. debug/reloader off - the reloader would start a
        # second process, and two processes cannot share one COM port.
        app.run(host=host, port=port, threaded=True, debug=False, use_reloader=False)
    finally:
        link.disconnect(reason="server shutting down")


if __name__ == "__main__":
    main()
