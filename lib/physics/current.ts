// Water current velocity field. Pure, deterministic, SI units.
//
// WATER CURRENT VELOCITY IS NOT VEHICLE VELOCITY. This module returns the velocity of the water itself, in the world
// frame, at a point and time. Vehicles feel hydrodynamic forces from the RELATIVE velocity, vehicle minus water
// (lib/physics/vehicle.ts). Particles and free-floating objects are carried by this field.
//
// Convention (docs/PHYSICS.md section 2): the returned vector is [east, up, south] in m/s (world +X, +Y, +Z).
// `headingDeg` is the direction the water flows TOWARD, clockwise from north, the oceanographic convention
// (a "090 current" flows toward the east). This is the opposite of the meteorological wind convention.
//
// Fidelity: an analytical kinematic model, not computational fluid dynamics. It superposes
//   1. a mean flow with a log-law boundary layer over the seabed and an optional channel (bank) profile,
//   2. slow temporal variability in speed and direction,
//   3. potential flow around vertical cylinders (pilings, piers) plus an empirical wake with vortex shedding,
//   4. solenoidal (divergence-free) random Fourier modes for turbulence, advected with the mean flow (Taylor's
//      frozen-turbulence hypothesis).
// Each term is documented with its assumptions in docs/PHYSICS.md. Imported CFD data can replace the field through
// the same `CurrentField` interface (sample at a point and time).

import { mulberry32 } from "../sim/rng";
import { headingVector, type Vec3 } from "./math";

export interface CylinderObstacle {
  /** world metres, centre of a vertical cylinder that spans the whole water column */
  x: number;
  z: number;
  radius: number;
}

export type VerticalProfile = "uniform" | "log";

export interface ChannelProfile {
  /** horizontal axis the channel runs along */
  axis: "x" | "z";
  /** world coordinate of the channel centreline across that axis, m */
  centre: number;
  /** distance from the centreline to each bank, m; the flow is zero at the banks */
  halfWidth: number;
}

export interface CurrentConfig {
  /** mean horizontal speed at the reference height, m/s */
  speedMps: number;
  /** direction the water flows toward, degrees clockwise from north */
  headingDeg: number;
  /** mean vertical velocity, m/s, positive up (upwelling); tapers to zero at the seabed */
  verticalMps: number;
  /** 0..1, amplitude of slow fluctuations of the mean speed as a fraction of it (and up to 15 degrees of direction) */
  variability: number;
  /** turbulence intensity, the RMS velocity fluctuation over the mean speed, 0..0.5 */
  turbulence: number;
  profile: VerticalProfile;
  /** hydrodynamic roughness length of the seabed for the log layer, m (mud 2e-4, sand 1e-3, gravel 5e-3, reef 3e-2) */
  roughnessM: number;
  /** height above the seabed at which speedMps applies, m */
  referenceHeightM: number;
  channel?: ChannelProfile;
  obstacles: CylinderObstacle[];
  seed: number;
}

export const DEFAULT_CURRENT: CurrentConfig = {
  speedMps: 0,
  headingDeg: 90,
  verticalMps: 0,
  variability: 0,
  turbulence: 0.05,
  profile: "log",
  roughnessM: 1e-3,
  referenceHeightM: 1,
  obstacles: [],
  seed: 7,
};

/** Physical bounds every config is clamped to. */
export const CURRENT_LIMITS = { speedMps: [0, 3], verticalMps: [-0.5, 0.5], variability: [0, 1], turbulence: [0, 0.5] } as const;

const clampf = (v: number, lo: number, hi: number, fallback: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Sanitises a config: NaN and out-of-range values never reach the physics. */
export function sanitizeCurrent(c: Partial<CurrentConfig>, base: CurrentConfig = DEFAULT_CURRENT): CurrentConfig {
  const L = CURRENT_LIMITS;
  return {
    ...base,
    ...c,
    speedMps: clampf(c.speedMps ?? base.speedMps, L.speedMps[0], L.speedMps[1], base.speedMps),
    headingDeg: (((Number.isFinite(c.headingDeg) ? (c.headingDeg as number) : base.headingDeg) % 360) + 360) % 360,
    verticalMps: clampf(c.verticalMps ?? base.verticalMps, L.verticalMps[0], L.verticalMps[1], base.verticalMps),
    variability: clampf(c.variability ?? base.variability, L.variability[0], L.variability[1], base.variability),
    turbulence: clampf(c.turbulence ?? base.turbulence, L.turbulence[0], L.turbulence[1], base.turbulence),
    roughnessM: clampf(c.roughnessM ?? base.roughnessM, 1e-5, 0.2, base.roughnessM),
    referenceHeightM: clampf(c.referenceHeightM ?? base.referenceHeightM, 0.05, 50, base.referenceHeightM),
    obstacles: c.obstacles ?? base.obstacles,
  };
}

interface Mode {
  k: Vec3;
  a: Vec3;
  phase: number;
}

const KARMAN = 0.41;
/** Strouhal number of a circular cylinder over the subcritical Reynolds range. */
export const STROUHAL = 0.2;

/** Height above the seabed at a horizontal position; flat at y = 0 when the environment gives none. */
export type BedHeight = (x: number, z: number) => number;

/**
 * A current field bound to a seabed. sample() is pure in (point, time): the same inputs always give the same output,
 * so runs are reproducible and the field can be validated against hand calculations.
 */
export class CurrentField {
  readonly config: CurrentConfig;
  private readonly bed: BedHeight;
  private readonly modes: Mode[] = [];
  private readonly phases: [number, number, number];

  constructor(config: CurrentConfig, bed: BedHeight = () => 0) {
    this.config = sanitizeCurrent(config);
    this.bed = bed;
    const rand = mulberry32(this.config.seed >>> 0);
    // 12 solenoidal modes, wavelengths 0.6 to 12 m, log-spaced; isotropic directions
    const n = 12;
    for (let i = 0; i < n; i++) {
      const lambda = 0.6 * Math.pow(20, i / (n - 1));
      const kmag = (2 * Math.PI) / lambda;
      const u = 2 * rand() - 1;
      const th = 2 * Math.PI * rand();
      const s = Math.sqrt(1 - u * u);
      const dir: Vec3 = [s * Math.cos(th), u * 0.5, s * Math.sin(th)]; // flattened: eddies are wider than tall
      const dn = Math.hypot(...dir);
      const k: Vec3 = [(dir[0] / dn) * kmag, (dir[1] / dn) * kmag, (dir[2] / dn) * kmag];
      // amplitude direction perpendicular to k (k . a = 0 keeps the field divergence-free)
      const r: Vec3 = [2 * rand() - 1, 2 * rand() - 1, 2 * rand() - 1];
      const kk = k[0] * k[0] + k[1] * k[1] + k[2] * k[2];
      const proj = (r[0] * k[0] + r[1] * k[1] + r[2] * k[2]) / kk;
      const a: Vec3 = [r[0] - proj * k[0], r[1] - proj * k[1], r[2] - proj * k[2]];
      const an = Math.hypot(...a) || 1;
      // energy falls with wavenumber (Kolmogorov -5/3 in energy, so amplitude ~ k^-5/6 per log band, approximately)
      const w = Math.pow(kmag, -5 / 6);
      this.modes.push({ k, a: [(a[0] / an) * w, (a[1] / an) * w, (a[2] / an) * w], phase: 2 * Math.PI * rand() });
    }
    // normalise so each HORIZONTAL velocity component has variance 1 (times (turbulence * speed)^2 at sample time),
    // which is how turbulence intensity is measured by a current meter; the flattened modes give a weaker vertical
    // component, as near-bed turbulence has. A cosine mode of amplitude a carries variance a^2 / 2.
    let energyH = 0;
    for (const m of this.modes) energyH += 0.5 * (m.a[0] ** 2 + m.a[2] ** 2);
    const norm = Math.sqrt(2 / Math.max(1e-12, energyH));
    for (const m of this.modes) m.a = [m.a[0] * norm, m.a[1] * norm, m.a[2] * norm];
    this.phases = [2 * Math.PI * rand(), 2 * Math.PI * rand(), 2 * Math.PI * rand()];
  }

  /** Mean speed multiplier and heading offset (radians) from slow variability at time t. */
  private temporal(t: number): { gain: number; turn: number } {
    const v = this.config.variability;
    if (v <= 0) return { gain: 1, turn: 0 };
    const [p1, p2, p3] = this.phases;
    const gain = 1 + v * (0.6 * Math.sin((2 * Math.PI * t) / 37 + p1) + 0.4 * Math.sin((2 * Math.PI * t) / 11.3 + p2));
    const turn = v * 0.26 * Math.sin((2 * Math.PI * t) / 53 + p3); // up to 15 degrees
    return { gain: Math.max(0, gain), turn };
  }

  /** Fraction of the reference speed at a height above the bed. Log law, zero at the roughness height. */
  profileFactor(heightAboveBed: number): number {
    const c = this.config;
    if (c.profile === "uniform") return heightAboveBed > 0 ? 1 : 0;
    const z = Math.max(heightAboveBed, 0);
    if (z <= c.roughnessM) return 0;
    // u(z) / u(zref) = ln(z / z0) / ln(zref / z0); capped at 1.25 so a deep column does not run away
    return Math.min(1.25, Math.log(z / c.roughnessM) / Math.log(c.referenceHeightM / c.roughnessM));
  }

  /** Fraction of the centreline speed across a channel: a 1/7 power law from the banks, zero outside. */
  channelFactor(x: number, z: number): number {
    const ch = this.config.channel;
    if (!ch) return 1;
    const across = ch.axis === "x" ? z : x;
    const d = Math.abs(across - ch.centre) / Math.max(1e-6, ch.halfWidth);
    return d >= 1 ? 0 : Math.pow(1 - d * d, 1 / 7);
  }

  /** Friction velocity u* of the log layer at the reference speed, m/s (for telemetry and sediment response). */
  frictionVelocity(): number {
    const c = this.config;
    return (KARMAN * c.speedMps) / Math.log(c.referenceHeightM / c.roughnessM);
  }

  /** Mean (time-averaged, undisturbed) current at the reference height, world m/s. */
  mean(): Vec3 {
    const c = this.config;
    const h = headingVector(c.headingDeg);
    return [h[0] * c.speedMps, c.verticalMps, h[2] * c.speedMps];
  }

  /** Water velocity at world point p and time t, world m/s. */
  sample(p: Vec3, t: number): Vec3 {
    const c = this.config;
    const bedY = this.bed(p[0], p[2]);
    const hab = p[1] - bedY;
    if (!(hab > 0)) return [0, 0, 0];
    const { gain, turn } = this.temporal(t);
    const hd = (c.headingDeg * Math.PI) / 180 + turn;
    const ex = Math.sin(hd);
    const ez = -Math.cos(hd);
    const U = c.speedMps * gain * this.profileFactor(hab) * this.channelFactor(p[0], p[2]);

    let vx = ex * U;
    let vz = ez * U;
    // vertical flow is blocked by the bed: taper over the first metre
    let vy = c.verticalMps * Math.min(1, hab);

    // cylinders: potential flow plus an empirical wake, in each cylinder's flow-aligned frame (s downstream, n across)
    const Uc = c.speedMps * gain * this.channelFactor(p[0], p[2]); // the far field each cylinder sees at this depth
    for (const o of c.obstacles) {
      const dx = p[0] - o.x;
      const dz = p[2] - o.z;
      const r2 = dx * dx + dz * dz;
      const R = o.radius;
      if (r2 <= R * R) return [0, 0, 0]; // inside the solid
      const s = dx * ex + dz * ez;
      const n = dx * -ez + dz * ex;
      const R2 = R * R;
      const r4 = r2 * r2;
      // perturbation of uniform flow U around a cylinder: u_s = U (1 - R^2 (s^2 - n^2) / r^4), u_n = -2 U R^2 s n / r^4
      let ds = (-U * R2 * (s * s - n * n)) / r4;
      let dn = (-2 * U * R2 * s * n) / r4;
      if (s > 0 && Uc > 1e-4) {
        // empirical far wake behind a bluff body: Gaussian velocity deficit that widens and decays downstream
        const xd = s / (2 * R);
        const sigma = R * Math.sqrt(1 + 0.5 * xd);
        const deficit = 0.9 / Math.sqrt(1 + xd) * Math.exp(-(n * n) / (2 * sigma * sigma));
        ds -= U * deficit;
        // vortex shedding at the Strouhal frequency f = St U / D: an oscillating cross-flow, travelling with the wake
        const f = (STROUHAL * Uc) / (2 * R);
        const travel = 0.85 * Uc;
        dn += 0.35 * U * deficit * Math.sin(2 * Math.PI * f * (t - s / Math.max(1e-3, travel)));
      }
      vx += ds * ex - dn * ez;
      vz += ds * ez + dn * ex;
    }

    // turbulence: solenoidal Fourier modes frozen into the mean flow (x - U t)
    const sigma = c.turbulence * Math.max(c.speedMps * gain, 0.02) * Math.min(1, hab / 0.3);
    if (sigma > 0) {
      const ax = p[0] - ex * c.speedMps * t;
      const ay = p[1];
      const az = p[2] - ez * c.speedMps * t;
      for (const m of this.modes) {
        const cs = Math.cos(m.k[0] * ax + m.k[1] * ay + m.k[2] * az + m.phase) * sigma;
        vx += m.a[0] * cs;
        vy += m.a[1] * cs;
        vz += m.a[2] * cs;
      }
    }
    return [vx, vy, vz];
  }
}
