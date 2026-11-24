import serial
import threading
import json
import time


class SerialBridge:
    """
    JSON-lines link to the MCU over a UART.

    One reader thread owns each opened port. `connect()` always closes the previous port and stops its reader first,
    so there is never more than one handle or reader on the UART. A read failure (cable pulled, device reset) closes
    the port, drops the cached packet and reopens with back-off. A packet older than `stale_after` seconds is not
    served, so a silent link reads as offline instead of as frozen live telemetry.
    """

    def __init__(self, port="/dev/ttyAMA0", baudrate=115200, stale_after=1.0):
        self.port = port
        self.baudrate = baudrate
        self.stale_after = stale_after
        self.serial_conn = None
        self.latest_telemetry = {}
        self.last_rx = 0.0
        self.running = False
        self.lock = threading.Lock()
        self._stop = None
        self._thread = None

    def _open(self):
        return serial.Serial(self.port, self.baudrate, timeout=1)

    def connect(self) -> bool:
        """Opens the port and starts its reader. Returns False when the port cannot be opened."""
        self.disconnect()
        try:
            conn = self._open()
        except Exception as e:
            print(f"[SerialBridge] Failed to connect: {e}")
            return False
        with self.lock:
            self.serial_conn = conn
            self.latest_telemetry = {}
        stop = threading.Event()
        self._stop = stop
        self.running = True
        self._thread = threading.Thread(target=self._read_loop, args=(stop,), daemon=True)
        self._thread.start()
        print(f"[SerialBridge] Connected to FRDM MCU on {self.port} at {self.baudrate} baud.")
        return True

    def _read_loop(self, stop: threading.Event):
        backoff = 0.2
        while not stop.is_set():
            conn = self.serial_conn
            if conn is None:
                # the port was lost: try to reopen it, backing off up to 2 s between attempts
                try:
                    conn = self._open()
                except Exception as e:
                    print(f"[SerialBridge] Reopen failed: {e}")
                    stop.wait(backoff)
                    backoff = min(2.0, backoff * 2)
                    continue
                if stop.is_set():
                    conn.close()
                    return
                with self.lock:
                    self.serial_conn = conn
                backoff = 0.2
                print(f"[SerialBridge] Reconnected to {self.port}.")
            try:
                raw = conn.readline()
            except Exception as e:
                if stop.is_set():
                    return
                print(f"[SerialBridge] Read error: {e}. Reopening {self.port}.")
                with self.lock:
                    self.latest_telemetry = {}
                    if self.serial_conn is conn:
                        self.serial_conn = None
                try:
                    conn.close()
                except Exception:
                    pass
                stop.wait(backoff)
                continue
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue  # malformed packet from UART noise
            if not isinstance(data, dict):
                continue  # a valid JSON value that is not a telemetry object
            with self.lock:
                self.latest_telemetry = data
                self.last_rx = time.monotonic()

    def send_command(self, cmd_dict):
        conn = self.serial_conn
        if conn and conn.is_open:
            try:
                conn.write((json.dumps(cmd_dict) + "\n").encode("utf-8"))
            except Exception as e:
                print(f"[SerialBridge] Write error: {e}")

    def get_latest(self):
        """The last telemetry packet, or {} when none arrived within `stale_after` seconds."""
        with self.lock:
            if not self.latest_telemetry or time.monotonic() - self.last_rx > self.stale_after:
                return {}
            return self.latest_telemetry.copy()

    def is_connected(self) -> bool:
        return self.running and self.serial_conn is not None

    def disconnect(self):
        self.running = False
        stop, thread = self._stop, self._thread
        self._stop = self._thread = None
        if stop:
            stop.set()
        with self.lock:
            conn, self.serial_conn = self.serial_conn, None
            self.latest_telemetry = {}
        if conn:
            try:
                conn.close()
            except Exception:
                pass
        if thread and thread is not threading.current_thread():
            thread.join(timeout=2)
