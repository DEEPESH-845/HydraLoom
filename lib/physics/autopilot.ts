// Guidance and control for the field vehicles. Pure and deterministic; state lives in the controller objects.
// These are conventional, hand-tuned PID and line-of-sight controllers (docs/PHYSICS.md section 5). They are not
// trained policies, and the UI says so.

import { DEG, qRotateInv, qToEuler, sub, wrapPi, yawToHeading, headingToYaw, type Vec3 } from "./math";
import { worldVelocity, zeroCommand, type VehicleCommand, type VehicleParams, type VehicleState } from "./vehicle";

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

/**
 * ROV pilot: fully actuated, so position and heading are controlled directly.
 * Outer loop: position error to a desired velocity, saturated at cruise speed. Inner loop: velocity error to force,
 * with an integral on position that learns the steady current load (so station keeping holds in a current).
 */
export class RovPilot {
  private integ: Vec3 = [0, 0, 0];
  private depthRef: number | null = null;
  status: PilotStatus = { waypointIndex: 0, distanceM: 0, headingCmdDeg: 0, done: false, crossTrackM: 0 };

  reset(): void {
    this.integ = [0, 0, 0];
    this.depthRef = null;
    this.status = { waypointIndex: 0, distanceM: 0, headingCmdDeg: 0, done: false, crossTrackM: 0 };
  }

  update(p: VehicleParams, s: VehicleState, t: PilotTarget, bed: (x: number, z: number) => number, dt: number): VehicleCommand {
    const cmd = zeroCommand();
    const e = qToEuler(s.attitude);
    const w = s.angularVelocity;
    // attitude: always self-level roll and pitch (the frame is passively stable too)
    cmd.moment[0] = clamp((-8 * e.roll - 2 * w[0]) / p.maxMoment[0], -1, 1);
    cmd.moment[2] = clamp((-8 * e.pitch - 2 * w[2]) / p.maxMoment[2], -1, 1);

    if (t.mode === "MANUAL") {
      const st = t.stick;
      cmd.force[0] = clamp(st.surge, -1, 1);
      cmd.force[2] = clamp(st.sway, -1, 1);
      // yaw to starboard is negative yaw about +Y
      cmd.moment[1] = clamp(-st.yaw, -1, 1);
      if (t.depthHold && Math.abs(st.heave) < 0.05) {
        if (this.depthRef === null) this.depthRef = s.position[1];
        const vy = worldVelocity(s)[1];
        const fy = 160 * (this.depthRef - s.position[1]) - 60 * vy;
        cmd.force[1] = clamp(qRotateInv(s.attitude, [0, fy, 0])[1] / p.maxForce[1], -1, 1);
      } else {
        this.depthRef = null;
        cmd.force[1] = clamp(st.heave, -1, 1);
      }
      this.integ = [0, 0, 0];
      return cmd;
    }
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
    const gy = goal.altitude !== undefined ? bed(goal.x, goal.z) + goal.altitude : goal.y;
    const err: Vec3 = [goal.x - s.position[0], gy - s.position[1], goal.z - s.position[2]];
    const dist = Math.hypot(err[0], err[1], err[2]);
    this.status.distanceM = dist;
    this.status.crossTrackM = prev ? crossTrack(prev, goal, s.position) : 0;
    if (t.mode === "WAYPOINTS" && !this.status.done && dist < ARRIVE_RADIUS.rov) {
      this.status.waypointIndex += 1;
    }

    // outer loop: desired world velocity toward the goal, saturated at the cruise speed
    const kp = 0.8;
    let vd: Vec3 = [err[0] * kp, err[1] * kp, err[2] * kp];
    const vm = Math.hypot(vd[0], vd[1], vd[2]);
    const vmax = Math.max(0.05, t.speed);
    if (vm > vmax) vd = [(vd[0] * vmax) / vm, (vd[1] * vmax) / vm, (vd[2] * vmax) / vm];
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
    cmd.moment[1] = clamp((6 * yawErr - 2.5 * w[1]) / p.maxMoment[1], -1, 1);
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
  status: PilotStatus = { waypointIndex: 0, distanceM: 0, headingCmdDeg: 0, done: false, crossTrackM: 0 };
  /** lookahead distance for line-of-sight guidance, m */
  lookahead = 6;

  reset(): void {
    this.speedInteg = 0;
    this.yawInteg = 0;
    this.pitchInteg = 0;
    this.status = { waypointIndex: 0, distanceM: 0, headingCmdDeg: 0, done: false, crossTrackM: 0 };
  }

  update(p: VehicleParams, s: VehicleState, t: PilotTarget, bed: (x: number, z: number) => number, dt: number): VehicleCommand {
    const cmd = zeroCommand();
    const e = qToEuler(s.attitude);
    const w = s.angularVelocity;
    const heading = yawToHeading(e.yaw);

    if (t.mode === "MANUAL") {
      cmd.force[0] = clamp(t.stick.surge, -1, 1);
      cmd.rudder = clamp(t.stick.yaw, -1, 1);
      cmd.elevator = clamp(t.stick.heave, -1, 1);
      return cmd;
    }

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
