"""Regression tests for the legacy ROV dashboard server (main.py /ws/command, /ws/telemetry).

The app runs under a real uvicorn server (lifespan off, so YOLO and the camera never start)
and is driven with a real WebSocket client, as the dashboard does.
Each test fails on the current code and passes once the matching bug is fixed.
"""

from __future__ import annotations

import asyncio
import json
import math
import queue
import socket
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

uvicorn = pytest.importorskip("uvicorn")
websockets = pytest.importorskip("websockets")
pytest.importorskip("cv2")
pytest.importorskip("ultralytics")

import main  # noqa: E402
import serial_bridge  # noqa: E402
from simulation import fault_injector as fault_mod  # noqa: E402

REPLY_TIMEOUT = 3.0


class _FakeUart:
    def __init__(self, port, baudrate, timeout=1):  # noqa: ANN001
        self.is_open = True
        self.q: queue.Queue = queue.Queue()

    def readline(self) -> bytes:
        try:
            return self.q.get(timeout=0.05)
        except queue.Empty:
            return b""

    def write(self, data: bytes) -> int:
        return len(data)

    def close(self) -> None:
        self.is_open = False


@pytest.fixture(scope="module")
def base_url():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=port, lifespan="off", log_level="warning"))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    end = time.monotonic() + 15
    while not server.started:
        assert time.monotonic() < end, "uvicorn did not start"
        time.sleep(0.05)
    yield f"ws://127.0.0.1:{port}"
    server.should_exit = True
    th.join(timeout=5)


def _physics_alive() -> bool:
    phys = main.hal_broker.physics
    return any(getattr(t, "_target", None) == phys._physics_loop for t in threading.enumerate())


@pytest.fixture(autouse=True)
def reset_legacy_state():
    """Every test starts in SIMULATION with a healthy physics loop."""

    def reset() -> None:
        hb = main.hal_broker
        hb.serial_bridge.disconnect()
        hb.hardware_connected = False
        hb.mode = "SIMULATION"
        hb.transitioning = False
        main.vision_pipeline.mode = "SIMULATION"
        main.vision_pipeline._pending_mode_switch = None
        p = hb.physics
        with p.lock:
            p.t1 = p.t2 = p.t3 = p.t4 = 0.0
            p.yaw, p.yaw_vel, p.depth, p.depth_vel = 142.4, 0.0, 42.5, 0.0
            p.efficiency = [1.0, 1.0, 1.0, 1.0]
        if not _physics_alive():
            p.running = True
            threading.Thread(target=p._physics_loop, daemon=True).start()

    reset()
    yield
    reset()


async def _mode_reply(ws) -> dict:  # noqa: ANN001
    """Return the next MODE_SWITCH_RESULT, skipping any other (for example error) messages."""
    end = time.monotonic() + REPLY_TIMEOUT
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), max(0.01, end - time.monotonic())))
        if msg.get("type") == "MODE_SWITCH_RESULT":
            return msg


async def _send_then_ping(url: str, *messages: str) -> dict:
    """Send raw messages on one /ws/command socket, then prove the socket still answers."""
    async with websockets.connect(url + "/ws/command") as ws:
        for m in messages:
            await ws.send(m)
        await ws.send(json.dumps({"type": "SET_MODE", "mode": "SIMULATION"}))
        return await _mode_reply(ws)


# -- LEG-6: one malformed command closes the operator's command channel ---------------------------


@pytest.mark.parametrize("bad", [
    "not json",
    "[1, 2]",
    json.dumps({"type": "SET_PWM"}),
    json.dumps({"type": "SET_PWM", "payload": None}),
    json.dumps({"type": "SET_PWM", "payload": [10, 10, 0, 0]}),
])
def test_malformed_command_keeps_command_socket_open(base_url: str, bad: str):
    try:
        reply = asyncio.run(_send_then_ping(base_url, bad))
    except websockets.ConnectionClosed as exc:
        pytest.fail(f"/ws/command was closed by the server after {bad!r}: {exc!r}")
    assert reply["mode"] == "SIMULATION"


# -- LEG-7: SET_MODE accepts any string and reports success ---------------------------------------


@pytest.mark.parametrize("mode", ["BANANA", "simulation", None, 42])
def test_set_mode_rejects_unknown_mode(base_url: str, mode):  # noqa: ANN001
    async def go() -> dict:
        async with websockets.connect(base_url + "/ws/command") as ws:
            await ws.send(json.dumps({"type": "SET_MODE", "mode": mode}))
            return await _mode_reply(ws)

    reply = asyncio.run(go())
    assert reply["success"] is False, f"unknown mode {mode!r} accepted: {reply}"
    assert main.hal_broker.mode == "SIMULATION"
    assert main.get_full_telemetry()["mode"] == "SIMULATION"


# -- LEG-8: SET_PWM values are not validated (string kills physics, NaN poisons it) ---------------


def test_non_numeric_pwm_does_not_kill_physics(base_url: str):
    assert _physics_alive()
    asyncio.run(_send_then_ping(base_url, json.dumps({"type": "SET_PWM",
                                                      "payload": {"t1": "50", "t2": 0, "t3": 0, "t4": 0}})))
    time.sleep(0.3)
    assert _physics_alive(), "physics thread died (TypeError in _physics_loop); simulation is frozen for good"
    asyncio.run(_send_then_ping(base_url, json.dumps({"type": "SET_PWM",
                                                      "payload": {"t1": 0, "t2": 0, "t3": 80, "t4": 80}})))
    d0 = main.hal_broker.physics.get_state()["depth"]
    time.sleep(0.3)
    assert main.hal_broker.physics.get_state()["depth"] != d0, "vehicle no longer responds to heave thrust"


@pytest.mark.parametrize("value", ["NaN", "Infinity", "1e400"])
def test_non_finite_or_out_of_range_pwm_is_rejected(base_url: str, value: str):
    poison = '{"type": "SET_PWM", "payload": {"t1": %s, "t2": 0, "t3": 0, "t4": 0}}' % value
    zero = json.dumps({"type": "SET_PWM", "payload": {"t1": 0, "t2": 0, "t3": 0, "t4": 0}})
    asyncio.run(_send_then_ping(base_url, poison))
    time.sleep(0.2)
    asyncio.run(_send_then_ping(base_url, zero))
    time.sleep(0.2)
    yaw = main.hal_broker.physics.get_state()["yaw"]
    assert math.isfinite(yaw), f"physics yaw is {yaw} and never recovers"

    async def one_frame() -> str:
        async with websockets.connect(base_url + "/ws/telemetry") as ws:
            return await asyncio.wait_for(ws.recv(), REPLY_TIMEOUT)

    raw = asyncio.run(one_frame())
    json.loads(raw, parse_constant=lambda c: pytest.fail(f"telemetry frame is not valid JSON: contains {c}"))


# -- LEG-2 end to end: one non-object UART line kills every /ws/telemetry client ------------------


def test_telemetry_socket_survives_non_object_uart_line(base_url: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(serial_bridge.serial, "Serial", _FakeUart)
    hb = main.hal_broker
    hb.serial_bridge.connect()
    hb.hardware_connected = True
    hb.mode = "HARDWARE"
    hb.serial_bridge.serial_conn.q.put(b"123\n")
    time.sleep(0.3)

    async def frames(n: int) -> list[dict]:
        async with websockets.connect(base_url + "/ws/telemetry") as ws:
            return [json.loads(await asyncio.wait_for(ws.recv(), REPLY_TIMEOUT)) for _ in range(n)]

    try:
        got = asyncio.run(frames(3))
    except websockets.ConnectionClosed as exc:
        pytest.fail(f"/ws/telemetry closed by the server after the UART sent '123': {exc!r}")
    assert got[-1]["mode"] == "HARDWARE"


# -- LEG-9: SENSOR_LOSS fault does not touch depth and its revert changes IMU noise for good -------


def test_sensor_loss_fault_affects_depth_and_reverts_to_baseline(monkeypatch: pytest.MonkeyPatch):
    class _NoTimer:
        def __init__(self, *_a, **_k):
            pass

        def start(self) -> None:
            pass

    monkeypatch.setattr(fault_mod.threading, "Timer", _NoTimer)
    hb = main.hal_broker
    imu_baseline = hb.sim_imu.noise_std
    with hb.physics.lock:
        hb.physics.running = False  # freeze the true depth so the spread is sensor noise only
    time.sleep(0.05)
    try:
        main.fault_injector.trigger_anomaly("SENSOR_LOSS")
        samples = [hb.sim_depth.get_depth() for _ in range(500)]
        mean = sum(samples) / len(samples)
        std = (sum((s - mean) ** 2 for s in samples) / len(samples)) ** 0.5
        main.fault_injector._revert_sensor_loss()
    finally:
        hb.physics.running = True
        threading.Thread(target=hb.physics._physics_loop, daemon=True).start()
    assert std > 1.0, f"SENSOR_LOSS left depth noise at std={std:.3f} m (sim_depth.noise_std is never read)"
    assert hb.sim_imu.noise_std == imu_baseline, (
        f"revert set IMU noise to {hb.sim_imu.noise_std}, baseline was {imu_baseline}")
