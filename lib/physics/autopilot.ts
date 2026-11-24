// Guidance and control for the field vehicles. Pure and deterministic; state lives in the controller objects.
// These are conventional, hand-tuned PID and line-of-sight controllers (docs/PHYSICS.md section 5). They are not
// trained policies, and the UI says so.

import { DEG, qRotate, qRotateInv, qToEuler, sub, wrapPi, yawToHeading, headingToYaw, type Vec3 } from "./math";
import { boxGap, worldVelocity, zeroCommand, type Collider, type VehicleCommand, type VehicleParams, type VehicleState } from "./vehicle";

export type PilotMode = "MANUAL" | "HOLD" | "WAYPOINTS";

/** Manual stick input, each axis -1..1. Surge forward, sway starboard, heave up, yaw to starboard. */
export interface Stick {
  surge: number;
  sway: number;
  heave: number;
  yaw: number;
}

export interface Waypoint {
  /** world metres */
  x: number;
  z: number;
  /** world Y target (depth is surfaceY - y) or, when altitude is set, height above the seabed */
  y: number;
  altitude?: number;
  /** heading to hold on arrival (ROV only), degrees */
  headingDeg?: number;
}

export interface PilotTarget {
  mode: PilotMode;
  stick: Stick;
  /** HOLD: station to keep */
  hold: Waypoint;
  /** WAYPOINTS: route, visited in order */
  route: Waypoint[];
  /** cruise speed through the water, m/s */
  speed: number;
  /** keep the depth constant in MANUAL (ROV) */
  depthHold: boolean;
}

export interface PilotStatus {
  waypointIndex: number;
  /** distance to the active waypoint, m */
  distanceM: number;
  /** commanded heading, degrees */
  headingCmdDeg: number;
  done: boolean;
  /** cross-track error from the current route leg, m */
  crossTrackM: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));

export const ARRIVE_RADIUS = { rov: 0.35, auv: 3.0 } as const;

/** Heading of the vehicle, degrees clockwise from north. */
export const vehicleHeading = (s: VehicleState) => yawToHeading(qToEuler(s.attitude).yaw);

/** Moves a value toward a target by at most `step`. */
const slew = (v: number, to: number, step: number) => v + clamp(to - v, -step, step);
/** Full stick takes this long to arrive, so a key press is a push, not a kick. */
const STICK_RATE = 2.5;

class SmoothStick {
  private st: Stick = { surge: 0, sway: 0, heave: 0, yaw: 0 };
  reset(): void {
    this.st = { surge: 0, sway: 0, heave: 0, yaw: 0 };
  }
  update(to: Stick, dt: number): Stick {
    const k = STICK_RATE * dt;
    this.st = { surge: slew(this.st.surge, clamp(to.surge, -1, 1), k), sway: slew(this.st.sway, clamp(to.sway, -1, 1), k), heave: slew(this.st.heave, clamp(to.heave, -1, 1), k), yaw: slew(this.st.yaw, clamp(to.yaw, -1, 1), k) };
    return this.st;
  }
}

/** Turn rates, rad/s: what a pilot can watch, not what the thrusters can do (2.3 rad/s). */
export const YAW_RATE = { manual: 0.8, auto: 0.6 } as const;
/** Height the autopilots and the depth hold keep above whatever is below, m. */
export const MIN_CLEARANCE = 0.4;
const VIEW_DWELL_S = 1;

/**
 * ROV pilot: fully actuated, so position and heading are controlled directly.
 * Outer loop: position error to a desired velocity, saturated at cruise speed. Inner loop: velocity error to force,
 * with an integral on position that learns the steady current load (so station keeping holds in a current).
 */
export class RovPilot {
  private integ: Vec3 = [0, 0, 0];
  private depthRef: number | null = null;
  private stick = new SmoothStick();
  /** time spent at the active inspection viewpoint, s */
  private dwell = 0;
  /** slewed velocity command, world m/s; null = start from the present velocity */
  private vCmd: Vec3 | null = null;
  status: PilotStatus = { waypointIndex: 0, distanceM: 0, headingCmdDeg: 0, done: false, crossTrackM: 0 };

  reset(): void {
    this.integ = [0, 0, 0];
    this.depthRef = null;
    this.stick.reset();
    this.dwell = 0;
    this.vCmd = null;
    this.status = { waypointIndex: 0, distanceM: 0, headingCmdDeg: 0, done: false, crossTrackM: 0 };
  }

  /** Cascaded yaw: a rate command, then rate error to moment with the damping fed forward. */
  private yawMoment(p: VehicleParams, rate: number, wy: number): number {
    return clamp((4 * (rate - wy) + p.dampAngQ[1] * Math.abs(rate) * rate) / p.maxMoment[1], -1, 1);
  }

  update(p: VehicleParams, s: VehicleState, t: PilotTarget, bed: (x: number, z: number) => number, dt: number): VehicleCommand {
    const cmd = zeroCommand();
    const e = qToEuler(s.attitude);
    const w = s.angularVelocity;
    // attitude: always self-level roll and pitch (the frame is passively stable too)
    cmd.moment[0] = clamp((-8 * e.roll - 2 * w[0]) / p.maxMoment[0], -1, 1);
    cmd.moment[2] = clamp((-8 * e.pitch - 2 * w[2]) / p.maxMoment[2], -1, 1);

    if (t.mode === "MANUAL") {
      const st = this.stick.update(t.stick, dt);
      cmd.force[0] = st.surge;
      cmd.force[2] = st.sway;
      // yaw to starboard is negative yaw about +Y
      cmd.moment[1] = this.yawMoment(p, -st.yaw * YAW_RATE.manual, w[1]);
      const vw = worldVelocity(s);
      if (t.depthHold && Math.abs(st.heave) < 0.05) {
        if (this.depthRef === null) this.depthRef = s.position[1];
        // the held depth rises with the ground ahead, gently, so flying forward never ploughs into it
        const h = Math.hypot(vw[0], vw[2]);
        let floor = bed(s.position[0], s.position[2]);
        if (h > 0.05) for (const a of [0.6, 1.2, 1.8]) floor = Math.max(floor, bed(s.position[0] + (vw[0] / h) * a, s.position[2] + (vw[2] / h) * a));
        const least = floor + MIN_CLEARANCE + p.halfExtents[1];
        if (this.depthRef < least) this.depthRef = slew(this.depthRef, least, 0.5 * dt);
        const fy = 160 * clamp(this.depthRef - s.position[1], -0.5, 0.5) - 60 * vw[1];
        cmd.force[1] = clamp(qRotateInv(s.attitude, [0, fy, 0])[1] / p.maxForce[1], -1, 1);
      } else {
        this.depthRef = null;
        cmd.force[1] = st.heave;
      }
      this.integ = [0, 0, 0];
      this.vCmd = null;
      return cmd;
    }
    this.stick.reset();
    this.depthRef = null;

    let goal = t.hold;
    let prev: Waypoint | null = null;
    if (t.mode === "WAYPOINTS") {
      if (this.status.waypointIndex >= t.route.length) {
        this.status.done = true;
        goal = t.route[t.route.length - 1] ?? t.hold;
      } else {
        goal = t.route[this.status.waypointIndex];
        prev = this.status.waypointIndex > 0 ? t.route[this.status.waypointIndex - 1] : null;
      }
    }
    const hx = goal.x - s.position[0];
    const hz = goal.z - s.position[2];
    const hd = Math.hypot(hx, hz);
    // altitude is kept above the ground under and just ahead of the vehicle, not only at the goal, and anything in the
    // way (a wreck, a mound) is climbed over
    const look = (a: number) => bed(s.position[0] + (hd > 1e-6 ? (hx / hd) * Math.min(a, hd) : 0), s.position[2] + (hd > 1e-6 ? (hz / hd) * Math.min(a, hd) : 0));
    let gy = goal.altitude !== undefined ? look(0.8) + goal.altitude : goal.y;
    let least = -Infinity;
    for (const a of [0, 0.5, 1, 1.5, 2]) least = Math.max(least, look(a) + MIN_CLEARANCE + p.halfExtents[1]);
    gy = Math.max(gy, least);
    gy = Math.min(gy, -p.halfExtents[1]);
    const err: Vec3 = [hx, gy - s.position[1], hz];
    const dist = Math.hypot(err[0], err[1], err[2]);
    this.status.distanceM = dist;
    this.status.crossTrackM = prev ? crossTrack(prev, goal, s.position) : 0;
    if (t.mode === "WAYPOINTS" && !this.status.done) {
      if (goal.headingDeg === undefined) {
        if (dist < ARRIVE_RADIUS.rov) this.status.waypointIndex += 1;
      } else {
        // an inspection viewpoint counts once the camera faces it and has settled, or after a while in a strong current
        if (dist < ARRIVE_RADIUS.rov * (this.dwell > 0 ? 2 : 1)) this.dwell += dt;
        const facing = Math.abs(wrapPi(headingToYaw(goal.headingDeg) - e.yaw)) < 0.2;
        if ((this.dwell > VIEW_DWELL_S && facing) || this.dwell > 8) {
          this.status.waypointIndex += 1;
          this.dwell = 0;
        }
      }
    }

    // outer loop: desired world velocity toward the goal, saturated at the cruise speed
    const kp = 0.8;
    const vmax = Math.max(0.05, t.speed);
    const hk = Math.min(kp, vmax / Math.max(hd, 1e-6));
    // the vertical thrusters work independently; horizontal motion waits only when the ground ahead is above the keel
    const climb = clamp(1 - (least - s.position[1]) / 0.4, 0.1, 1);
    let vd: Vec3 = [hx * hk * climb, clamp(err[1] * 1.2, -0.4, 0.5), hz * hk * climb];
    // acceleration limit: waypoint changes become curves and ramps
    this.vCmd ??= worldVelocity(s);
    for (let i = 0; i < 3; i++) this.vCmd[i] = slew(this.vCmd[i], vd[i], (i === 1 ? 1.0 : 0.6) * dt);
    vd = [...this.vCmd];
    // inner loop: drag feedforward for the desired velocity, proportional on velocity error, and an integral of the
    // velocity error that learns the steady load (current, buoyancy). At rest the integral only stops when the
    // position error is zero, because the desired velocity is proportional to it.
    const vw = worldVelocity(s);
    for (let i = 0; i < 3; i++) this.integ[i] = clamp(this.integ[i] + (vd[i] - vw[i]) * dt, -3, 3);
    const fw: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) fw[i] = 55 * (vd[i] - vw[i]) + 40 * this.integ[i];
    const fb = qRotateInv(s.attitude, fw);
    const vdb = qRotateInv(s.attitude, vd);
    for (let i = 0; i < 3; i++) fb[i] += (p.dampLin[i] + p.dampLinQ[i] * Math.abs(vdb[i])) * vdb[i];
    cmd.force = [clamp(fb[0] / p.maxForce[0], -1, 1), clamp(fb[1] / p.maxForce[1], -1, 1), clamp(fb[2] / p.maxForce[2], -1, 1)];

    // heading: face the direction of travel on long legs, hold the waypoint's heading near it
    const travelHeading = Math.hypot(err[0], err[2]) > 1.0 ? (Math.atan2(err[0], -err[2]) / DEG + 360) % 360 : null;
    const hCmd = goal.headingDeg ?? travelHeading ?? this.status.headingCmdDeg ?? vehicleHeading(s);
    this.status.headingCmdDeg = hCmd;
    const yawErr = wrapPi(headingToYaw(hCmd) - e.yaw);
    cmd.moment[1] = this.yawMoment(p, clamp(1.4 * yawErr, -YAW_RATE.auto, YAW_RATE.auto), w[1]);
    return cmd;
  }
}

/** Signed distance from the leg a -> b, m (positive = to starboard of the leg). */
export function crossTrack(a: Waypoint, b: Waypoint, p: Vec3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const L = Math.hypot(dx, dz);
  if (L < 1e-6) return 0;
  // forward f = (dx, dz) / L in world XZ; starboard of f is (-fz, fx) (heading north (0, -1) has starboard east (1, 0))
  return (p[0] - a.x) * (-dz / L) + (p[2] - a.z) * (dx / L);
}

/**
 * AUV pilot: under-actuated (propeller plus rudder and elevator), so it flies paths, not points.
 * Speed: PI on surge speed through the water. Lateral: line-of-sight guidance with a lookahead distance, heading PD
 * to rudder. Vertical: depth (or altitude) error to a pitch command, pitch PD to elevator.
 */
export class AuvPilot {
  private speedInteg = 0;
  private yawInteg = 0;
  private pitchInteg = 0;
  private stick = new SmoothStick();
  status: PilotStatus = { waypointIndex: 0, distanceM: 0, headingCmdDeg: 0, done: false, crossTrackM: 0 };
  /** lookahead distance for line-of-sight guidance, m */
  lookahead = 4.5;

  reset(): void {
    this.speedInteg = 0;
    this.yawInteg = 0;
    this.pitchInteg = 0;
    this.stick.reset();
    this.status = { waypointIndex: 0, distanceM: 0, headingCmdDeg: 0, done: false, crossTrackM: 0 };
  }

  update(p: VehicleParams, s: VehicleState, t: PilotTarget, bed: (x: number, z: number) => number, dt: number): VehicleCommand {
    const cmd = zeroCommand();
    const e = qToEuler(s.attitude);
    const w = s.angularVelocity;
    const heading = yawToHeading(e.yaw);

    if (t.mode === "MANUAL") {
      const st = this.stick.update(t.stick, dt);
      // the propeller does not run astern: a torpedo hull has no steering backwards
      cmd.force[0] = Math.max(0, st.surge);
      cmd.rudder = st.yaw;
      // elevator flies a pitch: full stick is 20 degrees, and releasing it levels the vehicle
      cmd.elevator = clamp(4 * (clamp(st.heave * 0.35 - e.pitch, -0.2, 0.2) - w[2]), -1, 1);
      return cmd;
    }
    this.stick.reset();

    let goal = t.hold;
    let prev: Waypoint | null = null;
    if (t.mode === "WAYPOINTS" && t.route.length) {
      if (this.status.waypointIndex >= t.route.length) {
        this.status.done = true;
        goal = t.route[t.route.length - 1];
      } else {
        goal = t.route[this.status.waypointIndex];
        prev = this.status.waypointIndex > 0 ? t.route[this.status.waypointIndex - 1] : null;
      }
    }
    const dx = goal.x - s.position[0];
    const dz = goal.z - s.position[2];
    const horiz = Math.hypot(dx, dz);
    this.status.distanceM = horiz;
    if (t.mode === "WAYPOINTS" && !this.status.done && horiz < ARRIVE_RADIUS.auv) this.status.waypointIndex += 1;

    // HOLD for an AUV means loiter: circle the hold point at the arrive radius rather than stop (it cannot hover)
    let aimX = goal.x;
    let aimZ = goal.z;
    if (prev) {
      // line of sight: aim at the point `lookahead` metres down the leg from the vehicle's projection onto it
      const lx = goal.x - prev.x;
      const lz = goal.z - prev.z;
      const L = Math.hypot(lx, lz) || 1;
      const fx = lx / L;
      const fz = lz / L;
      const along = (s.position[0] - prev.x) * fx + (s.position[2] - prev.z) * fz;
      // a torpedo that missed the arrival circle has still flown past the point: never circle back for it
      if (t.mode === "WAYPOINTS" && !this.status.done && along > L) this.status.waypointIndex += 1;
      const ahead = Math.min(L, along + this.lookahead);
      aimX = prev.x + fx * ahead;
      aimZ = prev.z + fz * ahead;
      this.status.crossTrackM = crossTrack(prev, goal, s.position);
    } else this.status.crossTrackM = 0;
    const hCmd = this.status.done || (t.mode === "HOLD" && horiz < ARRIVE_RADIUS.auv * 2) ? (heading + 25) % 360 : (Math.atan2(aimX - s.position[0], -(aimZ - s.position[2])) / DEG + 360) % 360;
    this.status.headingCmdDeg = hCmd;
    let hErr = hCmd - heading;
    hErr = ((hErr + 540) % 360) - 180;
    // cascaded heading control: heading error to a turn-rate command, turn-rate error to rudder. A rate inner loop
    // keeps the directionally unstable hull (Munk moment) under control without a bang-bang limit cycle.
    // Heading rate (to starboard) is minus the yaw rate about +Y.
    const rCmd = clamp(0.8 * hErr * DEG, -0.22, 0.22);
    const rTurn = -w[1];
    this.yawInteg = clamp(this.yawInteg + (rCmd - rTurn) * dt, -0.4, 0.4);
    cmd.rudder = clamp(4 * (rCmd - rTurn) + 1.5 * this.yawInteg, -1, 1);

    // speed through the water
    const u = s.relativeVelocity[0];
    const uErr = t.speed - u;
    this.speedInteg = clamp(this.speedInteg + uErr * dt, -5, 5);
    cmd.force[0] = clamp((6 * uErr + 1.5 * this.speedInteg + 1.62 * t.speed * t.speed) / p.maxForce[0], 0, 1);

    // depth or altitude to pitch, pitch to elevator
    const gy = goal.altitude !== undefined ? bed(s.position[0] + 5 * Math.sin(heading * DEG), s.position[2] - 5 * Math.cos(heading * DEG)) + goal.altitude : goal.y;
    const vy = worldVelocity(s)[1];
    const pitchCmd = clamp(0.25 * (gy - s.position[1]) - 0.4 * vy, -0.35, 0.35);
    // pitch to a pitch-rate command, rate error to elevator, with an integral that learns the trim (residual buoyancy)
    const qCmd = clamp(1.0 * (pitchCmd - e.pitch), -0.2, 0.2);
    this.pitchInteg = clamp(this.pitchInteg + (pitchCmd - e.pitch) * dt, -1.5, 1.5);
    cmd.elevator = clamp(4 * (qCmd - w[2]) + 0.6 * this.pitchInteg, -1, 1);
    return cmd;
  }
}

/* ---------- envelope guard ---------- */

/**
 * The last thing every command passes through, whoever is flying. The closer a wall (site edge, quay, pier, wreck) or
 * the ground is, the slower the vehicle may close on it, so it comes to rest at a small stand-off instead of hitting.
 * The hard constraints in stepVehicle remain behind it. Returns whether it had to intervene.
 */
export function guardCommand(p: VehicleParams, s: VehicleState, cmd: VehicleCommand, c: Collider, floor: (x: number, z: number) => number, manual = true): boolean {
  const vw = worldVelocity(s);
  const hr = Math.max(p.halfExtents[0], p.halfExtents[2]);
  const [x, y, z] = s.position;
  let acted = false;
  const walls: { d: number; nx: number; nz: number }[] = [];
  const b = c.bounds;
  if (b) walls.push({ d: x - b.x0 - hr, nx: 1, nz: 0 }, { d: b.x1 - x - hr, nx: -1, nz: 0 }, { d: z - b.z0 - hr, nx: 0, nz: 1 }, { d: b.z1 - z - hr, nx: 0, nz: -1 });

  if (p.kind === "auv") {
    // it cannot stop sideways: turn back toward the middle while there is still room to turn
    if (b) {
      const e = qToEuler(s.attitude);
      const h = Math.hypot(vw[0], vw[2]);
      const fx = h > 0.2 ? vw[0] / h : Math.cos(e.yaw);
      const fz = h > 0.2 ? vw[2] / h : -Math.sin(e.yaw);
      // room ahead to the edge, against the distance a turn at the present speed needs
      const tx = fx > 1e-6 ? (b.x1 - x) / fx : fx < -1e-6 ? (b.x0 - x) / fx : Infinity;
      const tz = fz > 1e-6 ? (b.z1 - z) / fz : fz < -1e-6 ? (b.z0 - z) / fz : Infinity;
      const room = Math.min(tx, tz) - hr;
      const need = Math.min(9, 2.5 + 3.6 * h) * (manual ? 1 : 0.5);
      if (room < need) {
        const want = Math.atan2(-((b.z0 + b.z1) / 2 - z), (b.x0 + b.x1) / 2 - x);
        const err = wrapPi(want - e.yaw);
        // a yaw to port (positive) is a negative rudder; keep turning one way when the middle is right astern
        const dir = Math.abs(err) > 2.6 ? 1 : Math.sign(err);
        const k = clamp((need - room) / (0.4 * need), 0, 1);
        cmd.rudder = cmd.rudder * (1 - k) - dir * k;
        acted = k > 0.05;
      }
    }
    const ahead = Math.hypot(vw[0], vw[2]) * 5;
    const hd = Math.hypot(vw[0], vw[2]) || 1;
    let gap = y - p.halfExtents[1] - floor(x, z);
    for (const a of [0.2, 0.4, 0.6, 0.8, 1]) gap = Math.min(gap, y - p.halfExtents[1] - floor(x + (vw[0] / hd) * ahead * a, z + (vw[2] / hd) * ahead * a));
    const least = manual ? 1.2 : 0.7;
    if (gap < least) {
      const e = qToEuler(s.attitude);
      const k = clamp((least - gap) / 0.6, 0, 1);
      cmd.elevator = cmd.elevator * (1 - k) + clamp(4 * (clamp(0.35 - e.pitch, -0.3, 0.3) - s.angularVelocity[2]), -1, 1) * k;
      acted ||= k > 0.05;
    }
    const pitch = qToEuler(s.attitude).pitch;
    if (y > -0.8 && pitch > -0.05) cmd.elevator = Math.min(cmd.elevator, clamp(4 * (clamp(-0.15 - pitch, -0.2, 0.2) - s.angularVelocity[2]), -1, 1));
    return acted;
  }

  for (const q of c.cylinders) {
    const dx = x - q.x;
    const dz = z - q.z;
    const d = Math.hypot(dx, dz) || 1e-9;
    walls.push({ d: d - q.radius - hr, nx: dx / d, nz: dz / d });
  }
  for (const q of c.boxes ?? []) {
    if (y - p.halfExtents[1] > q.top + 0.1) continue;
    const g = boxGap(q, x, z);
    walls.push({ d: g.d - hr, nx: g.nx, nz: g.nz });
  }
  const push: Vec3 = [0, 0, 0];
  const fw = qRotate(s.attitude, [cmd.force[0] * p.maxForce[0], cmd.force[1] * p.maxForce[1], cmd.force[2] * p.maxForce[2]]);
  for (const q of walls) {
    if (q.d > 2.5) continue;
    const closing = -(vw[0] * q.nx + vw[2] * q.nz);
    const allowed = 0.7 * Math.max(0, q.d - 0.08);
    if (closing <= allowed && q.d > 0.08) continue;
    // brake the excess speed and take away the part of the thrust that pushes in; nudge out when too close
    const into = Math.max(0, -(fw[0] * q.nx + fw[2] * q.nz));
    const near = clamp(1 - q.d / 0.6, 0, 1);
    const f = 90 * Math.max(0, closing - allowed) + into * near + 60 * Math.max(0, 0.08 - q.d);
    push[0] += q.nx * f;
    push[2] += q.nz * f;
    acted = true;
  }
  const gap = y - p.halfExtents[1] - floor(x, z);
  if (gap < 1) {
    const sink = -vw[1];
    const allowed = 0.8 * Math.max(0, gap - 0.12);
    if (sink > allowed || gap < 0.12) {
      const into = Math.max(0, -fw[1]);
      push[1] += 110 * Math.max(0, sink - allowed) + into * clamp(1 - gap / 0.5, 0, 1) + 200 * Math.max(0, 0.12 - gap);
      acted = true;
    }
  }
  // the surface: rise into it gently
  const room = -p.halfExtents[1] * 0.5 - y;
  if (room < 1.2) {
    const allowed = 0.6 * Math.max(0, room - 0.05);
    if (vw[1] > allowed) {
      push[1] -= 110 * (vw[1] - allowed) + Math.max(0, fw[1]) * clamp(1 - room / 0.5, 0, 1);
      acted ||= room < 0.3;
    }
  }
  if (acted || push[1] !== 0) {
    const fb = qRotateInv(s.attitude, push);
    for (let i = 0; i < 3; i++) cmd.force[i] = clamp(cmd.force[i] + fb[i] / p.maxForce[i], -1, 1);
  }
  return acted;
}

/** Relative position of a world point in the vehicle's body frame. */
export const toBody = (s: VehicleState, p: Vec3) => qRotateInv(s.attitude, sub(p, s.position));

/**
 * Lawnmower (boustrophedon) survey route over a rectangle, legs along the longer side, spaced so adjacent swaths
 * overlap by `overlap` (0..0.9) of a swath of width `swathM`.
 */
export function lawnmower(area: { x0: number; z0: number; x1: number; z1: number }, swathM: number, overlap: number, y: number, altitude?: number): Waypoint[] {
  const spacing = Math.max(0.2, swathM * (1 - clamp(overlap, 0, 0.9)));
  const wx = Math.abs(area.x1 - area.x0);
  const wz = Math.abs(area.z1 - area.z0);
  const alongX = wx >= wz;
  const across = alongX ? wz : wx;
  const legs = Math.max(1, Math.floor(across / spacing) + 1);
  const out: Waypoint[] = [];
  for (let i = 0; i < legs; i++) {
    const c = Math.min(across, i * spacing);
    const fwd = i % 2 === 0;
    if (alongX) {
      const z = Math.min(area.z0, area.z1) + c;
      const a = fwd ? Math.min(area.x0, area.x1) : Math.max(area.x0, area.x1);
      const b = fwd ? Math.max(area.x0, area.x1) : Math.min(area.x0, area.x1);
      out.push({ x: a, z, y, altitude }, { x: b, z, y, altitude });
    } else {
      const x = Math.min(area.x0, area.x1) + c;
      const a = fwd ? Math.min(area.z0, area.z1) : Math.max(area.z0, area.z1);
      const b = fwd ? Math.max(area.z0, area.z1) : Math.min(area.z0, area.z1);
      out.push({ x, z: a, y, altitude }, { x, z: b, y, altitude });
    }
  }
  return out;
}
