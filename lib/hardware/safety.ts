// Safety boundary between the simulation and physical gantry hardware. Pure TypeScript, deterministic, unit tested.
//
// Rules (docs/ARCHITECTURE.md section 7):
// 1. Simulated and physical motion are separate adapters. Nothing reaches hardware except through SafeGantryLink.
// 2. Physical motion requires the ARMED state. Arming needs an explicit confirmation phrase, a live connection and a
//    released emergency stop. Until the axes are homed only HOME and STOP are accepted.
// 3. Every command is validated deterministically: finite numbers, inside the soft limits (rejected, never clamped:
//    a command that was wrong should not silently become a different one), speed within the machine limit, and
//    the axis not pressing into a triggered limit switch.
// 4. Loss of heartbeat beyond the timeout faults the link and sends STOP. A fault or E-stop latches until reset.
// 5. Commands from an AI or a controller policy are recommendations: they need an operator approval id and pass the
//    same validation; there is no path from a model to the motors that skips it.
// 6. Dry-run mode validates and logs but never transmits.

import { GANTRY } from "../sim/constants";

export type ArmState = "DISARMED" | "ARMED" | "ESTOP" | "FAULT";
export type CommandSource = "operator" | "controller" | "ai";

export interface HardwareStatus {
  connected: boolean;
  homed: boolean;
  /** limit switches at the home ends, true = triggered */
  limitX0: boolean;
  limitY0: boolean;
  /** physical E-stop button state, true = pressed */
  estopPressed: boolean;
  /** last reported position, gantry cm */
  x: number;
  y: number;
}

export type GantryCommand =
  | { kind: "MOVE"; x: number; y: number; speed: number; source: CommandSource; approvalId?: string }
  | { kind: "HOME"; source: CommandSource; approvalId?: string }
  | { kind: "STOP"; source: CommandSource };

export interface SafetyLimits {
  /** soft travel limits, gantry cm, inside the mechanical travel */
  min: [number, number];
  max: [number, number];
  /** cm/s */
  maxSpeed: number;
  /** heartbeat timeout, ms */
  heartbeatTimeoutMs: number;
}

/** The blueprint machine: an upper bound. A connected controller narrows it to what it declares (lib/hardware/grbl.ts). */
export const DEFAULT_LIMITS: SafetyLimits = {
  min: [0.5, 0.5],
  max: [GANTRY.travelX - 0.5, GANTRY.travelY - 0.5],
  maxSpeed: GANTRY.maxSpeed,
  heartbeatTimeoutMs: 500,
};

export const ARM_PHRASE = "ARM GANTRY";

export interface Verdict {
  ok: boolean;
  reason: string;
}

const ok: Verdict = { ok: true, reason: "" };
const no = (reason: string): Verdict => ({ ok: false, reason });

export class SafetySupervisor {
  state: ArmState = "DISARMED";
  private lastHeartbeat = -Infinity;
  private status: HardwareStatus | null = null;
  readonly log: { t: number; text: string }[] = [];

  constructor(
    readonly limits: SafetyLimits = DEFAULT_LIMITS,
    readonly mode: "dry-run" | "live" = "dry-run",
  ) {}

  /** Records a status packet from the hardware. */
  heartbeat(status: HardwareStatus, nowMs: number): void {
    this.status = status;
    this.lastHeartbeat = nowMs;
    if (status.estopPressed && this.state !== "ESTOP") this.trip("ESTOP", nowMs, "physical E-stop pressed");
  }

  /** Call periodically. Returns true when a STOP must be sent because the link was lost. */
  watchdog(nowMs: number): boolean {
    if (this.state === "ARMED" && nowMs - this.lastHeartbeat > this.limits.heartbeatTimeoutMs) {
      this.trip("FAULT", nowMs, `heartbeat lost for ${Math.round(nowMs - this.lastHeartbeat)} ms`);
      return true;
    }
    return false;
  }

  private trip(to: "ESTOP" | "FAULT", nowMs: number, why: string): void {
    this.state = to;
    this.log.push({ t: nowMs, text: `${to}: ${why}` });
  }

  arm(phrase: string, nowMs: number): Verdict {
    if (this.state === "ESTOP" || this.state === "FAULT") return no(`${this.state} is latched: reset it first`);
    if (phrase !== ARM_PHRASE) return no(`type "${ARM_PHRASE}" to arm`);
    const s = this.status;
    if (!s || !s.connected || nowMs - this.lastHeartbeat > this.limits.heartbeatTimeoutMs) return no("no live connection to the controller");
    if (s.estopPressed) return no("E-stop is pressed");
    this.state = "ARMED";
    this.log.push({ t: nowMs, text: "ARMED" });
    return ok;
  }

  disarm(nowMs: number): void {
    if (this.state === "ARMED") this.state = "DISARMED";
    this.log.push({ t: nowMs, text: "DISARMED" });
  }

  /** Software E-stop: latches like the physical one. */
  emergencyStop(nowMs: number): void {
    this.trip("ESTOP", nowMs, "software E-stop");
  }

  /** Clears a latched E-stop or fault to DISARMED (never straight to ARMED); the physical E-stop must be released. */
  resetLatch(nowMs: number): Verdict {
    if (this.status?.estopPressed) return no("release the physical E-stop first");
    if (this.state !== "ESTOP" && this.state !== "FAULT") return ok;
    this.state = "DISARMED";
    this.log.push({ t: nowMs, text: "latch reset to DISARMED" });
    return ok;
  }

  /** Deterministic validation of one command against the current state. STOP is always allowed. */
  validate(cmd: GantryCommand, nowMs: number): Verdict {
    if (cmd.kind === "STOP") return ok;
    if (cmd.source !== "operator" && !cmd.approvalId) return no(`${cmd.source} commands need an operator approval`);
    if (this.state !== "ARMED") return no(`not armed (${this.state})`);
    const s = this.status;
    if (!s || !s.connected || nowMs - this.lastHeartbeat > this.limits.heartbeatTimeoutMs) return no("link lost");
    if (cmd.kind === "HOME") return ok;
    if (!s.homed) return no("axes not homed: only HOME and STOP are accepted");
    if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y) || !Number.isFinite(cmd.speed)) return no("non-finite value");
    const { min, max } = this.limits;
    if (cmd.x < min[0] || cmd.x > max[0] || cmd.y < min[1] || cmd.y > max[1])
      return no(`target (${cmd.x.toFixed(1)}, ${cmd.y.toFixed(1)}) outside soft limits X ${min[0]}..${max[0]}, Y ${min[1]}..${max[1]}`);
    if (!(cmd.speed > 0) || cmd.speed > this.limits.maxSpeed) return no(`speed ${cmd.speed} outside 0..${this.limits.maxSpeed} cm/s`);
    // written so that an unknown (NaN) position refuses too
    if (s.limitX0 && !(cmd.x >= s.x)) return no("X0 limit switch triggered: motion toward it refused");
    if (s.limitY0 && !(cmd.y >= s.y)) return no("Y0 limit switch triggered: motion toward it refused");
    return ok;
  }
}

/** Anything that can receive validated commands. */
export interface GantryAdapter {
  readonly kind: "simulated" | "serial" | "dry-run";
  send(cmd: GantryCommand): void;
}

/** Records commands, never moves anything. */
export class DryRunAdapter implements GantryAdapter {
  readonly kind = "dry-run" as const;
  readonly sent: GantryCommand[] = [];
  send(cmd: GantryCommand): void {
    this.sent.push(cmd);
  }
}

export interface SubmitResult extends Verdict {
  transmitted: boolean;
}

/** The only path from a command to an adapter. */
export class SafeGantryLink {
  constructor(
    readonly supervisor: SafetySupervisor,
    readonly adapter: GantryAdapter,
  ) {}

  submit(cmd: GantryCommand, nowMs: number): SubmitResult {
    if (this.supervisor.watchdog(nowMs)) this.adapter.send({ kind: "STOP", source: "operator" });
    const v = this.supervisor.validate(cmd, nowMs);
    this.supervisor.log.push({ t: nowMs, text: `${v.ok ? "ACCEPT" : "REJECT"} ${cmd.kind} from ${cmd.source}${v.ok ? "" : `: ${v.reason}`}` });
    if (!v.ok) return { ...v, transmitted: false };
    // in dry-run mode only non-physical adapters (simulation, recorder) receive commands; a serial link never does
    const live = this.supervisor.mode === "live" || this.adapter.kind !== "serial";
    if (live) this.adapter.send(cmd);
    return { ...v, transmitted: live };
  }
}
