"""
The serial half: owning the COM port, reading it without blocking forever, and
fanning what arrives out to every browser tab that is listening.

THE SHAPE OF THIS
-----------------

    ESP32 gateway
         | USB CDC, 115200 8N1
         v
    pyserial port            (one, exclusive - Windows will not share it)
         |
    reader thread  --------> LineAssembler ------> telemetry_parser.classify()
    (bounded reads)          (bytes -> lines)      (line -> event dict)
                                                          |
                                                          v
                                                   broadcast to N
                                                   Subscriber queues
                                                    |          |
                                                 SSE tab    SSE tab

Three separable problems, three separable pieces:

  1. Bytes do not arrive as lines. Solved by LineAssembler, below.
  2. A reader thread must be stoppable. Solved by a bounded read timeout plus
     a stop Event, never by a blocking readline().
  3. A slow browser must not be able to stall the reader. Solved by giving
     each subscriber its own bounded queue with a drop-oldest policy.

WHY NOT readline()
------------------
`pyserial`'s readline() with timeout=None blocks until a newline arrives. If
the collar goes quiet — which is exactly what `SLEEP` is *for* — that thread is
parked inside a syscall with no way to ask it to stop, and disconnect() would
hang until data happened to arrive. So the loop does bounded reads (timeout
0.1s) and re-checks its stop flag between them; worst-case shutdown latency is
one timeout. This is the same non-blocking accumulator discipline the gateway's
own firmware uses on its command input (`src/main.cpp`, the CMD-PARSER region):
never wait for a terminator you cannot guarantee is coming.
"""

import threading
import queue
import time
from typing import Any, Callable, Dict, List, Optional

import serial
from serial.tools import list_ports

from telemetry_parser import classify


# Matches `#define SERIAL_BAUD 115200` in `ESP Gateway/include/config.h`, which
# is what `Serial.begin(SERIAL_BAUD)` in the gateway's setup() uses. Verified
# against that file rather than assumed.
DEFAULT_BAUD = 115200

# How long a single read() may block before the loop re-checks its stop flag.
# Also the worst-case latency of disconnect(). Small enough to feel instant,
# large enough not to spin the CPU.
READ_TIMEOUT_S = 0.1

# Per-subscriber ring capacity. See Subscriber for the drop policy.
SUBSCRIBER_QUEUE_MAX = 2000

# A record is ~60-80 characters. A line far longer than this is not a record,
# it is framing garbage from a half-connected cable, and holding it forever
# would grow the accumulator without bound.
MAX_LINE_CHARS = 512


class SerialLinkError(RuntimeError):
    """A user-facing serial problem: port busy, missing, denied.

    Carries a message written for the operator, not a traceback. The route
    layer turns it straight into JSON.
    """


class LineAssembler:
    """Bytes in, complete lines out.

    A UART delivers whatever happened to be in the driver buffer when read()
    was called. One record can arrive as three chunks; three records can arrive
    as one. Neither is an error, and code that assumes "one read == one line"
    works perfectly on the bench and corrupts data in the field.

        feed(b"123\\tC0")      -> []                (incomplete, held)
        feed(b"01\\t...\\n# c") -> ["123\\tC001\\t..."]  (one out, "# c" held)

    Decoding is latin-1 with errors="replace": the gateway emits ASCII, and
    latin-1 maps every possible byte to a character, so a corrupted byte from
    line noise becomes a visible odd character instead of raising
    UnicodeDecodeError inside the reader thread and killing the stream.
    """

    def __init__(self, max_line_chars: int = MAX_LINE_CHARS):
        self._buffer = bytearray()
        self._max = max_line_chars
        self._overlong = False  # swallowing the tail of a too-long line

    def feed(self, chunk: bytes) -> List[str]:
        """Absorb a chunk; return zero or more complete lines (no newline)."""
        lines: List[str] = []
        if not chunk:
            return lines

        self._buffer.extend(chunk)

        while True:
            index = self._buffer.find(b"\n")
            if index < 0:
                break
            raw = bytes(self._buffer[:index])
            del self._buffer[: index + 1]

            if self._overlong:
                # This is the tail of a line we already gave up on. Drop it and
                # resynchronise on the next newline — same strategy the
                # gateway's own command parser uses for over-long input.
                self._overlong = False
                continue

            text = raw.decode("latin-1", errors="replace").rstrip("\r")
            if text.strip():  # bare CRLF / blank line is not an event
                lines.append(text)

        if len(self._buffer) > self._max:
            # No newline in sight and the accumulator is past any plausible
            # record length. Discard and mark, so the partial tail after the
            # next newline is not emitted as a bogus record.
            self._buffer.clear()
            if not self._overlong:
                self._overlong = True
                lines.append(
                    "# panel: over-long line (>%d chars) discarded - resyncing"
                    % self._max
                )
        return lines

    def reset(self) -> None:
        self._buffer.clear()
        self._overlong = False


class Subscriber:
    """One connected browser tab's view of the stream.

    DROP POLICY: bounded queue, DROP-OLDEST.

    The alternatives were block-the-reader (a paused browser tab would stall
    the serial thread and back the OS driver buffer up until bytes were lost at
    the hardware level — the worst option, because the loss then happens
    invisibly and off-machine) or drop-newest (keeps stale data and discards
    the fresh reading, which is backwards for a live monitor). Drop-oldest
    keeps the tab showing the most recent truth, which is what a live panel is
    for. History is not this tool's job; if it becomes one, it needs a file on
    disk, not a bigger queue.

    Every drop is counted, and the count is surfaced to the tab as a synthetic
    '# panel:' log line, so a gap is always visible rather than silent.
    """

    def __init__(self, maxsize: int = SUBSCRIBER_QUEUE_MAX):
        self.queue: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=maxsize)
        self.dropped = 0

    def put(self, event: Dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            try:
                self.queue.get_nowait()  # evict oldest
                self.dropped += 1
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(event)
            except queue.Full:
                self.dropped += 1

    def take_drop_notice(self) -> Optional[Dict[str, Any]]:
        """Consume the pending drop count as a log event, if any."""
        if not self.dropped:
            return None
        count = self.dropped
        self.dropped = 0
        return {
            "type": "log",
            "origin": "panel",
            "text": "# panel: %d line(s) dropped - this tab fell behind" % count,
        }


class SerialLink:
    """Owns at most one open port, its reader thread, and the subscriber set.

    Deliberately one port at a time: one gateway, one collar, and Windows will
    not let two handles share a COM port anyway. Multi-port would be a map of
    these objects, not a change to this one.
    """

    def __init__(self, baud: int = DEFAULT_BAUD):
        self.baud = baud
        self._port: Optional[serial.Serial] = None
        self._port_name: Optional[str] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()          # guards _port for write/close
        self._subs_lock = threading.Lock()     # guards _subscribers
        self._subscribers: List[Subscriber] = []
        self._last_error: Optional[str] = None
        self._connected_at: Optional[float] = None
        self._lines_seen = 0

    # -- discovery ---------------------------------------------------------

    @staticmethod
    def available_ports() -> List[Dict[str, str]]:
        """Everything the OS will admit to having.

        No filtering by VID/PID: the gateway is a bare USB-UART bridge
        (CP210x / CH340 / native ESP32-S3 CDC depending on the board) and a
        whitelist would eventually hide the very port the operator needs.
        `description` is included so a human can tell COM4 from COM7.
        """
        found = []
        for info in list_ports.comports():
            found.append(
                {
                    "device": info.device,
                    "description": info.description or "",
                    "hwid": info.hwid or "",
                }
            )
        found.sort(key=lambda p: p["device"])
        return found

    # -- state -------------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        port = self._port
        return bool(port is not None and port.is_open)

    def status(self) -> Dict[str, Any]:
        return {
            "connected": self.is_connected,
            "port": self._port_name,
            "baud": self.baud,
            "last_error": self._last_error,
            "lines_seen": self._lines_seen,
            "subscribers": len(self._subscribers),
            "uptime_s": (
                round(time.time() - self._connected_at, 1)
                if self._connected_at and self.is_connected
                else None
            ),
        }

    # -- connect / disconnect ---------------------------------------------

    def connect(self, port_name: str) -> Dict[str, Any]:
        """Open the port and start reading. Raises SerialLinkError on failure.

        The three failures worth naming separately, because the fix differs:

          * already open here      - the panel's own state, not the OS's
          * busy / access denied   - Windows PermissionError, near-always
                                     another program (Arduino IDE monitor,
                                     PlatformIO monitor, PuTTY) holding it
          * not found              - unplugged, or wrong COM number

        Everything else falls through to a generic message that still includes
        the exception text rather than a stack trace.
        """
        if self.is_connected:
            raise SerialLinkError(
                "already connected to %s - disconnect first" % self._port_name
            )
        if not port_name:
            raise SerialLinkError("no port selected")

        try:
            port = serial.Serial(
                port=port_name,
                baudrate=self.baud,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=READ_TIMEOUT_S,   # bounded: makes the thread stoppable
                write_timeout=2.0,        # never let a wedged port hang a POST
            )
        except serial.SerialException as exc:
            message = str(exc)
            lowered = message.lower()
            if "permission" in lowered or "access is denied" in lowered:
                raise SerialLinkError(
                    "%s is busy - another program probably has it open "
                    "(Arduino IDE / PlatformIO serial monitor, PuTTY). Close "
                    "that first." % port_name
                )
            if "could not open" in lowered or "no such file" in lowered \
                    or "filenotfound" in lowered:
                raise SerialLinkError(
                    "%s not found - is the gateway plugged in? Refresh the "
                    "port list." % port_name
                )
            raise SerialLinkError("could not open %s: %s" % (port_name, message))
        except (OSError, ValueError) as exc:
            raise SerialLinkError("could not open %s: %s" % (port_name, exc))

        self._port = port
        self._port_name = port_name
        self._last_error = None
        self._connected_at = time.time()
        self._stop.clear()

        self._thread = threading.Thread(
            target=self._pump_loop,
            args=(port,),
            name="serial-reader",
            daemon=True,  # never keep the Flask process alive on Ctrl+C
        )
        self._thread.start()

        self.broadcast(
            {
                "type": "log",
                "origin": "panel",
                "text": "# panel: connected to %s at %d baud" % (port_name, self.baud),
            }
        )
        self.broadcast({"type": "status", "status": self.status()})
        return self.status()

    def disconnect(self, reason: Optional[str] = None) -> Dict[str, Any]:
        """Stop the reader and close the port. Safe to call when already shut.

        Order matters: signal first, then join, then close. Closing a port out
        from under a thread that is mid-read is how you get platform-specific
        exceptions on Windows, so the thread is given its one-timeout chance to
        notice the flag and leave on its own.
        """
        self._stop.set()

        thread = self._thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=READ_TIMEOUT_S * 10 + 1.0)
        self._thread = None

        with self._lock:
            port = self._port
            self._port = None
            if port is not None:
                try:
                    if port.is_open:
                        port.close()
                except Exception:
                    # A port yanked out of the USB socket can throw on close.
                    # Nothing useful to do about it; the handle is gone either
                    # way and raising here would mask the real cause.
                    pass

        was = self._port_name
        self._port_name = None
        self._connected_at = None

        text = "# panel: disconnected from %s" % (was or "port")
        if reason:
            text += " (%s)" % reason
        self.broadcast({"type": "log", "origin": "panel", "text": text})
        self.broadcast({"type": "status", "status": self.status()})
        return self.status()

    # -- writing -----------------------------------------------------------

    def send_line(self, text: str) -> str:
        """Write one command plus '\\n'. Returns what was sent.

        '\\n' only, never '\\r\\n': the gateway's reader treats CR as a line
        terminator too and absorbs the stray LF of a CRLF pair as a blank line,
        so CRLF is harmless — but sending the minimum is one less thing to
        reason about when reading a byte trace.
        """
        with self._lock:
            port = self._port
            if port is None or not port.is_open:
                raise SerialLinkError("not connected - open a port first")
            payload = (text + "\n").encode("ascii", errors="replace")
            try:
                port.write(payload)
                port.flush()
            except serial.SerialTimeoutException:
                raise SerialLinkError(
                    "write timed out on %s - the port is open but not draining"
                    % self._port_name
                )
            except (serial.SerialException, OSError) as exc:
                self._last_error = str(exc)
                raise SerialLinkError(
                    "write failed on %s: %s" % (self._port_name, exc)
                )

        self.broadcast(
            {"type": "log", "origin": "panel", "text": "# panel: sent '%s'" % text}
        )
        return text

    # -- fan-out -----------------------------------------------------------

    def subscribe(self) -> Subscriber:
        sub = Subscriber()
        with self._subs_lock:
            self._subscribers.append(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        with self._subs_lock:
            if sub in self._subscribers:
                self._subscribers.remove(sub)

    def broadcast(self, event: Dict[str, Any]) -> None:
        """Hand one event to every subscriber. Never blocks, never raises."""
        with self._subs_lock:
            targets = list(self._subscribers)
        for sub in targets:
            sub.put(event)

    # -- the reader thread -------------------------------------------------

    def _pump_loop(self, port: Any) -> None:
        """Read until told to stop, or until the port dies.

        `port` is duck-typed on purpose — anything with in_waiting / read() /
        is_open works, which is what lets the test harness drive this exact
        function with a synthetic byte stream and a synthetic unplug, instead
        of testing a reimplementation of it.
        """
        assembler = LineAssembler()
        try:
            while not self._stop.is_set():
                try:
                    waiting = getattr(port, "in_waiting", 0) or 0
                    # read(1) with the port's timeout parks for at most
                    # READ_TIMEOUT_S when the line is idle, then returns b"".
                    chunk = port.read(waiting if waiting > 0 else 1)
                except (serial.SerialException, OSError, TypeError) as exc:
                    # The unplug case. Do NOT let this kill the Flask process:
                    # report it, mark the link down, and leave the thread.
                    self._last_error = str(exc)
                    self.broadcast(
                        {
                            "type": "log",
                            "origin": "panel",
                            "text": "# panel: serial read failed - %s" % exc,
                        }
                    )
                    self.broadcast(
                        {
                            "type": "status",
                            "status": {**self.status(), "connected": False},
                        }
                    )
                    break

                if not chunk:
                    continue

                for line in assembler.feed(chunk):
                    self._lines_seen += 1
                    self.broadcast(classify(line))
        except Exception as exc:  # last-resort net; a reader thread must not
            # take the web server down with it whatever happens.
            self._last_error = "reader thread crashed: %s" % exc
            self.broadcast(
                {
                    "type": "log",
                    "origin": "panel",
                    "text": "# panel: reader thread stopped - %s" % exc,
                }
            )
        finally:
            # If we exited because of an error rather than a requested stop,
            # tidy the port up so the UI's next connect() is not refused by our
            # own "already connected" guard.
            if not self._stop.is_set():
                self._stop.set()
                with self._lock:
                    if self._port is port:
                        self._port = None
                        self._port_name = None
                        self._connected_at = None
                    try:
                        if getattr(port, "is_open", False):
                            port.close()
                    except Exception:
                        pass
                self.broadcast({"type": "status", "status": self.status()})


def make_keepalive_event() -> Dict[str, Any]:
    """A no-op event for the SSE endpoint to send through idle proxies."""
    return {"type": "ping", "t": time.time()}
