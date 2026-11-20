// Procedural seabed height fields. Pure functions of (spec, x, z), shared by the renderer (mesh vertices), the
// physics (collision, the current's boundary layer) and target placement, so what is drawn is what is simulated.
// World frame: metres, +Y up, the sea surface at y = 0, so the seabed height is minus the local depth.

export type TerrainKind = "basin" | "channel" | "abyssal" | "reef" | "lake" | "ocean" | "flat";

export interface TerrainSpec {
  kind: TerrainKind;
  /** depth of the seabed at the site origin, m (positive) */
  depthM: number;
  /** amplitude of the large-scale relief, m */
  reliefM: number;
  /** wavelength of the large-scale relief, m */
  reliefWavelengthM: number;
  /** amplitude of the small-scale roughness (ripples, rubble), m */
  roughnessM: number;
  /** wavelength of the small-scale roughness, m */
  roughnessWavelengthM: number;
  seed: number;
  /** channel: half width of the bed and how much shallower the banks are; basin: the quay wall line */
  channel?: { axis: "x" | "z"; halfWidthM: number; bankRiseM: number };
  basin?: { quayZ: number; quayDepthM: number };
  /** reef: coral heads (bommies) as smooth mounds, world x, z, radius, height */
  mounds?: [number, number, number, number][];
  /** lake: shore distance from the origin where the depth reaches zero */
  shoreRadiusM?: number;
}

function hash2(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [-1, 1]. */
export function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return 2 * (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) - 1;
}

/** Fractal sum of value noise, normalised to about [-1, 1]. */
export function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f, z * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Seabed height (world Y, negative below the surface) at a horizontal position. */
export function terrainHeight(t: TerrainSpec, x: number, z: number): number {
  const relief = t.reliefM * fbm(x / t.reliefWavelengthM, z / t.reliefWavelengthM, t.seed, 3);
  const rough = t.roughnessM * fbm(x / t.roughnessWavelengthM, z / t.roughnessWavelengthM, t.seed + 101, 3);
  let y = -t.depthM + relief + rough;
  switch (t.kind) {
    case "channel": {
      const ch = t.channel!;
      const across = ch.axis === "x" ? z : x;
      const along = ch.axis === "x" ? x : z;
      const d = Math.abs(across) / ch.halfWidthM;
      // trapezoidal channel with rounded toe: flat bed, then banks rising toward the edges
      y += ch.bankRiseM * smooth(0.55, 1.25, d);
      // flow-transverse dunes on the bed, crests across the flow, about 1.5 m apart
      y += 0.07 * Math.sin((along / 1.5) * 2 * Math.PI + 0.6 * fbm(along / 6, across / 6, t.seed + 7, 2)) * (1 - smooth(0.4, 0.8, d));
      break;
    }
    case "basin": {
      const b = t.basin!;
      // dredged berth deepest along the quay, shoaling away from it
      const off = Math.abs(z - b.quayZ);
      y -= (b.quayDepthM - t.depthM) * (1 - smooth(0, 18, off));
      break;
    }
    case "reef": {
      for (const [mx, mz, r, h] of t.mounds ?? []) {
        const d2 = ((x - mx) ** 2 + (z - mz) ** 2) / (r * r);
        if (d2 < 4) y += h * Math.exp(-d2 * 1.6) * (0.85 + 0.15 * fbm(x * 1.7, z * 1.7, t.seed + 31, 2));
      }
      // sand grooves between the heads
      y += 0.05 * Math.sin((x + 0.6 * z) * 2.2);
      break;
    }
    case "lake": {
      const R = t.shoreRadiusM ?? 60;
      const r = Math.hypot(x, z) / R;
      y = -t.depthM * (1 - smooth(0.45, 1.05, r)) + relief + rough;
      break;
    }
    case "ocean": {
      // long sand waves on top of the large relief
      y += 0.6 * Math.sin((x * 0.8 + z * 0.6) / 9) * (0.6 + 0.4 * fbm(x / 60, z / 60, t.seed + 3, 2));
      break;
    }
    case "abyssal":
    case "flat":
    default:
      break;
  }
  return y;
}
