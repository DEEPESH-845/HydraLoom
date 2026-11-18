// Single source of truth for physical dimensions and the gantry -> world mapping.
// See docs/BLUEPRINT.md section 2 and 3. Units: cm for gantry space, metres for world space.

export const TANK = {
  length: 1.2, // world X, m
  width: 0.6, // world Z, m
  height: 0.6, // glass height, m
  waterLevel: 0.5, // m above sand
  glass: 0.01,
  sandDepth: 0.03,
} as const;

export const GANTRY = {
  travelX: 100, // cm
  travelY: 40, // cm
  maxSpeed: 15, // cm/s at gantrySpeed = 1
  accel: 30, // cm/s^2
  stepCm: 5, // one RL action
  railHeight: 0.7, // world Y of the X rails
  frameHeight: 0.6, // world Y of tank rim
  arriveTolerance: 0.15, // cm
} as const;

export const CAMERA = {
  lensHeight: 0.42, // world Y of the lens, 8 cm below the surface
  hfovDeg: 75, // effective underwater horizontal FOV
  aspect: 4 / 3,
  fps: 30,
  resolution: "1280x960 (simulated)",
} as const;

export const DETECTION = {
  hz: 10,
  lockSeconds: 0.6,
  classifyThreshold: 0.65, // below this the reported class degrades
  // Geometry penalties are additive; light and water are multiplicative, so no light sees nothing
  // and fully silted water sees nothing. The water term is lib/optics/water.ts waterDetectability.
  // Calibrated in docs/BLUEPRINT.md 4.2.
  centeringWeight: 0.3,
  burialWeight: 0.15,
  lightingGamma: 0.3, // lighting^gamma
  minVisibleFraction: 0.3, // of the projected box inside the frame
  jitter: 0.01,
} as const;

export const RL = {
  maxSteps: 40,
  holdToFinish: 3,
  epsilonStart: 0.15,
  epsilonDecayEpisodes: 20,
  stepCost: 0.05,
  holdBonus: 1.0,
  confidenceWeight: 0.5,
} as const;

export const TEST = {
  scanWaypoints: [
    [15, 10],
    [50, 10],
    [85, 10],
    [85, 30],
    [50, 30],
    [15, 30],
  ] as ReadonlyArray<readonly [number, number]>,
  dwellSeconds: 1.2,
  coverageGrid: [12, 5] as const,
  coverageCenteringMin: 0.95, // a cell counts only inside the detection-grade frame centre
  seed: 1337,
} as const;

/** Gantry cm -> world metres (sand surface is world Y = 0). */
export function gantryToWorld(xCm: number, yCm: number): [number, number] {
  return [(xCm - 50) / 100, (yCm - 20) / 100];
}

/** World metres -> gantry cm. */
export function worldToGantry(wx: number, wz: number): [number, number] {
  return [wx * 100 + 50, wz * 100 + 20];
}

/** NaN and Infinity collapse to the lower bound so bad input can never poison the engine. */
export const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
