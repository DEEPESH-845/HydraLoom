"""Safety boundary for physical gantry motion, enforced on the machine that owns the serial port.

Mirror of lib/hardware/safety.ts (the browser-side check). Both must agree; the backend copy is authoritative because
it is the last layer before the motors. Rules (docs/ARCHITECTURE.md section 7):

1. Physical motion requires ARMED. Arming needs the confirmation phrase, a live heartbeat and a released E-stop.
2. Until homed only HOME and STOP are accepted.
3. Commands are rejected (never clamped) when non-finite, outside soft limits, over the speed limit, or pressing into a
   triggered limit switch.
4. Heartbeat loss faults the link and sends STOP; FAULT and ESTOP latch and reset only to DISARMED.
5. Controller and AI commands need an operator approval id and pass the same validation.
6. Dry-run mode validates and logs but never transmits to the serial adapter.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Literal, Optional

ArmState = Literal["DISARMED", "ARMED", "ESTOP", "FAULT"]
Source = Literal["operator", "controller", "ai"]

ARM_PHRASE = "ARM GANTRY"
TRAVEL_X_CM = 100.0
TRAVEL_Y_CM = 40.0
MAX_SPEED_CM_S = 15.0


@dataclass
class HardwareStatus:
    connected: bool
    homed: bool
    limit_x0: bool
    limit_y0: bool
    estop_pressed: bool
    x: float
    y: float


@dataclass
class Command:
    kind: Literal["MOVE", "HOME", "STOP"]
    source: Source = "operator"
    x: float = math.nan
    y: float = math.nan
    speed: float = math.nan
    approval_id: Optional[str] = None


@dataclass
class Limits:
    min_xy: tuple[float, float] = (0.5, 0.5)
    max_xy: tuple[float, float] = (TRAVEL_X_CM - 0.5, TRAVEL_Y_CM - 0.5)
    max_speed: float = MAX_SPEED_CM_S
    heartbeat_timeout_ms: float = 500.0


@dataclass
class Verdict:
    ok: bool
    reason: str = ""


@dataclass
class SafetySupervisor:
    limits: Limits = field(default_factory=Limits)
    mode: Literal["dry-run", "live"] = "dry-run"
    state: ArmState = "DISARMED"
    log: list[tuple[float, str]] = field(default_factory=list)
    _status: Optional[HardwareStatus] = None
    _last_heartbeat: float = -math.inf

    def heartbeat(self, status: HardwareStatus, now_ms: float) -> None:
        self._status = status
        self._last_heartbeat = now_ms
        if status.estop_pressed and self.state != "ESTOP":
            self._trip("ESTOP", now_ms, "physical E-stop pressed")

    def _live(self, now_ms: float) -> bool:
        s = self._status
        return bool(s and s.connected and now_ms - self._last_heartbeat <= self.limits.heartbeat_timeout_ms)

    def watchdog(self, now_ms: float) -> bool:
        """True when a STOP must be sent because the link was lost."""
        if self.state == "ARMED" and now_ms - self._last_heartbeat > self.limits.heartbeat_timeout_ms:
            self._trip("FAULT", now_ms, f"heartbeat lost for {round(now_ms - self._last_heartbeat)} ms")
            return True
        return False

    def _trip(self, to: ArmState, now_ms: float, why: str) -> None:
        self.state = to
        self.log.append((now_ms, f"{to}: {why}"))

    def arm(self, phrase: str, now_ms: float) -> Verdict:
        if self.state in ("ESTOP", "FAULT"):
            return Verdict(False, f"{self.state} is latched: reset it first")
        if phrase != ARM_PHRASE:
            return Verdict(False, f'type "{ARM_PHRASE}" to arm')
        if not self._live(now_ms):
            return Verdict(False, "no live connection to the controller")
        if self._status and self._status.estop_pressed:
            return Verdict(False, "E-stop is pressed")
        self.state = "ARMED"
        self.log.append((now_ms, "ARMED"))
        return Verdict(True)

    def disarm(self, now_ms: float) -> None:
        if self.state == "ARMED":
            self.state = "DISARMED"
        self.log.append((now_ms, "DISARMED"))

    def emergency_stop(self, now_ms: float) -> None:
        self._trip("ESTOP", now_ms, "software E-stop")

    def reset_latch(self, now_ms: float) -> Verdict:
        if self._status and self._status.estop_pressed:
            return Verdict(False, "release the physical E-stop first")
        if self.state in ("ESTOP", "FAULT"):
            self.state = "DISARMED"
            self.log.append((now_ms, "latch reset to DISARMED"))
        return Verdict(True)

    def validate(self, cmd: Command, now_ms: float) -> Verdict:
        if cmd.kind == "STOP":
            return Verdict(True)
        if cmd.source != "operator" and not cmd.approval_id:
            return Verdict(False, f"{cmd.source} commands need an operator approval")
        if self.state != "ARMED":
            return Verdict(False, f"not armed ({self.state})")
        if not self._live(now_ms):
            return Verdict(False, "link lost")
        if cmd.kind == "HOME":
            return Verdict(True)
        s = self._status
        assert s is not None
        if not s.homed:
            return Verdict(False, "axes not homed: only HOME and STOP are accepted")
        if not all(math.isfinite(v) for v in (cmd.x, cmd.y, cmd.speed)):
            return Verdict(False, "non-finite value")
        (x0, y0), (x1, y1) = self.limits.min_xy, self.limits.max_xy
        if not (x0 <= cmd.x <= x1 and y0 <= cmd.y <= y1):
            return Verdict(False, f"target ({cmd.x:.1f}, {cmd.y:.1f}) outside soft limits X {x0}..{x1}, Y {y0}..{y1}")
        if not (0 < cmd.speed <= self.limits.max_speed):
            return Verdict(False, f"speed {cmd.speed} outside 0..{self.limits.max_speed} cm/s")
        if s.limit_x0 and cmd.x < s.x:
            return Verdict(False, "X0 limit switch triggered: motion toward it refused")
        if s.limit_y0 and cmd.y < s.y:
            return Verdict(False, "Y0 limit switch triggered: motion toward it refused")
        return Verdict(True)


@dataclass
class SafeGantryLink:
    """The only path from a command to a transport. `kind` 'serial' never transmits in dry-run mode."""

    supervisor: SafetySupervisor
    send: Callable[[Command], None]
    kind: Literal["serial", "simulated", "dry-run"] = "serial"

    def submit(self, cmd: Command, now_ms: float) -> tuple[Verdict, bool]:
        if self.supervisor.watchdog(now_ms):
            self.send(Command(kind="STOP"))
        v = self.supervisor.validate(cmd, now_ms)
        self.supervisor.log.append((now_ms, f"{'ACCEPT' if v.ok else 'REJECT'} {cmd.kind} from {cmd.source}{'' if v.ok else ': ' + v.reason}"))
        if not v.ok:
            return v, False
        live = self.supervisor.mode == "live" or self.kind != "serial"
        if live:
            self.send(cmd)
        return v, live
