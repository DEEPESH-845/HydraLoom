"""Regression tests for the legacy ROV serial bridge and HAL broker (serial_bridge.py, hal/broker.py).

A fake ``serial.Serial`` stands in for the FRDM MCU UART so the tests run without hardware.
Each test fails on the current code and passes once the matching bug is fixed.
"""

from __future__ import annotations

import queue
import sys
import threading
import time
import types

import pytest

try:  # pyserial is a legacy dependency and is not installed in the GANTRYLAB venv.
    import serial  # noqa: F401
except ImportError:  # pragma: no cover - depends on the environment
    _stub = types.ModuleType("serial")

    class _StubSerialException(Exception):
        pass

    def _stub_serial(*_a, **_k):
        raise _StubSerialException("pyserial not installed")

    _stub.Serial = _stub_serial
    _stub.SerialException = _StubSerialException
    sys.modules["serial"] = _stub

import serial_bridge  # noqa: E402
from hal import broker as broker_mod  # noqa: E402


class FakeSerialError(Exception):
    pass


class FakeSerial:
    """In-memory UART. ``FakeSerial.fail`` makes the constructor raise like a missing port."""

    fail = False
    instances: list["FakeSerial"] = []

    def __init__(self, port, baudrate, timeout=1):  # noqa: ANN001
        if FakeSerial.fail:
            raise FakeSerialError(f"could not open port {port!r}: FileNotFoundError")
        self.port = port
        self.is_open = True
        self.unplugged = False
        self.q: queue.Queue = queue.Queue()
        self.written: list[bytes] = []
        FakeSerial.instances.append(self)

    def readline(self) -> bytes:
        if self.unplugged or not self.is_open:
            time.sleep(0.01)
            raise FakeSerialError("ClearCommError failed (device disconnected)")
        try:
            return self.q.get(timeout=0.05)
        except queue.Empty:
            return b""

    def write(self, data: bytes) -> int:
        if self.unplugged or not self.is_open:
            raise FakeSerialError("write failed (device disconnected)")
        self.written.append(data)
        return len(data)

    def close(self) -> None:
        self.is_open = False


@pytest.fixture(autouse=True)
def fake_serial(monkeypatch: pytest.MonkeyPatch):
    FakeSerial.fail = False
    FakeSerial.instances = []
    monkeypatch.setattr(serial_bridge.serial, "Serial", FakeSerial)
    bridges: list[serial_bridge.SerialBridge] = []
    real_init = serial_bridge.SerialBridge.__init__

    def tracking_init(self, *a, **k):  # noqa: ANN001
        real_init(self, *a, **k)
        bridges.append(self)

    monkeypatch.setattr(serial_bridge.SerialBridge, "__init__", tracking_init)
    yield FakeSerial
    for b in bridges:
        try:
            b.disconnect()
        except Exception:  # noqa: BLE001
            pass


def _make_broker() -> broker_mod.HALBroker:
    b = broker_mod.HALBroker()
    b.physics.stop()
    return b


def _reader_threads(bridge: serial_bridge.SerialBridge) -> list[threading.Thread]:
    out = []
    for t in threading.enumerate():
        target = getattr(t, "_target", None)
        if target is not None and getattr(target, "__self__", None) is bridge:
            out.append(t)
    return out


def _wait(pred, timeout: float) -> bool:  # noqa: ANN001
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


# -- LEG-1: a port that fails to open is reported as connected hardware ---------------------------


def test_failed_open_is_not_reported_as_connected_hardware():
    FakeSerial.fail = True
    b = _make_broker()
    assert b.hardware_connected is False, "startup reported hardware_connected=True although the port did not open"

    result = b.set_mode("HARDWARE")
    assert result["success"] is False, f"HARDWARE switch reported success without a port: {result}"
    assert b.mode == "SIMULATION"


# -- LEG-2: a valid JSON line that is not an object poisons the telemetry cache ---------------------


@pytest.mark.parametrize("line", [b"123\n", b'["depth", 5]\n', b'"ok"\n', b"null\n"])
def test_non_object_json_line_is_ignored(line: bytes):
    bridge = serial_bridge.SerialBridge()
    bridge.connect()
    conn = bridge.serial_conn
    conn.q.put(b'{"depth": 3.5}\n')
    assert _wait(lambda: bridge.get_latest().get("depth") == 3.5, 2.0)
    conn.q.put(line)
    time.sleep(0.3)
    latest = bridge.get_latest()  # raises AttributeError ('int' object has no attribute 'copy') today
    assert latest == {"depth": 3.5}


# -- LEG-3: one invalid UTF-8 byte from UART noise stalls the reader for a full second ---------------


def test_invalid_utf8_noise_does_not_stall_reader():
    bridge = serial_bridge.SerialBridge()
    bridge.connect()
    conn = bridge.serial_conn
    conn.q.put(b"\xff\xfe{garbage\n")
    t0 = time.monotonic()
    conn.q.put(b'{"depth": 5}\n')
    assert _wait(lambda: bridge.get_latest().get("depth") == 5, 2.0)
    elapsed = time.monotonic() - t0
    assert elapsed < 0.5, f"next valid packet took {elapsed:.2f}s after a noise byte (reader slept 1 s)"


# -- LEG-4: connect() opens the port again and starts another reader without closing the old one ----


def test_hardware_switch_does_not_open_port_twice():
    b = _make_broker()  # startup connect succeeds
    assert b.hardware_connected
    assert b.set_mode("HARDWARE")["success"]
    open_ports = [s for s in FakeSerial.instances if s.is_open]
    assert len(open_ports) == 1, f"{len(open_ports)} handles open on the same UART"
    assert len(_reader_threads(b.serial_bridge)) == 1, "more than one reader thread on the same UART"


def test_fast_reconnect_does_not_revive_old_reader():
    bridge = serial_bridge.SerialBridge()
    bridge.connect()
    time.sleep(0.1)
    bridge.disconnect()
    bridge.connect()  # SIMULATION -> HARDWARE again within the old reader's 1 s error back-off
    time.sleep(1.5)
    readers = _reader_threads(bridge)
    assert len(readers) == 1, f"{len(readers)} reader threads consume the same port (lines get split between them)"


# -- LEG-5: an unplugged UART is never reopened and its last packet is served as live ---------------


def test_unplugged_uart_goes_offline_and_reconnects():
    b = _make_broker()
    b.mode = "SIMULATION"
    assert b.set_mode("HARDWARE")["success"]
    conn = b.serial_bridge.serial_conn
    conn.q.put(b'{"depth": 7, "yaw": 10, "voltage": 15.9}\n')
    assert _wait(lambda: b.get_telemetry()["sensors"]["depth"] == 7, 2.0)

    conn.unplugged = True  # cable pulled: every readline now raises
    n_before = len(FakeSerial.instances)
    went_offline = _wait(lambda: b.get_telemetry()["state"]["isArmed"] is False, 4.0)
    reopened = _wait(lambda: len(FakeSerial.instances) > n_before, 4.0)
    assert went_offline, "stale packet from an unplugged UART is still served as live armed HARDWARE telemetry"
    assert reopened, "the bridge never tries to reopen the port after a read failure"
