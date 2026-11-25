// Six-degree-of-freedom rigid-body dynamics of an underwater vehicle. Pure, deterministic, SI units.
//
// Model (Fossen 2011, "Handbook of Marine Craft Hydrodynamics and Motion Control", ch. 6-8, simplified to diagonal
// mass and damping matrices; docs/PHYSICS.md section 4):
//
//   (m + A_lin) dv/dt = F - w x (m v + A_lin v_r) - A_lin (w x v_c)
//   (I + A_ang) dw/dt = M - w x ((I + A_ang) w) - v_r x (A_lin v_r)
//
// v is the body-frame velocity over ground, v_c the water velocity in the body frame, v_r = v - v_c the velocity
// RELATIVE TO THE WATER, w the body angular rate. Every hydrodynamic term (added mass, damping, fin lift) uses v_r;
// rigid-body inertia uses v. The current is assumed locally irrotational and slowly varying over the hull.
// The last angular term is the Munk moment from added mass, which makes a slender hull directionally unstable;
// fins (AUV) or active control (ROV) stabilise it.
//
// F and M collect: thrust (with first-order actuator lag), linear and quadratic damping on v_r and w, fin lift,
// and restoring forces from weight and buoyancy acting at the centre of gravity and centre of buoyancy.
// Integration: semi-implicit Euler at a fixed step chosen by the caller (the field engine uses 1/120 s).

import { G, waterDensity, type WaterState } from "./seawater";
import { add, cross, finite3, mul, qIdentity, qIntegrate, qRotate, qRotateInv, scale, sub, type Quat, type Vec3 } from "./math";

export type VehicleKind = "rov" | "auv";

export interface FinParams {
  /** lift force per (relative surge speed)^2 per radian of effective angle of attack, N s^2 / (m^2 rad) */
  liftPerU2Rad: number;
  /** body x of the fins' centre of pressure, m (negative = aft) */
  xFin: number;
  /** maximum deflection, rad */
  maxDeflection: number;
}

export interface VehicleParams {
  id: string;
  name: string;
  kind: VehicleKind;
  /** dry mass, kg */
  mass: number;
  /** displaced volume, m^3; buoyancy is rho g V for the water the vehicle is in */
  volume: number;
  /** centre of gravity and centre of buoyancy in the body frame, m */
  cg: Vec3;
  cb: Vec3;
  /** principal moments of inertia about body x, y, z, kg m^2 */
  inertia: Vec3;
  /** added mass, positive magnitudes: linear [surge, heave, sway] kg, angular [roll, yaw, pitch] kg m^2 */
  addedMassLin: Vec3;
  addedMassAng: Vec3;
  /** linear damping, positive: N/(m/s) and N m/(rad/s) */
  dampLin: Vec3;
  dampAng: Vec3;
  /** quadratic damping, positive: N/(m/s)^2 and N m/(rad/s)^2 */
  dampLinQ: Vec3;
  dampAngQ: Vec3;
  /** largest force and moment the thrusters can produce along each body axis (allocation-limited), N and N m */
  maxForce: Vec3;
  maxMoment: Vec3;
  /** thruster time constant, s */
  thrusterTau: number;
  /** horizontal (rudder) and vertical (elevator) fin sets, AUV only */
  fins?: { rudder: FinParams; elevator: FinParams };
  /**
   * Hull body lift of a slender body at an angle of attack: cross-flow force -c |u_r| v_lat at body x = xCp.
   * Prestero's combined Z_uw = -28.6 kg/m minus the fins' 9.64 leaves 18.96 for the hull.
   */
  bodyLift?: { coeff: number; xCp: number };
  /** collision box half extents in the body frame, m */
  halfExtents: Vec3;
  /** rated depth, m */
  maxDepthM: number;
  /** water density the vehicle is trimmed (ballasted) for, kg/m^3 */
  trimDensity: number;
  /** where the numbers come from, and how much to trust them */
  source: string;
}

/** Commanded actuation. Thrust components are fractions of maxForce / maxMoment in [-1, 1]. */
export interface VehicleCommand {
  force: Vec3;
  moment: Vec3;
  /** fin deflections as fractions of maxDeflection, [-1, 1]; rudder positive turns to starboard, elevator positive raises the nose */
  rudder: number;
  elevator: number;
}

export interface VehicleState {
  /** world position of the body origin, m */
  position: Vec3;
  /** attitude, body to world */
  attitude: Quat;
  /** body-frame velocity over ground, m/s */
  velocity: Vec3;
  /** body-frame angular rate, rad/s */
  angularVelocity: Vec3;
  /** actual (lagged) thruster wrench, body frame, N and N m */
  thrustForce: Vec3;
  thrustMoment: Vec3;
  /** last relative water velocity in the body frame, m/s, for telemetry */
  relativeVelocity: Vec3;
  /** true while the hull rests on the seabed or an obstacle */
  contact: boolean;
}

export interface Environmental {
  water: WaterState;
  /** water velocity at the vehicle, world m/s */
  current: Vec3;
  /** world Y of the sea surface; the vehicle cannot rise above it */
  surfaceY: number;
}

export interface Collider {
  /** seabed height at a horizontal position */
  bed: (x: number, z: number) => number;
  /** vertical cylinders the hull cannot enter */
  cylinders: { x: number; z: number; radius: number }[];
  /** solid boxes (yaw only) the hull cannot enter, e.g. a wreck */
  boxes?: SolidBox[];
  /** the water the vehicle may be in: it can never leave this rectangle */
  bounds?: { x0: number; x1: number; z0: number; z1: number };
}

export interface SolidBox {
  x: number;
  z: number;
  yawDeg: number;
  hx: number;
  hz: number;
  /** world Y of the top */
  top: number;
}

/** Horizontal position in a box's own frame. */
export function toBox(b: SolidBox, x: number, z: number): { lx: number; lz: number; c: number; s: number } {
  const r = (b.yawDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = x - b.x;
  const dz = z - b.z;
  return { lx: dx * c - dz * s, lz: dx * s + dz * c, c, s };
}

/** Horizontal gap to a box and the unit normal pointing away from it; negative inside. */
export function boxGap(b: SolidBox, x: number, z: number): { d: number; nx: number; nz: number } {
  const { lx, lz, c, s } = toBox(b, x, z);
  const ox = Math.abs(lx) - b.hx;
  const oz = Math.abs(lz) - b.hz;
  let nlx: number;
  let nlz: number;
  let d: number;
  if (ox > 0 && oz > 0) {
    d = Math.hypot(ox, oz);
    nlx = (Math.sign(lx) * ox) / d;
    nlz = (Math.sign(lz) * oz) / d;
  } else if (ox > oz) [d, nlx, nlz] = [ox, Math.sign(lx) || 1, 0];
  else [d, nlx, nlz] = [oz, 0, Math.sign(lz) || 1];
  return { d, nx: nlx * c + nlz * s, nz: -nlx * s + nlz * c };
}

export const zeroCommand = (): VehicleCommand => ({ force: [0, 0, 0], moment: [0, 0, 0], rudder: 0, elevator: 0 });

export function createVehicleState(position: Vec3, attitude: Quat = qIdentity()): VehicleState {
  return {
    position: [...position],
    attitude: [...attitude],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    thrustForce: [0, 0, 0],
    thrustMoment: [0, 0, 0],
    relativeVelocity: [0, 0, 0],
    contact: false,
  };
}

const clamp1 = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

/** Net weight minus buoyancy in water of a given density, N (positive sinks). */
export function netWeight(p: VehicleParams, rho: number): number {
  return p.mass * G - rho * G * p.volume;
}

/** Forces and moments acting on the vehicle this instant, body frame. Exposed for tests and telemetry. */
export interface Wrench {
  thrust: Vec3;
  damping: Vec3;
  fins: Vec3;
  restoring: Vec3;
  total: Vec3;
  moment: Vec3;
  rho: number;
}

/**
 * Advances the vehicle by dt. Mutates and returns state. Deterministic: identical inputs give identical outputs.
 */
export function stepVehicle(p: VehicleParams, s: VehicleState, cmd: VehicleCommand, env: Environmental, collider: Collider | null, dt: number): Wrench {
  const rho = waterDensity(env.water);
  const q = s.attitude;

  // actuators: first-order lag toward the saturated command
  const k = Math.min(1, dt / Math.max(1e-3, p.thrusterTau));
  const fCmd = mul([clamp1(cmd.force[0]), clamp1(cmd.force[1]), clamp1(cmd.force[2])], p.maxForce);
  const mCmd = mul([clamp1(cmd.moment[0]), clamp1(cmd.moment[1]), clamp1(cmd.moment[2])], p.maxMoment);
  for (let i = 0; i < 3; i++) {
    s.thrustForce[i] += (fCmd[i] - s.thrustForce[i]) * k;
    s.thrustMoment[i] += (mCmd[i] - s.thrustMoment[i]) * k;
  }

  const v = s.velocity;
  const w = s.angularVelocity;
  const vc = qRotateInv(q, env.current);
  const vr = sub(v, vc);
  s.relativeVelocity = vr;

  // damping on the relative velocity: -(Dl + Dq |v_r|) v_r
  const damping: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) damping[i] = -(p.dampLin[i] + p.dampLinQ[i] * Math.abs(vr[i])) * vr[i];
  const dampM: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) dampM[i] = -(p.dampAng[i] + p.dampAngQ[i] * Math.abs(w[i])) * w[i];

  // fins: lift proportional to u_r^2 times the effective angle of attack at the fin (deflection minus local flow angle)
  const fins: Vec3 = [0, 0, 0];
  const finM: Vec3 = [0, 0, 0];
  if (p.fins) {
    const u = vr[0];
    const uu = u * Math.abs(u);
    const { rudder, elevator } = p.fins;
    // rudder (vertical fins) push sideways (body z). Local sway velocity at the fin: v_z - w_y x_fin.
    const vzFin = vr[2] - w[1] * rudder.xFin;
    const dr = clamp1(cmd.rudder) * rudder.maxDeflection;
    // positive rudder turns to starboard: the stern is pushed to port (-z)
    const fz = rudder.liftPerU2Rad * (-uu * dr) - rudder.liftPerU2Rad * Math.abs(u) * vzFin;
    // elevator (horizontal fins) push vertically (body y). Local heave velocity at the fin: v_y + w_z x_fin.
    const vyFin = vr[1] + w[2] * elevator.xFin;
    const de = clamp1(cmd.elevator) * elevator.maxDeflection;
    // positive elevator raises the nose: the stern is pushed down (-y)
    const fy = elevator.liftPerU2Rad * (-uu * de) - elevator.liftPerU2Rad * Math.abs(u) * vyFin;
    fins[1] = fy;
    fins[2] = fz;
    // moments of fin forces applied at (xFin, 0, 0): r x F
    const mr = cross([rudder.xFin, 0, 0], [0, 0, fz]);
    const me = cross([elevator.xFin, 0, 0], [0, fy, 0]);
    finM[0] = mr[0] + me[0];
    finM[1] = mr[1] + me[1];
    finM[2] = mr[2] + me[2];
  }
  if (p.bodyLift) {
    // hull cross-flow lift at the centre of pressure, opposing the local cross-flow velocity there
    const { coeff, xCp } = p.bodyLift;
    const au = Math.abs(vr[0]);
    const fy = -coeff * au * (vr[1] + w[2] * xCp);
    const fz = -coeff * au * (vr[2] - w[1] * xCp);
    fins[1] += fy;
    fins[2] += fz;
    const m = cross([xCp, 0, 0], [0, fy, fz]);
    finM[0] += m[0];
    finM[1] += m[1];
    finM[2] += m[2];
  }

  // restoring: weight at CG, buoyancy at CB, both vertical in the world frame
  const W = p.mass * G;
  const B = rho * G * p.volume;
  const gBody = qRotateInv(q, [0, -W, 0]);
  const bBody = qRotateInv(q, [0, B, 0]);
  const restoring = add(gBody, bBody);
  const restM = add(cross(p.cg, gBody), cross(p.cb, bBody));

  const thrust = s.thrustForce;
  const F = add(add(add(thrust, damping), fins), restoring);
  const M = add(add(add(s.thrustMoment, dampM), finM), restM);

  // rigid body + added mass dynamics (diagonal mass), see header
  const mLin: Vec3 = [p.mass + p.addedMassLin[0], p.mass + p.addedMassLin[1], p.mass + p.addedMassLin[2]];
  const momentum = add(scale(v, p.mass), mul(p.addedMassLin, vr));
  const coriolis = cross(w, momentum);
  const currentTerm = mul(p.addedMassLin, cross(w, vc));
  const accel: Vec3 = [(F[0] - coriolis[0] - currentTerm[0]) / mLin[0], (F[1] - coriolis[1] - currentTerm[1]) / mLin[1], (F[2] - coriolis[2] - currentTerm[2]) / mLin[2]];

  const iTot: Vec3 = [p.inertia[0] + p.addedMassAng[0], p.inertia[1] + p.addedMassAng[1], p.inertia[2] + p.addedMassAng[2]];
  const gyro = cross(w, mul(iTot, w));
  const munk = cross(vr, mul(p.addedMassLin, vr));
  const alpha: Vec3 = [(M[0] - gyro[0] - munk[0]) / iTot[0], (M[1] - gyro[1] - munk[1]) / iTot[1], (M[2] - gyro[2] - munk[2]) / iTot[2]];

  // semi-implicit Euler: velocities first, then pose with the new velocities
  for (let i = 0; i < 3; i++) {
    v[i] += accel[i] * dt;
    w[i] += alpha[i] * dt;
  }
  if (!finite3(v) || !finite3(w)) {
    // a numerical blow-up must never poison the simulation: stop the vehicle where it is
    s.velocity = [0, 0, 0];
    s.angularVelocity = [0, 0, 0];
  }
  const vWorld = qRotate(q, s.velocity);
  s.position = add(s.position, scale(vWorld, dt));
  s.attitude = qIntegrate(q, s.angularVelocity, dt);

  // constraints: the surface, the seabed and solid obstacles
  s.contact = false;
  const r = Math.max(p.halfExtents[1], 0.05);
  if (s.position[1] > env.surfaceY - r * 0.5) {
    s.position[1] = env.surfaceY - r * 0.5;
    clipWorldVelocity(s, [0, 1, 0]);
  }
  if (collider) {
    // the lowest point of the hull, conservatively the largest half extent rotated toward down
    const down = qRotateInv(s.attitude, [0, -1, 0]);
    const reach = Math.abs(down[0]) * p.halfExtents[0] + Math.abs(down[1]) * p.halfExtents[1] + Math.abs(down[2]) * p.halfExtents[2];
    const bed = collider.bed(s.position[0], s.position[2]);
    if (s.position[1] - reach < bed) {
      s.position[1] = bed + reach;
      // the part of the velocity into the slope is lost, the rest slides along it with friction (time constant 0.4 s)
      const h = 0.15;
      const gx = (collider.bed(s.position[0] + h, s.position[2]) - collider.bed(s.position[0] - h, s.position[2])) / (2 * h);
      const gz = (collider.bed(s.position[0], s.position[2] + h) - collider.bed(s.position[0], s.position[2] - h)) / (2 * h);
      const nl = Math.hypot(gx, 1, gz);
      clipWorldVelocity(s, [gx / nl, -1 / nl, gz / nl]);
      const vw = qRotate(s.attitude, s.velocity);
      const k = Math.exp(-dt / 0.4);
      s.velocity = qRotateInv(s.attitude, [vw[0] * k, vw[1], vw[2] * k]);
      s.contact = true;
    }
    const hr = Math.max(p.halfExtents[0], p.halfExtents[2]);
    for (const c of collider.cylinders) {
      const dx = s.position[0] - c.x;
      const dz = s.position[2] - c.z;
      const d = Math.hypot(dx, dz);
      const minD = c.radius + hr;
      if (d < minD && d > 1e-9) {
        const nx = dx / d;
        const nz = dz / d;
        s.position[0] = c.x + nx * minD;
        s.position[2] = c.z + nz * minD;
        clipWorldVelocity(s, [-nx, 0, -nz]);
        s.contact = true;
      }
    }
    for (const b of collider.boxes ?? []) {
      if (s.position[1] - reach >= b.top) continue;
      const g = boxGap(b, s.position[0], s.position[2]);
      if (g.d >= hr) continue;
      const up = b.top + reach - s.position[1];
      if (up < hr - g.d) {
        // nearly clear of the top: rest on it instead of being thrown sideways
        s.position[1] = b.top + reach;
        clipWorldVelocity(s, [0, -1, 0]);
      } else {
        s.position[0] += g.nx * (hr - g.d);
        s.position[2] += g.nz * (hr - g.d);
        clipWorldVelocity(s, [-g.nx, 0, -g.nz]);
      }
      s.contact = true;
    }
    if (collider.bounds) {
      const { x0, x1, z0, z1 } = collider.bounds;
      const p0 = s.position;
      if (p0[0] < x0 + hr) clipWorldVelocity(s, [-1, 0, 0]);
      if (p0[0] > x1 - hr) clipWorldVelocity(s, [1, 0, 0]);
      if (p0[2] < z0 + hr) clipWorldVelocity(s, [0, 0, -1]);
      if (p0[2] > z1 - hr) clipWorldVelocity(s, [0, 0, 1]);
      p0[0] = Math.min(x1 - hr, Math.max(x0 + hr, p0[0]));
      p0[2] = Math.min(z1 - hr, Math.max(z0 + hr, p0[2]));
    }
  }
  return { thrust: [...thrust], damping, fins, restoring, total: F, moment: M, rho };
}

/** Removes the world-frame velocity component along `into` (a unit vector pointing into the obstacle), if positive. */
function clipWorldVelocity(s: VehicleState, into: Vec3): void {
  const vw = qRotate(s.attitude, s.velocity);
  const vn = vw[0] * into[0] + vw[1] * into[1] + vw[2] * into[2];
  if (vn <= 0) return;
  s.velocity = qRotateInv(s.attitude, [vw[0] - vn * into[0], vw[1] - vn * into[1], vw[2] - vn * into[2]]);
}

/** World-frame velocity over ground, m/s. */
export const worldVelocity = (s: VehicleState): Vec3 => qRotate(s.attitude, s.velocity);

/**
 * Representative vehicle parameter sets. These are NOT a calibration of a particular vehicle; they are published
 * identification values for vehicles of the class, simplified to diagonal matrices. Sources in docs/PHYSICS.md.
 */
export const VEHICLES: Record<"rov" | "auv", VehicleParams> = {
  // Observation-class ROV of the BlueROV2 Heavy type. Mass, inertia, added mass and damping after von Benzon et al.
  // 2022, "An Open-Source Benchmark Simulator: Control of a BlueROV2 Underwater Robot", J. Mar. Sci. Eng. 10, 1898.
  // Thrust limits from eight T200 thrusters at 16 V (about 45 N average per thruster), four vectored at 45 degrees.
  rov: {
    id: "rov",
    name: "Observation ROV (BlueROV2 Heavy class)",
    kind: "rov",
    mass: 13.5,
    // trimmed about 0.6 percent positive in sea water (1025): a real ROV floats up slowly with thrusters off
    volume: 13.5 / 1025 * 1.006,
    cg: [0, 0, 0],
    cb: [0, 0.02, 0],
    inertia: [0.26, 0.37, 0.23],
    addedMassLin: [6.36, 18.68, 7.12],
    addedMassAng: [0.189, 0.222, 0.135],
    dampLin: [13.7, 33.0, 0.0],
    dampAng: [0.0, 0.0, 0.8],
    dampLinQ: [141.0, 190.0, 217.0],
    dampAngQ: [1.19, 1.5, 0.47],
    maxForce: [127, 180, 127],
    // yaw authority sized so the quadratic yaw damping (1.5 N m s^2) caps the turn rate near 2.3 rad/s
    maxMoment: [15, 8, 15],
    thrusterTau: 0.1,
    halfExtents: [0.23, 0.13, 0.29],
    maxDepthM: 100,
    trimDensity: 1025,
    source: "von Benzon et al. 2022 (JMSE 10, 1898), BlueROV2 Heavy identification; representative, not calibrated to this vehicle",
  },
  // Small survey AUV of the REMUS 100 type. Parameters after Prestero 2001, "Verification of a six-degree of freedom
  // simulation model for the REMUS autonomous underwater vehicle", MIT/WHOI thesis, tables 4.x. Fin lift slope from
  // Prestero's Y_uudr = 9.64 kg/m/rad at x_fin = -0.638 m, so N_uudr = -6.15 follows from the geometry.
  auv: {
    id: "auv",
    name: "Survey AUV (REMUS 100 class)",
    kind: "auv",
    mass: 30.48,
    // Prestero's vehicle was 2.3 percent positive (W = 299 N, B = 306 N); survey AUVs are usually trimmed closer to
    // neutral, about 0.5 percent positive (1.5 N here), so a failed vehicle still surfaces while the elevator can trim
    // the residual lift at survey speed. Representative trim, not Prestero's.
    volume: (299 * 1.005) / (1025 * G),
    cg: [0, -0.0196, 0],
    cb: [0, 0, 0],
    inertia: [0.177, 3.45, 3.45],
    addedMassLin: [0.93, 35.5, 35.5],
    addedMassAng: [0.0704, 4.88, 4.88],
    dampLin: [0.5, 8, 8],
    dampAng: [0.05, 1.0, 1.0],
    dampLinQ: [1.62, 131, 131],
    dampAngQ: [0.13, 9.4, 9.4],
    // single stern propeller: surge thrust only; steering is by fins
    maxForce: [9, 0, 0],
    maxMoment: [0, 0, 0],
    thrusterTau: 0.3,
    fins: {
      rudder: { liftPerU2Rad: 9.64, xFin: -0.638, maxDeflection: (13.6 * Math.PI) / 180 },
      elevator: { liftPerU2Rad: 9.64, xFin: -0.638, maxDeflection: (13.6 * Math.PI) / 180 },
    },
    // Prestero's combined Z_uw = -28.6 less the fins' 9.64; its moment arm reproduces his combined M_uw = 24.0
    bodyLift: { coeff: 18.96, xCp: -0.235 },
    halfExtents: [0.67, 0.1, 0.1],
    maxDepthM: 100,
    trimDensity: 1025,
    source: "Prestero 2001 (MIT/WHOI thesis), REMUS 100 coefficients simplified to diagonal form; representative, not calibrated",
  },
};

/**
 * Re-ballasts a vehicle for water of another density, as an operator does before a fresh-water dive: the displaced
 * volume is unchanged and the mass is adjusted so the vehicle keeps the same fractional buoyancy margin.
 */
export function ballastFor(p: VehicleParams, rho: number): VehicleParams {
  const margin = (p.trimDensity * p.volume) / p.mass; // > 1 floats
  return { ...p, mass: (rho * p.volume) / margin, trimDensity: rho };
}
