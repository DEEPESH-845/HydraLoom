// Environment library, schema version 1. Data only. Each environment is a distinct place: its own water, seabed,
// terrain, current regime, scenery and ground-truth targets. None of them contains a test platform; the platform is
// chosen separately and placed in by the field engine (lib/field/engine.ts).
//
// Every optical and physical value here is REPRESENTATIVE of the water class, not a measurement of a real site.
// Sources and the reasoning behind each value: docs/PHYSICS.md section 6 and docs/RESOURCES.md section 2.

import { ENVIRONMENTS as TANK_ENVIRONMENTS } from "../sim/environments";
import { ENVIRONMENT_SCHEMA_VERSION, type EnvironmentDefinition, type EnvironmentId, type FieldEnvironmentId } from "./schema";

const COMMON_ASSUMPTIONS = [
  "Particle beam attenuation is 1.0 m^-1 per NTU (uncalibrated; docs/HANDOFF.md section 7).",
  "Optical properties are representative of the water class, not measured at a site.",
  "The current is an analytical kinematic field (lib/physics/current.ts), not CFD.",
];

const gantryLab: EnvironmentDefinition = {
  schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
  id: "gantry-lab",
  version: "1.0.0",
  name: "Gantry Lab",
  purpose: "Controlled, repeatable computer vision and hardware experiments on the physical bench-top testbed.",
  kind: "lab",
  water: {
    type: "fresh",
    temperatureC: 20,
    salinityPsu: 0,
    ntuRange: [...TANK_ENVIRONMENTS.tank.ntuRange],
    optics: { ...TANK_ENVIRONMENTS.tank.water },
  },
  light: { source: "surface", label: "Lab lighting" },
  geometry: { extentM: [1.2, 0.6], terrain: { kind: "flat", depthM: 0.5, reliefM: 0.005, reliefWavelengthM: 0.3, roughnessM: 0.002, roughnessWavelengthM: 0.02, seed: 1 } },
  seabed: { material: "sand", reflectance: TANK_ENVIRONMENTS.tank.seabedReflectance, color: "#8f7d5c", hydraulicRoughnessM: 1e-3 },
  current: { speedMps: 0 },
  assets: [],
  targets: [],
  particles: { density: 1, marineSnow: false },
  defaults: { ...TANK_ENVIRONMENTS.tank.defaults },
  operatingDepthM: 0.08,
  platforms: ["gantry"],
  missions: ["detection", "classification", "localization", "coverage", "calibration"],
  assumptions: ["The tank, gantry and objects follow docs/BLUEPRINT.md; the six objects are defined in lib/sim/scenario.ts.", ...COMMON_ASSUMPTIONS.slice(0, 1)],
  references: ["docs/BLUEPRINT.md", "docs/RESOURCES.md section 9 (Lab tank)"],
};

const harbor: EnvironmentDefinition = {
  schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
  id: "harbor",
  version: "1.0.0",
  name: "Harbor / Port",
  purpose: "ROV inspection of quay walls, pilings, hulls and the berth floor in grey-green coastal water over mud.",
  kind: "field",
  water: {
    type: "sea",
    temperatureC: 14,
    salinityPsu: 30,
    ntuRange: [1, 40],
    optics: { ...TANK_ENVIRONMENTS.harbor.water },
  },
  light: { source: "surface", label: "Daylight" },
  geometry: {
    extentM: [40, 30],
    terrain: { kind: "basin", depthM: 7, reliefM: 0.35, reliefWavelengthM: 14, roughnessM: 0.06, roughnessWavelengthM: 1.2, seed: 11, basin: { quayZ: -14, quayDepthM: 9 } },
  },
  seabed: { material: "mud", reflectance: TANK_ENVIRONMENTS.harbor.seabedReflectance, color: "#3f3d31", hydraulicRoughnessM: 2e-4 },
  current: { speedMps: 0.25, headingDeg: 70, turbulence: 0.12, variability: 0.3, profile: "log", referenceHeightM: 1 },
  assets: [
    { kind: "quay-wall", at: [[0, -14.6, 0, 1]] },
    { kind: "piling", at: [-15, -11, -7, -3, 1, 5, 9, 13].map((x, i) => [x, -11.2, i * 37, 1] as [number, number, number, number]), solidRadius: 0.3 },
    { kind: "hull-section", at: [[3, -6.5, 2, 1]] },
    { kind: "mooring-block", at: [[-10, 2, 15, 1], [11, 4, -20, 1]] },
    { kind: "mooring-chain", at: [[-10, 2, 15, 1], [11, 4, -20, 1]] },
    { kind: "boulder", scatter: { count: 14, area: [-19, -9, 19, 14], scale: [0.4, 1.0], seed: 5 } },
    { kind: "weed", scatter: { count: 70, area: [-19, -13, 19, 14], scale: [0.4, 1.2], seed: 6 } },
  ],
  // wrecks: the lab hull is 0.98; field hulls are discounted for weathering (0.9 to 0.92) and for reef growth (0.82)
  targets: [
    { id: "mine-h1", class: "MINE", model: "mine", x: -5.2, z: -8.4, lift: 0.42, yawDeg: 20, halfExtents: [0.5, 0.5, 0.5], detectability: 0.9, burial: 0.15 },
    { id: "tire-h1", class: "TIRE", model: "tire", x: 6.5, z: 1.5, lift: 0.08, yawDeg: 0, halfExtents: [0.38, 0.12, 0.38], detectability: 0.8, burial: 0.25 },
    { id: "tire-h2", class: "TIRE", model: "tire", x: -12, z: 6, lift: 0.1, yawDeg: 30, halfExtents: [0.38, 0.12, 0.38], detectability: 0.8, burial: 0.1 },
    { id: "crate-h1", class: "DEBRIS", model: "crate", x: 0.5, z: -3, lift: 0.3, yawDeg: 35, halfExtents: [0.4, 0.3, 0.3], detectability: 0.75, burial: 0.2 },
    { id: "drum-h1", class: "DEBRIS", model: "drum", x: -3, z: 4, lift: 0.45, yawDeg: 80, halfExtents: [0.45, 0.3, 0.3], detectability: 0.8, burial: 0, floating: true },
    { id: "wreck-h1", class: "SHIPWRECK", model: "wreck", x: 12, z: 9, lift: 0.5, yawDeg: -25, halfExtents: [2.6, 0.8, 1.0], detectability: 0.92, burial: 0.3 },
  ],
  particles: { density: 1.4, marineSnow: false },
  defaults: { turbidity: 0.12, lighting: 0.8 },
  operatingDepthM: 5,
  platforms: ["rov", "station"],
  missions: ["structure-inspection", "detection", "classification", "localization", "obstacle-avoidance", "waypoint-navigation"],
  assumptions: [
    ...COMMON_ASSUMPTIONS,
    "Tidal current 0.25 m/s toward 070, a typical sheltered-harbour value; real berths range from near zero to over 1 m/s.",
    "Water 14 C and 30 PSU (estuarine harbour); density from the linear equation of state in lib/physics/seawater.ts.",
  ],
  references: ["docs/RESOURCES.md section 2", "docs/RESOURCES.md section 9 (Harbor)"],
};

const river: EnvironmentDefinition = {
  schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
  id: "river",
  version: "1.0.0",
  name: "River / Bridge",
  purpose: "Bridge pier scour and riverbed inspection in silt-laden fresh water with a strong, spatially varying flow.",
  kind: "field",
  water: { type: "fresh", temperatureC: 12, salinityPsu: 0, ntuRange: [2, 150], optics: { ...TANK_ENVIRONMENTS.river.water } },
  light: { source: "surface", label: "Daylight" },
  geometry: {
    extentM: [50, 30],
    terrain: { kind: "channel", depthM: 4, reliefM: 0.3, reliefWavelengthM: 10, roughnessM: 0.08, roughnessWavelengthM: 0.6, seed: 23, channel: { axis: "x", halfWidthM: 12, bankRiseM: 3.2 } },
  },
  seabed: { material: "gravel", reflectance: TANK_ENVIRONMENTS.river.seabedReflectance, color: "#675d4d", hydraulicRoughnessM: 5e-3 },
  current: { speedMps: 0.8, headingDeg: 90, turbulence: 0.15, variability: 0.2, profile: "log", referenceHeightM: 1, channel: { axis: "x", centre: 0, halfWidth: 14 } },
  assets: [
    { kind: "bridge-pier", at: [[-2, -5.5, 0, 1], [-2, 5.5, 0, 1]], solidRadius: 1.0 },
    { kind: "rock", scatter: { count: 160, area: [-24, -13, 24, 13], scale: [0.15, 0.6], seed: 3 } },
    { kind: "boulder", scatter: { count: 10, area: [-24, -11, 24, 11], scale: [0.6, 1.2], seed: 4 } },
    { kind: "branch", at: [[8, -3, 70, 1], [-14, 7, -20, 1.3], [17, 8, 10, 0.8]] },
    { kind: "weed", scatter: { count: 90, area: [-24, -14, 24, 14], scale: [0.3, 1.0], seed: 8 } },
  ],
  targets: [
    { id: "tire-r1", class: "TIRE", model: "tire", x: 4, z: -2, lift: 0.1, yawDeg: 10, halfExtents: [0.38, 0.12, 0.38], detectability: 0.8, burial: 0.3 },
    { id: "drum-r1", class: "DEBRIS", model: "drum", x: -9, z: 3.5, lift: 0.3, yawDeg: 60, halfExtents: [0.45, 0.3, 0.3], detectability: 0.8, burial: 0.25 },
    { id: "mine-r1", class: "MINE", model: "mine", x: 12, z: 2, lift: 0.4, yawDeg: 0, halfExtents: [0.45, 0.45, 0.45], detectability: 0.85, burial: 0.35 },
    { id: "pipe-r1", class: "PIPELINE", model: "pipe", x: -16, z: -1, lift: 0.22, yawDeg: 90, halfExtents: [6, 0.22, 0.22], detectability: 0.85, burial: 0.3 },
    { id: "wreck-r1", class: "SHIPWRECK", model: "wreck", x: 16, z: -6, lift: 0.4, yawDeg: 15, halfExtents: [2.0, 0.6, 0.8], detectability: 0.9, burial: 0.35 },
    { id: "crate-r1", class: "DEBRIS", model: "crate", x: 1.5, z: 6, lift: 0.28, yawDeg: 15, halfExtents: [0.4, 0.3, 0.3], detectability: 0.75, burial: 0.15 },
  ],
  particles: { density: 1.8, marineSnow: false },
  defaults: { turbidity: 0.05, lighting: 0.8 },
  operatingDepthM: 3,
  platforms: ["rov", "station"],
  missions: ["structure-inspection", "detection", "seabed-exploration", "obstacle-avoidance", "waypoint-navigation"],
  assumptions: [
    ...COMMON_ASSUMPTIONS,
    "Centreline current 0.8 m/s at 1 m above the bed with a 1/7 power-law bank profile and a log-law boundary layer over gravel (z0 5 mm).",
    "Bridge piers are vertical cylinders of 1 m radius; the wake behind them is an empirical Gaussian deficit with Strouhal 0.2 shedding.",
  ],
  references: ["docs/RESOURCES.md section 2", "docs/RESOURCES.md section 9 (River)", "docs/PHYSICS.md section 2"],
};

const deepsea: EnvironmentDefinition = {
  schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
  id: "deepsea",
  version: "1.0.0",
  name: "Deep Sea / Abyssal",
  purpose: "Abyssal survey with no daylight: only the vehicle's lamps light the seabed, so lamp power, beam and range trade against backscatter.",
  kind: "field",
  water: { type: "sea", temperatureC: 2, salinityPsu: 34.7, ntuRange: [0.02, 2], optics: { ...TANK_ENVIRONMENTS.deepsea.water } },
  light: { source: "lamp", label: "Lamp power" },
  geometry: { extentM: [60, 60], terrain: { kind: "abyssal", depthM: 1500, reliefM: 1.2, reliefWavelengthM: 40, roughnessM: 0.05, roughnessWavelengthM: 1.5, seed: 37 } },
  seabed: { material: "ooze", reflectance: TANK_ENVIRONMENTS.deepsea.seabedReflectance, color: "#a59a83", hydraulicRoughnessM: 1e-4 },
  current: { speedMps: 0.05, headingDeg: 200, turbulence: 0.05, variability: 0.3, profile: "log", referenceHeightM: 2 },
  assets: [
    { kind: "nodule", scatter: { count: 2400, area: [-30, -30, 30, 30], scale: [0.03, 0.09], seed: 12 } },
    { kind: "outcrop", at: [[-14, 10, 30, 2.2], [18, -12, 120, 1.6], [6, 20, 200, 1.2]] },
    { kind: "sponge", scatter: { count: 25, area: [-28, -28, 28, 28], scale: [0.15, 0.4], seed: 14 } },
  ],
  targets: [
    { id: "wreck-d1", class: "SHIPWRECK", model: "wreck", x: 4, z: -4, lift: 0.7, yawDeg: 40, halfExtents: [3.2, 1.0, 1.2], detectability: 0.92, burial: 0.25 },
    { id: "drum-d1", class: "DEBRIS", model: "drum", x: -8, z: 3, lift: 0.3, yawDeg: 15, halfExtents: [0.45, 0.3, 0.3], detectability: 0.8, burial: 0.2 },
    { id: "mine-d1", class: "MINE", model: "mine", x: 12, z: 8, lift: 0.4, yawDeg: 0, halfExtents: [0.45, 0.45, 0.45], detectability: 0.85, burial: 0.25 },
    { id: "pipe-d1", class: "PIPELINE", model: "pipe", x: -2, z: 14, lift: 0.25, yawDeg: 5, halfExtents: [9, 0.25, 0.25], detectability: 0.85, burial: 0.1 },
    { id: "anchor-d1", class: "DEBRIS", model: "anchor", x: -15, z: -12, lift: 0.25, yawDeg: 65, halfExtents: [0.8, 0.25, 0.5], detectability: 0.7, burial: 0.2 },
  ],
  particles: { density: 0.5, marineSnow: true },
  defaults: { turbidity: 0.3, lighting: 0.8 },
  operatingDepthM: 1497,
  platforms: ["rov", "auv", "station"],
  missions: ["seabed-exploration", "coverage-mapping", "detection", "localization", "waypoint-navigation"],
  assumptions: [
    ...COMMON_ASSUMPTIONS,
    "No daylight at 1500 m: lamp-only illumination with inverse-square falloff (lib/sim/detection.ts lampLight).",
    "Abyssal water 2 C, 34.7 PSU; pressure about 15.2 MPa; benthic current 5 cm/s.",
    "Manganese nodules are scattered 3 to 9 cm stones at a representative density, not a mapped field.",
  ],
  references: ["docs/RESOURCES.md section 2", "docs/RESOURCES.md section 9 (Deep sea)"],
};

const reef: EnvironmentDefinition = {
  schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
  id: "reef",
  version: "1.0.0",
  name: "Coastal / Coral Reef",
  purpose: "Shallow, sunlit reef: bright caustics, dense natural clutter, occlusion and camouflage around the targets.",
  kind: "field",
  water: {
    type: "sea",
    temperatureC: 26,
    salinityPsu: 35,
    ntuRange: [0.1, 5],
    // clear oceanic coastal water: little CDOM, small particles with a steep spectral slope
    optics: { cPerNtu: 1.0, particleAlbedo: 0.93, particleBackscatterRatio: 0.012, particleSlope: 1.0, cdom440: 0.02 },
  },
  light: { source: "surface", label: "Sunlight" },
  geometry: {
    extentM: [40, 40],
    terrain: {
      kind: "reef",
      depthM: 9,
      reliefM: 0.5,
      reliefWavelengthM: 12,
      roughnessM: 0.05,
      roughnessWavelengthM: 0.8,
      seed: 41,
      mounds: [
        [-9, -7, 4, 2.6],
        [8, -10, 3.2, 1.9],
        [-12, 9, 3.6, 2.2],
        [10, 8, 4.4, 2.8],
        [0, 15, 3, 1.6],
        [16, -1, 2.6, 1.4],
      ],
    },
  },
  seabed: { material: "coral-sand", reflectance: 0.35, color: "#cfc3a3", hydraulicRoughnessM: 0.03 },
  current: { speedMps: 0.2, headingDeg: 30, turbulence: 0.2, variability: 0.6, profile: "log", referenceHeightM: 1 },
  assets: [
    { kind: "coral-massive", scatter: { count: 70, area: [-19, -19, 19, 19], scale: [0.3, 1.0], seed: 21 } },
    { kind: "coral-branching", scatter: { count: 110, area: [-19, -19, 19, 19], scale: [0.25, 0.8], seed: 22 } },
    { kind: "coral-plate", scatter: { count: 40, area: [-19, -19, 19, 19], scale: [0.4, 1.1], seed: 23 } },
    { kind: "seagrass", scatter: { count: 140, area: [-19, -19, 19, 19], scale: [0.4, 0.9], seed: 24 } },
    { kind: "rock", scatter: { count: 60, area: [-19, -19, 19, 19], scale: [0.2, 0.7], seed: 25 } },
  ],
  targets: [
    { id: "mine-c1", class: "MINE", model: "mine", x: -2, z: -3, lift: 0.42, yawDeg: 0, halfExtents: [0.45, 0.45, 0.45], detectability: 0.75, burial: 0.15 },
    { id: "tire-c1", class: "TIRE", model: "tire", x: 4, z: 2, lift: 0.1, yawDeg: 20, halfExtents: [0.38, 0.12, 0.38], detectability: 0.7, burial: 0.15 },
    { id: "tire-c2", class: "TIRE", model: "tire", x: 4.9, z: 2.4, lift: 0.22, yawDeg: 70, halfExtents: [0.38, 0.12, 0.38], detectability: 0.7, burial: 0 },
    { id: "drum-c1", class: "DEBRIS", model: "drum", x: -6, z: 4, lift: 0.3, yawDeg: 110, halfExtents: [0.45, 0.3, 0.3], detectability: 0.7, burial: 0.1 },
    { id: "wreck-c1", class: "SHIPWRECK", model: "wreck", x: 2, z: -14, lift: 0.5, yawDeg: 70, halfExtents: [2.4, 0.7, 0.9], detectability: 0.82, burial: 0.25 },
    { id: "crate-c1", class: "DEBRIS", model: "crate", x: 13, z: 13, lift: 0.3, yawDeg: 5, halfExtents: [0.4, 0.3, 0.3], detectability: 0.72, burial: 0.1 },
  ],
  particles: { density: 0.7, marineSnow: false },
  defaults: { turbidity: 0.15, lighting: 0.9 },
  operatingDepthM: 6,
  platforms: ["rov", "auv", "station"],
  missions: ["detection", "classification", "seabed-exploration", "coverage-mapping", "structure-inspection"],
  assumptions: [
    ...COMMON_ASSUMPTIONS,
    "Wave-driven reef current 0.2 m/s toward 030 with high variability (surge) and 20 percent turbulence intensity.",
    "Coral detectability is lowered for targets (camouflage by growth and clutter); this is a modelling choice, not a measurement.",
  ],
  references: ["docs/RESOURCES.md section 2", "docs/PHYSICS.md section 6"],
};

const lake: EnvironmentDefinition = {
  schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
  id: "lake",
  version: "1.0.0",
  name: "Lake / Reservoir",
  purpose: "Freshwater infrastructure (intakes, dams) and submerged objects in algae-tinted, thermally stratified water.",
  kind: "field",
  water: {
    type: "fresh",
    temperatureC: 18,
    salinityPsu: 0,
    ntuRange: [1, 30],
    // phytoplankton-rich fresh water: steep particle slope, moderate CDOM (greenish)
    optics: { cPerNtu: 1.0, particleAlbedo: 0.85, particleBackscatterRatio: 0.01, particleSlope: 1.2, cdom440: 0.5 },
    stratification: { depthM: 7, thicknessM: 1.5, extraNtu: 3, temperatureBelowC: 8 },
  },
  light: { source: "surface", label: "Daylight" },
  geometry: {
    extentM: [50, 50],
    terrain: { kind: "lake", depthM: 14, reliefM: 0.6, reliefWavelengthM: 16, roughnessM: 0.05, roughnessWavelengthM: 1.0, seed: 53, shoreRadiusM: 70 },
  },
  seabed: { material: "silt", reflectance: 0.1, color: "#4a4537", hydraulicRoughnessM: 2e-4 },
  current: { speedMps: 0.03, headingDeg: 180, turbulence: 0.1, variability: 0.4, profile: "log", referenceHeightM: 1 },
  assets: [
    { kind: "weed", scatter: { count: 160, area: [-24, -24, 24, 24], scale: [0.5, 1.6], seed: 31 } },
    { kind: "boulder", scatter: { count: 18, area: [-24, -24, 24, 24], scale: [0.4, 1.1], seed: 32 } },
    { kind: "branch", at: [[-6, 9, 40, 1.4], [11, -4, 120, 1.0]] },
  ],
  targets: [
    { id: "pipe-l1", class: "PIPELINE", model: "pipe", x: 8, z: -12, lift: 0.3, yawDeg: 30, halfExtents: [7, 0.3, 0.3], detectability: 0.85, burial: 0.1 },
    { id: "drum-l1", class: "DEBRIS", model: "drum", x: -4, z: -2, lift: 0.3, yawDeg: 15, halfExtents: [0.45, 0.3, 0.3], detectability: 0.8, burial: 0.3 },
    { id: "tire-l1", class: "TIRE", model: "tire", x: 3, z: 5, lift: 0.1, yawDeg: 0, halfExtents: [0.38, 0.12, 0.38], detectability: 0.8, burial: 0.3 },
    { id: "wreck-l1", class: "SHIPWRECK", model: "wreck", x: -12, z: 10, lift: 0.4, yawDeg: -40, halfExtents: [2.0, 0.55, 0.75], detectability: 0.9, burial: 0.3 },
    { id: "crate-l1", class: "DEBRIS", model: "crate", x: 14, z: 9, lift: 0.28, yawDeg: 40, halfExtents: [0.4, 0.3, 0.3], detectability: 0.75, burial: 0.2 },
    { id: "mine-l1", class: "MINE", model: "mine", x: 0, z: 17, lift: 0.42, yawDeg: 0, halfExtents: [0.45, 0.45, 0.45], detectability: 0.85, burial: 0.2 },
  ],
  particles: { density: 1.2, marineSnow: false },
  defaults: { turbidity: 0.1, lighting: 0.8 },
  operatingDepthM: 10,
  platforms: ["rov", "auv", "station"],
  missions: ["detection", "seabed-exploration", "coverage-mapping", "pipeline-inspection", "waypoint-navigation"],
  assumptions: [
    ...COMMON_ASSUMPTIONS,
    "Summer stratification: thermocline at 7 m (18 C above, 8 C below) with 3 NTU of extra particles collected in the metalimnion.",
    "Fresh water is 2.6 percent less dense than sea water: vehicles trimmed for the sea sink unless re-ballasted (platform setting).",
  ],
  references: ["docs/RESOURCES.md section 2"],
};

const ocean: EnvironmentDefinition = {
  schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
  id: "ocean",
  version: "1.0.0",
  name: "Open Ocean Shelf",
  purpose: "Wide-area AUV survey of the continental shelf: navigation over long legs, coverage and sparse targets.",
  kind: "field",
  water: {
    type: "sea",
    temperatureC: 12,
    salinityPsu: 35,
    ntuRange: [0.02, 1],
    optics: { cPerNtu: 1.0, particleAlbedo: 0.9, particleBackscatterRatio: 0.013, particleSlope: 1.0, cdom440: 0.01 },
  },
  light: { source: "surface", label: "Daylight" },
  geometry: { extentM: [240, 240], terrain: { kind: "ocean", depthM: 60, reliefM: 4, reliefWavelengthM: 80, roughnessM: 0.1, roughnessWavelengthM: 2.5, seed: 67 } },
  seabed: { material: "sand", reflectance: 0.25, color: "#9c9277", hydraulicRoughnessM: 1e-3 },
  current: { speedMps: 0.35, headingDeg: 45, turbulence: 0.08, variability: 0.25, profile: "log", referenceHeightM: 2 },
  assets: [
    { kind: "rock", scatter: { count: 220, area: [-118, -118, 118, 118], scale: [0.3, 1.2], seed: 61 } },
    { kind: "sponge", scatter: { count: 60, area: [-118, -118, 118, 118], scale: [0.2, 0.5], seed: 62 } },
    { kind: "kelp", scatter: { count: 0, area: [-118, -118, 118, 118], scale: [1, 1], seed: 63 } },
  ],
  targets: [
    { id: "wreck-o1", class: "SHIPWRECK", model: "wreck", x: 40, z: -30, lift: 0.9, yawDeg: 120, halfExtents: [4, 1.2, 1.5], detectability: 0.92, burial: 0.3 },
    { id: "pipe-o1", class: "PIPELINE", model: "pipe", x: -20, z: 10, lift: 0.3, yawDeg: 60, halfExtents: [20, 0.3, 0.3], detectability: 0.85, burial: 0.2 },
    { id: "mine-o1", class: "MINE", model: "mine", x: -60, z: -50, lift: 0.42, yawDeg: 0, halfExtents: [0.5, 0.5, 0.5], detectability: 0.85, burial: 0.2 },
    { id: "mine-o2", class: "MINE", model: "mine", x: 70, z: 55, lift: 0.42, yawDeg: 0, halfExtents: [0.5, 0.5, 0.5], detectability: 0.85, burial: 0.35 },
    { id: "drum-o1", class: "DEBRIS", model: "drum", x: 10, z: 60, lift: 0.3, yawDeg: 15, halfExtents: [0.45, 0.3, 0.3], detectability: 0.8, burial: 0.25 },
    { id: "anchor-o1", class: "DEBRIS", model: "anchor", x: -80, z: 40, lift: 0.25, yawDeg: 65, halfExtents: [0.8, 0.25, 0.5], detectability: 0.7, burial: 0.15 },
  ],
  particles: { density: 0.6, marineSnow: false },
  defaults: { turbidity: 0.2, lighting: 0.8 },
  operatingDepthM: 52,
  platforms: ["auv", "rov", "station"],
  missions: ["coverage-mapping", "seabed-exploration", "detection", "waypoint-navigation", "pipeline-inspection"],
  assumptions: [
    ...COMMON_ASSUMPTIONS,
    "Shelf at 60 m, 12 C, 35 PSU; mean current 0.35 m/s toward 045 (tidal plus wind-driven, representative).",
    "Sonar is not simulated; optical sensing only at survey altitude.",
  ],
  references: ["docs/RESOURCES.md section 2", "docs/RESOURCES.md section 7"],
};

export const ENVIRONMENT_LIBRARY: Record<EnvironmentId, EnvironmentDefinition> = {
  "gantry-lab": gantryLab,
  harbor,
  river,
  deepsea,
  reef,
  lake,
  ocean,
};

export const ENVIRONMENT_ORDER: EnvironmentId[] = ["gantry-lab", "harbor", "river", "deepsea", "reef", "lake", "ocean"];
export const FIELD_ENVIRONMENT_IDS: FieldEnvironmentId[] = ["harbor", "river", "deepsea", "reef", "lake", "ocean"];

export const isFieldEnvironmentId = (v: unknown): v is FieldEnvironmentId => typeof v === "string" && (FIELD_ENVIRONMENT_IDS as string[]).includes(v);

export function getEnvironment(id: EnvironmentId): EnvironmentDefinition {
  return ENVIRONMENT_LIBRARY[id];
}

/** NTU at a 0..1 turbidity setting: NTU = lo + (hi - lo) t^2, as the lab environments. */
export function ntuAt(env: EnvironmentDefinition, turbidity: number): number {
  const [lo, hi] = env.water.ntuRange;
  const t = Math.min(1, Math.max(0, Number.isFinite(turbidity) ? turbidity : 0));
  return lo + (hi - lo) * t * t;
}
