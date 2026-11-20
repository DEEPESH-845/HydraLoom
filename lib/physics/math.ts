// Small allocation-light vector and quaternion helpers for the physics layer.
// Pure TypeScript, no Three: the physics must run headless and bit-identical in Node and the browser.
//
// Conventions (docs/PHYSICS.md section 1):
// - World frame: Three.js metres, +Y up, +X east, -Z north (so +Z is south). Right-handed.
// - Body frame: +X forward (surge), +Y up (heave), +Z starboard (sway). Right-handed.
//   Angular rates about body X, Y, Z are roll, yaw and pitch. Positive yaw turns the nose to port,
//   positive pitch raises the nose, positive roll lowers the starboard side (docs/PHYSICS.md has the full table).
// - Quaternions are [x, y, z, w] and rotate body vectors into the world frame.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const finite3 = (a: Vec3) => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

export const DEG = Math.PI / 180;

/** Wraps an angle to (-pi, pi]. */
export function wrapPi(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** Wraps degrees to [0, 360). */
export const wrap360 = (d: number) => ((d % 360) + 360) % 360;

export const qIdentity = (): Quat => [0, 0, 0, 1];

export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

export function qNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 0)) return qIdentity();
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = len(axis);
  if (!(n > 0)) return qIdentity();
  const s = Math.sin(angle / 2) / n;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** Rotates v by q (body to world when q is the attitude). */
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 q.xyz x v; v' = v + w t + q.xyz x t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Rotates v by the inverse of q (world to body). */
export const qRotateInv = (q: Quat, v: Vec3): Vec3 => qRotate([-q[0], -q[1], -q[2], q[3]], v);

/** Integrates attitude by a body-frame angular rate over dt (exact for constant rate). */
export function qIntegrate(q: Quat, omegaBody: Vec3, dt: number): Quat {
  const w = len(omegaBody);
  if (!(w * dt > 1e-12)) return q;
  return qNormalize(qMul(q, qFromAxisAngle(omegaBody, w * dt)));
}

/**
 * Euler angles of an attitude in the body convention above, radians:
 * yaw about world +Y (positive = nose to port), pitch about body +Z (positive = nose up), roll about body +X.
 * Composition q = qYaw * qPitch * qRoll.
 */
export function qFromEuler(yaw: number, pitch: number, roll: number): Quat {
  return qMul(qMul(qFromAxisAngle([0, 1, 0], yaw), qFromAxisAngle([0, 0, 1], pitch)), qFromAxisAngle([1, 0, 0], roll));
}

export function qToEuler(q: Quat): { yaw: number; pitch: number; roll: number } {
  const fwd = qRotate(q, [1, 0, 0]);
  const up = qRotate(q, [0, 1, 0]);
  const yaw = Math.atan2(-fwd[2], fwd[0]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd[1])));
  // roll: angle of the body up vector around the forward axis, measured from the vertical plane through forward
  const right = qRotate(q, [0, 0, 1]);
  const roll = Math.atan2(-right[1], up[1]);
  return { yaw, pitch, roll };
}

/**
 * Compass heading (degrees clockwise from north, north = world -Z) to yaw about +Y (radians, counterclockwise from east)
 * and back. Heading 0 = north, 90 = east.
 */
export const headingToYaw = (headingDeg: number) => wrapPi((90 - headingDeg) * DEG);
export const yawToHeading = (yaw: number) => wrap360(90 - yaw / DEG);

/** World horizontal unit vector pointing toward a compass heading. */
export function headingVector(headingDeg: number): Vec3 {
  const h = headingDeg * DEG;
  return [Math.sin(h), 0, -Math.cos(h)];
}
