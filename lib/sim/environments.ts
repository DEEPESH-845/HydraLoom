// Test environments: the same survey rig and objects, placed in different water.
// Pure data and functions, no React or Three; shared by the engine, detection, the UI and the renderer.
// Water parameters follow lib/optics/water.ts; sources in docs/RESOURCES.md section 2.

import { CAMERA, TANK } from "./constants";
import type { WaterSpec } from "../optics/water";

export type EnvironmentId = "tank" | "harbor" | "river" | "deepsea";

export const ENVIRONMENT_IDS: readonly EnvironmentId[] = ["tank", "harbor", "river", "deepsea"];

/** Where the light that reaches the seabed comes from. */
export type LightSource = "surface" | "lamp";

export interface Environment {
  id: EnvironmentId;
  name: string;
  /** the real testing problem this environment stands for */
  problem: string;
  /** water above the sand, m; sets how much daylight survives to the floor */
  columnM: number;
  /** "surface": daylight attenuated by Kd over the column; "lamp": only the rig's own lamps, beside the lens */
  light: LightSource;
  /** NTU at turbidity 0 and 1; NTU grows with the square of the 0..1 control */
  ntuRange: [number, number];
  /** water other than turbidity: dissolved organic matter and the character of the particles */
  water: Omit<WaterSpec, "ntu">;
  /** diffuse reflectance of the seabed the objects are seen against */
  seabedReflectance: number;
  /** what the lighting control means here */
  lightingLabel: string;
  /** starting values when the environment is selected */
  defaults: { turbidity: number; lighting: number };
}

/**
 * Particle optics: mineral clay scatters strongly (albedo 0.95, Petzold bb/b 0.019). The harbour is grey-green
 * coastal water: mostly mineral silt with a little dissolved organic matter (CDOM a_g(440) 0.12 m^-1). The river is
 * silt-laden, grey-brown water after rain: fine mineral sediment with a flat spectral slope and moderate CDOM (0.9),
 * not a tannin-stained blackwater river (a_g(440) 1 to 3). The open deep ocean has about 0.005. These are
 * representative values for each water class, not a measurement of a particular site.
 */
export const ENVIRONMENTS: Record<EnvironmentId, Environment> = {
  tank: {
    id: "tank",
    name: "Lab tank",
    problem: "Controlled baseline. Repeatable runs, known ground truth, the calibration anchor for every other water.",
    columnM: TANK.waterLevel,
    light: "surface",
    ntuRange: [0, 20],
    water: { cPerNtu: 1.0, particleAlbedo: 0.95, particleBackscatterRatio: 0.019, particleSlope: 0.5, cdom440: 0.01 },
    seabedReflectance: 0.25,
    lightingLabel: "Lab lighting",
    defaults: { turbidity: 0.15, lighting: 0.8 },
  },
  harbor: {
    id: "harbor",
    name: "Harbor",
    problem: "Pier, piling and hull inspection in grey-green coastal water over mud. How close must the camera get, and with how much light?",
    columnM: 6,
    light: "surface",
    ntuRange: [1, 40],
    water: { cPerNtu: 1.0, particleAlbedo: 0.92, particleBackscatterRatio: 0.018, particleSlope: 0.7, cdom440: 0.12 },
    seabedReflectance: 0.12,
    lightingLabel: "Daylight",
    defaults: { turbidity: 0.2, lighting: 0.8 },
  },
  river: {
    id: "river",
    name: "River",
    problem: "Bridge pier and riverbed inspection in grey-brown, silt-laden water. Does the camera still find objects in a spate?",
    columnM: 1.2,
    light: "surface",
    ntuRange: [2, 150],
    water: { cPerNtu: 1.0, particleAlbedo: 0.95, particleBackscatterRatio: 0.022, particleSlope: 0.0, cdom440: 0.9 },
    seabedReflectance: 0.18,
    lightingLabel: "Daylight",
    defaults: { turbidity: 0.1, lighting: 0.8 },
  },
  deepsea: {
    id: "deepsea",
    name: "Deep sea",
    problem: "Abyssal survey with no daylight. Only the rig's lamps light the scene: sizing lamp power against backscatter.",
    columnM: 1500,
    light: "lamp",
    ntuRange: [0.02, 2],
    water: { cPerNtu: 1.0, particleAlbedo: 0.9, particleBackscatterRatio: 0.015, particleSlope: 1.0, cdom440: 0.005 },
    seabedReflectance: 0.3,
    lightingLabel: "Lamp power",
    defaults: { turbidity: 0.3, lighting: 0.8 },
  },
};

export const isEnvironmentId = (v: unknown): v is EnvironmentId => typeof v === "string" && (ENVIRONMENT_IDS as readonly string[]).includes(v);

const unit = (t: number) => Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));

/** NTU for the 0..1 turbidity control in an environment. */
export function environmentNtu(env: Environment, turbidity: number): number {
  const [lo, hi] = env.ntuRange;
  return lo + (hi - lo) * unit(turbidity) ** 2;
}

/** Full water description for an environment at a turbidity setting. */
export function environmentWater(env: Environment, turbidity: number): WaterSpec {
  return { ...env.water, ntu: environmentNtu(env, turbidity) };
}

/**
 * Light paths for the contrast model in lib/optics/water.ts.
 * Daylight: the object is lit through the water above it, and the veil is scattered by the water between lens and
 * object, so it is lit at the depth of that path's midpoint.
 * Lamp: light starts at the lens, so the object is lit over the viewing distance and the veil about half way along it.
 * components/lab/water.ts evaluates the same paths per pixel.
 */
export function lightPaths(env: Environment, objectHeightM: number, viewDistanceM: number): { objectDepthM: number; veilDepthM: number } {
  if (env.light === "lamp") return { objectDepthM: viewDistanceM, veilDepthM: viewDistanceM / 2 };
  return { objectDepthM: env.columnM - objectHeightM, veilDepthM: env.columnM - (CAMERA.lensHeight + objectHeightM) / 2 };
}
