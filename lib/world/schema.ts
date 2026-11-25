// Environment definition schema, version 1. An environment describes a place and its water; it never creates a
// test platform. Platforms (gantry, ROV, AUV, station) are chosen separately (lib/platforms) and placed into it.
// docs/ARCHITECTURE.md section 3. Units are SI unless a field name says otherwise.

import type { WaterSpec } from "../optics/water";
import type { CurrentConfig } from "../physics/current";
import type { TerrainSpec } from "./terrain";

export const ENVIRONMENT_SCHEMA_VERSION = 1;

/** Ground-truth classes the field environments place. The lab's SHIPWRECK, MINE and DEBRIS come first. */
export const GT_CLASSES = ["SHIPWRECK", "MINE", "DEBRIS", "TIRE", "PIPELINE"] as const;
export type GtClass = (typeof GT_CLASSES)[number];

export type FieldEnvironmentId = "harbor" | "river" | "deepsea" | "reef" | "lake" | "ocean";
export type EnvironmentId = "gantry-lab" | FieldEnvironmentId;

export type SeabedMaterial = "sand" | "mud" | "gravel" | "ooze" | "coral-sand" | "silt";

/** Scenery placed in the environment. Solid kinds block vehicles and, when vertical, the current. */
export type AssetKind =
  | "piling"
  | "quay-wall"
  | "hull-section"
  | "mooring-chain"
  | "mooring-block"
  | "bridge-pier"
  | "rock"
  | "boulder"
  | "branch"
  | "weed"
  | "coral-branching"
  | "coral-massive"
  | "coral-plate"
  | "seagrass"
  | "nodule"
  | "outcrop"
  | "sponge"
  | "kelp";

export interface AssetPlacement {
  kind: AssetKind;
  /** explicit placements: world x, z, yaw degrees, uniform scale */
  at?: [number, number, number, number][];
  /** or seeded scatter: count inside a rectangle, with a clearance from targets */
  scatter?: { count: number; area: [number, number, number, number]; scale: [number, number]; seed: number };
  /** vertical cylinder radius per unit scale for collisions and the current field; absent = not solid */
  solidRadius?: number;
}

export interface TargetSpec {
  id: string;
  class: GtClass;
  /** model to draw */
  model: "wreck" | "mine" | "crate" | "tire" | "pipe" | "drum" | "anchor";
  x: number;
  z: number;
  /** height of the object centre above the local seabed, m */
  lift: number;
  yawDeg: number;
  /** half extents along the object's own x (length), y (height), z (width), m */
  halfExtents: [number, number, number];
  /** 0..1, how distinct the object is from its background (paint, shape, texture) */
  detectability: number;
  /** 0..1 fraction buried in the seabed */
  burial: number;
  /** a real survey's free-floating debris drifts with the current */
  floating?: boolean;
}

export interface EnvironmentDefinition {
  schemaVersion: typeof ENVIRONMENT_SCHEMA_VERSION;
  id: EnvironmentId;
  /** semantic version of this definition's data */
  version: string;
  name: string;
  /** the real testing problem the environment represents */
  purpose: string;
  kind: "lab" | "field";
  water: {
    type: "fresh" | "brackish" | "sea";
    temperatureC: number;
    salinityPsu: number;
    /** NTU at turbidity 0 and 1; NTU = lo + (hi - lo) t^2 */
    ntuRange: [number, number];
    optics: Omit<WaterSpec, "ntu">;
    /** vertical stratification: a thermocline/turbidity layer, applied by depth (lake) */
    stratification?: { depthM: number; thicknessM: number; extraNtu: number; temperatureBelowC: number };
  };
  light: {
    source: "surface" | "lamp";
    /** daylight entering the water against the default sun; absent = 1 (site parameters set it) */
    sunFactor?: number;
    /** what the 0..1 lighting control means */
    label: string;
  };
  geometry: {
    /** extent of the site, x and z, m; the playable area is centred on the origin */
    extentM: [number, number];
    terrain: TerrainSpec;
  };
  seabed: {
    material: SeabedMaterial;
    /** diffuse reflectance seen by the camera (contrast background) */
    reflectance: number;
    /** base colour of the seabed in sRGB hex */
    color: string;
    /** roughness length for the current's log layer, m */
    hydraulicRoughnessM: number;
  };
  current: Partial<CurrentConfig>;
  assets: AssetPlacement[];
  targets: TargetSpec[];
  particles: { density: number; marineSnow: boolean };
  defaults: { turbidity: number; lighting: number };
  /** typical operating depth for a vehicle in this environment, m below the surface */
  operatingDepthM: number;
  platforms: ("gantry" | "rov" | "auv" | "station")[];
  missions: string[];
  /** documented assumptions: every representative (not measured) value is listed here */
  assumptions: string[];
  references: string[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

const inRange = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Validates an environment definition. Returns every issue found (empty = valid). Hand written rather than a schema
 * library: the checks are physical (ranges with units), and the type above is the schema.
 */
export function validateEnvironment(d: EnvironmentDefinition): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const req = (cond: boolean, path: string, message: string) => {
    if (!cond) out.push({ path, message });
  };
  req(d.schemaVersion === ENVIRONMENT_SCHEMA_VERSION, "schemaVersion", `must be ${ENVIRONMENT_SCHEMA_VERSION}`);
  req(/^\d+\.\d+\.\d+$/.test(d.version), "version", "must be semver x.y.z");
  req(typeof d.name === "string" && d.name.length > 0, "name", "required");
  req(inRange(d.water.temperatureC, -2, 40), "water.temperatureC", "must be -2..40 C");
  req(inRange(d.water.salinityPsu, 0, 42), "water.salinityPsu", "must be 0..42 PSU");
  req(d.water.type !== "fresh" || d.water.salinityPsu < 0.5, "water.salinityPsu", "fresh water must be below 0.5 PSU");
  req(d.water.type !== "sea" || d.water.salinityPsu >= 25, "water.salinityPsu", "sea water must be at least 25 PSU");
  const [lo, hi] = d.water.ntuRange;
  req(inRange(lo, 0, 1000) && inRange(hi, 0, 1000) && hi > lo, "water.ntuRange", "must be 0 <= lo < hi <= 1000 NTU");
  const o = d.water.optics;
  req(inRange(o.cPerNtu, 0.05, 5), "water.optics.cPerNtu", "must be 0.05..5 m^-1 NTU^-1");
  req(inRange(o.particleAlbedo, 0.3, 1), "water.optics.particleAlbedo", "must be 0.3..1");
  req(inRange(o.particleBackscatterRatio, 0.001, 0.1), "water.optics.particleBackscatterRatio", "must be 0.001..0.1");
  req(inRange(o.particleSlope, -1, 3), "water.optics.particleSlope", "must be -1..3");
  req(inRange(o.cdom440, 0, 20), "water.optics.cdom440", "must be 0..20 m^-1");
  req(d.light.source === "surface" || d.light.source === "lamp", "light.source", "must be surface or lamp");
  req(inRange(d.geometry.extentM[0], 0.1, 2000) && inRange(d.geometry.extentM[1], 0.1, 2000), "geometry.extentM", "must be 0.1..2000 m");
  req(inRange(d.geometry.terrain.depthM, 0.1, 11000), "geometry.terrain.depthM", "must be 0.1..11000 m");
  req(inRange(d.seabed.reflectance, 0.01, 0.9), "seabed.reflectance", "must be 0.01..0.9");
  req(/^#[0-9a-f]{6}$/i.test(d.seabed.color), "seabed.color", "must be #rrggbb");
  req(inRange(d.seabed.hydraulicRoughnessM, 1e-5, 0.2), "seabed.hydraulicRoughnessM", "must be 1e-5..0.2 m");
  if (d.current.speedMps !== undefined) req(inRange(d.current.speedMps, 0, 3), "current.speedMps", "must be 0..3 m/s");
  if (d.current.headingDeg !== undefined) req(inRange(d.current.headingDeg, 0, 360), "current.headingDeg", "must be 0..360 degrees");
  if (d.current.turbulence !== undefined) req(inRange(d.current.turbulence, 0, 0.5), "current.turbulence", "must be 0..0.5");
  req(inRange(d.defaults.turbidity, 0, 1), "defaults.turbidity", "must be 0..1");
  req(inRange(d.defaults.lighting, 0, 1), "defaults.lighting", "must be 0..1");
  req(inRange(d.operatingDepthM, 0, 11000), "operatingDepthM", "must be 0..11000 m");
  req(d.operatingDepthM <= d.geometry.terrain.depthM + d.geometry.terrain.reliefM + 1e-9, "operatingDepthM", "must not be below the seabed");
  req(d.platforms.length > 0, "platforms", "at least one platform");
  req(d.kind === "lab" || !d.platforms.includes("gantry"), "platforms", "a gantry only exists in the lab");
  req(d.assumptions.length > 0, "assumptions", "list the representative values");
  const ids = new Set<string>();
  const [ex, ez] = d.geometry.extentM;
  d.targets.forEach((t, i) => {
    const p = `targets[${i}]`;
    req(!ids.has(t.id), `${p}.id`, "duplicate id");
    ids.add(t.id);
    req((GT_CLASSES as readonly string[]).includes(t.class), `${p}.class`, "unknown class");
    req(Math.abs(t.x) <= ex / 2 && Math.abs(t.z) <= ez / 2, `${p}`, "outside the site extent");
    req(t.halfExtents.every((h) => inRange(h, 0.01, 50)), `${p}.halfExtents`, "must be 0.01..50 m");
    req(inRange(t.detectability, 0, 1) && inRange(t.burial, 0, 1), `${p}`, "detectability and burial must be 0..1");
  });
  d.assets.forEach((a, i) => {
    req(!!a.at || !!a.scatter, `assets[${i}]`, "needs explicit placements or a scatter");
    if (a.scatter) req(a.scatter.count >= 0 && a.scatter.count <= 5000, `assets[${i}].scatter.count`, "must be 0..5000");
  });
  return out;
}
