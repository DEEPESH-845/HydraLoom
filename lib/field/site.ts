// Site parameters: what a survey can measure about a place, beyond turbidity, light and current. Each one changes the
// physics, the detector, the rendered image and the recorded conditions, because all of them read one "effective
// environment" (effectiveEnv) instead of the library's entry. docs/PHYSICS.md section 9.

import { visibilityRange, waterOptics } from "../optics/water";
import { VEHICLES } from "../physics/vehicle";
import { PLATFORMS, type PlatformId } from "../platforms";
import { ntuAt } from "../world/environments";
import type { EnvironmentDefinition, FieldEnvironmentId } from "../world/schema";
import { lampReferenceM, workingRange } from "./detection";

export interface SiteParams {
  /** water temperature, C, and practical salinity, PSU: density, viscosity, buoyancy */
  temperatureC: number;
  salinityPsu: number;
  /** dissolved organic matter: absorption at 440 nm, 1/m (tea-coloured water) */
  cdom440: number;
  /** beam attenuation per NTU, 1/m per NTU: the number a turbidity calibration of the real site measures */
  cPerNtu: number;
  /** particle single-scattering albedo (mineral silt 0.95, algae 0.8) and backscatter ratio */
  particleAlbedo: number;
  backscatterRatio: number;
  /** diffuse reflectance of the seabed the targets are seen against */
  seabedReflectance: number;
  /** extra burial of every target, as a share of what stands clear now */
  extraBurial: number;
  /** growth covering the targets: 0 clean, 1 fully fouled */
  fouling: number;
  /** sun above the horizon, degrees; sets the daylight and how slantwise it travels */
  sunElevationDeg: number;
  /** waves: height, period, direction they travel toward */
  waveHeightM: number;
  wavePeriodS: number;
  waveHeadingDeg: number;
  /** a turbid layer: depth of its middle, thickness, NTU added inside it */
  layerDepthM: number;
  layerThicknessM: number;
  layerNtu: number;
  /** camera exposure, s */
  exposureS: number;
}
export type SiteKey = keyof SiteParams;

export interface SiteSpec {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  digits: number;
  group: "Water" | "Particles" | "Seabed and targets" | "Sun and waves" | "Turbid layer" | "Camera";
  /** what it changes, for the control's hint */
  effect: string;
  /** shown on a log slider */
  log?: boolean;
}

export const SITE_SPEC: Record<SiteKey, SiteSpec> = {
  temperatureC: { label: "Temperature", unit: "C", min: -1.9, max: 35, step: 0.5, digits: 1, group: "Water", effect: "Density and viscosity" },
  salinityPsu: { label: "Salinity", unit: "PSU", min: 0, max: 42, step: 0.5, digits: 1, group: "Water", effect: "Density and buoyancy" },
  cdom440: { label: "Dissolved organics (440 nm)", unit: "1/m", min: 0, max: 5, step: 0.01, digits: 2, group: "Water", effect: "Absorbs blue and green: brown water" },
  cPerNtu: { label: "Attenuation per NTU", unit: "1/m", min: 0.2, max: 2.5, step: 0.05, digits: 2, group: "Particles", effect: "Set it from a site calibration" },
  particleAlbedo: { label: "Particle albedo", unit: "", min: 0.6, max: 0.99, step: 0.01, digits: 2, group: "Particles", effect: "Mineral silt 0.95, algae 0.80" },
  backscatterRatio: { label: "Backscatter ratio", unit: "", min: 0.004, max: 0.04, step: 0.001, digits: 3, group: "Particles", effect: "Haze lit back into the lens" },
  seabedReflectance: { label: "Seabed reflectance", unit: "", min: 0.04, max: 0.6, step: 0.01, digits: 2, group: "Seabed and targets", effect: "Background the targets are seen against" },
  extraBurial: { label: "Extra burial", unit: "", min: 0, max: 0.9, step: 0.05, digits: 2, group: "Seabed and targets", effect: "Share of the exposed part buried" },
  fouling: { label: "Growth on targets", unit: "", min: 0, max: 1, step: 0.05, digits: 2, group: "Seabed and targets", effect: "Hides paint, edges and texture" },
  sunElevationDeg: { label: "Sun elevation", unit: "deg", min: 0, max: 90, step: 1, digits: 0, group: "Sun and waves", effect: "Daylight and its path in the water" },
  waveHeightM: { label: "Wave height", unit: "m", min: 0, max: 6, step: 0.05, digits: 2, group: "Sun and waves", effect: "Surge on the vehicle and drifting targets" },
  wavePeriodS: { label: "Wave period", unit: "s", min: 2, max: 16, step: 0.5, digits: 1, group: "Sun and waves", effect: "Longer waves reach deeper" },
  waveHeadingDeg: { label: "Waves travel toward", unit: "deg", min: 0, max: 359, step: 1, digits: 0, group: "Sun and waves", effect: "Direction of the surge" },
  layerDepthM: { label: "Layer depth", unit: "m", min: 0, max: 1520, step: 0.1, digits: 1, group: "Turbid layer", effect: "Middle of the layer" },
  layerThicknessM: { label: "Layer thickness", unit: "m", min: 0.1, max: 20, step: 0.1, digits: 1, group: "Turbid layer", effect: "Thickness" },
  layerNtu: { label: "Added turbidity", unit: "NTU", min: 0, max: 40, step: 0.1, digits: 1, group: "Turbid layer", effect: "0 removes the layer" },
  exposureS: { label: "Camera exposure", unit: "ms", min: 1 / 4000, max: 1 / 25, step: 0.00025, digits: 5, group: "Camera", effect: "Longer: more light, more blur" },
};
export const SITE_KEYS = Object.keys(SITE_SPEC) as SiteKey[];

const G = 9.80665;
/** Sun elevation at which the default daylight geometry (Kirk mu0 = 0.87) holds, degrees. */
export const DEFAULT_SUN_DEG = 48.6;
const N_WATER = 1.34;

/** Seawater freezing point, C (linear, good to 0.1 C). */
export const freezingPoint = (psu: number) => -0.054 * psu;

/** Wavenumber of a wave in water of depth h: w^2 = g k tanh(k h). */
export function waveNumber(periodS: number, depthM: number): number {
  const w2 = ((2 * Math.PI) / periodS) ** 2;
  let k = w2 / G;
  // deep-water start, then Newton on the dispersion relation
  for (let i = 0; i < 30; i++) {
    const th = Math.tanh(k * depthM);
    const f = G * k * th - w2;
    const df = G * th + G * k * depthM * (1 - th * th);
    const next = Math.max(1e-6, k - f / df);
    if (Math.abs(next - k) < 1e-10) break;
    k = next;
  }
  return k;
}

/** Tallest wave that does not break: 0.78 of the depth, or a steepness of 0.142 tanh(k h). */
export function breakingHeight(periodS: number, depthM: number): number {
  const k = waveNumber(periodS, depthM);
  return Math.min(0.78 * depthM, 0.142 * ((2 * Math.PI) / k) * Math.tanh(k * depthM));
}

/** Cosine of the sun's zenith angle inside the water. */
export function underwaterMu0(elevationDeg: number): number {
  const s = Math.cos((elevationDeg * Math.PI) / 180) / N_WATER;
  return Math.sqrt(1 - s * s);
}

/** Unpolarised Fresnel transmission into the water. */
function transmission(elevationDeg: number): number {
  const ci = Math.sin((elevationDeg * Math.PI) / 180);
  const ct = underwaterMu0(elevationDeg);
  const rs = ((ci - N_WATER * ct) / (ci + N_WATER * ct)) ** 2;
  const rp = ((N_WATER * ci - ct) / (N_WATER * ci + ct)) ** 2;
  return 1 - (rs + rp) / 2;
}

/** Daylight entering the water against the default sun: 0 at the horizon. */
export function sunFactor(elevationDeg: number): number {
  const e = (elevationDeg * Math.PI) / 180;
  const at = (d: number) => Math.sin((d * Math.PI) / 180) * transmission(d);
  return e <= 0 ? 0 : at(elevationDeg) / at(DEFAULT_SUN_DEG);
}

export function defaultSite(env: EnvironmentDefinition, platform: PlatformId): SiteParams {
  const o = env.water.optics;
  const st = env.water.stratification;
  return {
    temperatureC: env.water.temperatureC,
    salinityPsu: env.water.salinityPsu,
    cdom440: o.cdom440,
    cPerNtu: o.cPerNtu,
    particleAlbedo: o.particleAlbedo,
    backscatterRatio: o.particleBackscatterRatio,
    seabedReflectance: env.seabed.reflectance,
    extraBurial: 0,
    fouling: 0,
    sunElevationDeg: DEFAULT_SUN_DEG,
    waveHeightM: 0,
    wavePeriodS: 6,
    waveHeadingDeg: env.current.headingDeg ?? 90,
    layerDepthM: st?.depthM ?? Math.round(env.geometry.terrain.depthM * 0.5 * 10) / 10,
    layerThicknessM: st?.thicknessM ?? 1.5,
    layerNtu: st?.extraNtu ?? 0,
    exposureS: PLATFORMS[platform].camera.exposureS,
  };
}

/**
 * Clamps to range and makes the set jointly possible: water is never below its freezing point, waves never past
 * breaking, the layer inside the column. Non-finite values keep the previous one.
 */
export function sanitizeSite(env: EnvironmentDefinition, patch: Partial<SiteParams>, base: SiteParams): SiteParams {
  const out = { ...base };
  for (const k of SITE_KEYS) {
    const v = patch[k];
    if (v === undefined || !Number.isFinite(v)) continue;
    const s = SITE_SPEC[k];
    out[k] = k === "waveHeadingDeg" ? ((v % 360) + 360) % 360 : Math.min(s.max, Math.max(s.min, v));
  }
  out.temperatureC = Math.max(out.temperatureC, Math.ceil(freezingPoint(out.salinityPsu) * 10) / 10);
  const depth = env.geometry.terrain.depthM;
  out.waveHeightM = Math.min(out.waveHeightM, Math.floor(breakingHeight(out.wavePeriodS, depth) * 100) / 100);
  out.layerDepthM = Math.min(out.layerDepthM, depth);
  return out;
}

/** The environment as these parameters make it. Everything downstream reads this, never the library entry. */
export function effectiveEnv(env: EnvironmentDefinition, s: SiteParams): EnvironmentDefinition {
  const type = s.salinityPsu < 0.5 ? "fresh" : s.salinityPsu < 25 ? "brackish" : "sea";
  const sun = s.sunElevationDeg === DEFAULT_SUN_DEG ? undefined : underwaterMu0(s.sunElevationDeg);
  return {
    ...env,
    water: {
      ...env.water,
      type,
      temperatureC: s.temperatureC,
      salinityPsu: s.salinityPsu,
      optics: { ...env.water.optics, cdom440: s.cdom440, cPerNtu: s.cPerNtu, particleAlbedo: s.particleAlbedo, particleBackscatterRatio: s.backscatterRatio, ...(sun === undefined ? {} : { mu0: sun }) },
      stratification: s.layerNtu > 0 || env.water.stratification ? { depthM: s.layerDepthM, thicknessM: s.layerThicknessM, extraNtu: s.layerNtu, temperatureBelowC: env.water.stratification?.temperatureBelowC ?? s.temperatureC } : undefined,
    },
    light: { ...env.light, sunFactor: env.light.source === "lamp" ? 1 : sunFactor(s.sunElevationDeg) },
    seabed: { ...env.seabed, reflectance: s.seabedReflectance },
  };
}

/** How distinct a fouled target still is: full growth keeps 55 percent of it. ASSUMPTION, not measured. */
export const foulingFactor = (f: number) => 1 - 0.45 * f;
export const buriedMore = (burial: number, extra: number) => burial + (1 - burial) * extra;

/* ---------- checks ---------- */

export interface SiteIssue {
  level: "warn" | "info";
  text: string;
}

/** Fastest the ROV can push water aside, m/s: thrust against its own drag. */
export function maxWaterSpeed(platform: PlatformId): number {
  const v = PLATFORMS[platform].vehicle ? VEHICLES[platform as "rov" | "auv"] : null;
  if (!v) return 0;
  const [l, q, f] = [v.dampLin[0], v.dampLinQ[0], v.maxForce[0]];
  return (-l + Math.sqrt(l * l + 4 * q * f)) / (2 * q);
}

export interface CheckInput {
  turbidity: number;
  lighting: number;
  lamps: number;
  altitudeM: number;
  speedMps: number;
  current: { speedMps: number; turbulence: number };
  site: SiteParams;
}

/** What these conditions mean for the test, before it is run. `env` is the effective environment. */
export function checkConditions(env: EnvironmentDefinition, c: CheckInput, platform: PlatformId): SiteIssue[] {
  const out: SiteIssue[] = [];
  const cam = PLATFORMS[platform].camera;
  const optics = waterOptics({ ...env.water.optics, ntu: ntuAt(env, c.turbidity) });
  const vis = visibilityRange(optics.c[1]);
  const depth = env.geometry.terrain.depthM;
  const reach = workingRange(env, { turbidity: c.turbidity, lighting: c.lighting, lamps: c.lamps, lampReferenceM: lampReferenceM(PLATFORMS[platform].lamps.lumens) });
  if (PLATFORMS[platform].vehicle) {
    const slant = c.altitudeM / Math.sin((cam.tiltDeg * Math.PI) / 180);
    if (slant > reach * 1.25) out.push({ level: "warn", text: `At ${c.altitudeM.toFixed(1)} m altitude the camera looks ${slant.toFixed(1)} m through water it can work in for ${reach.toFixed(1)} m. ${c.altitudeM <= (platform === "auv" ? 1.25 : 0.55) ? "That is already the lowest: only targets standing up from the bed will be seen." : "Fly lower."}` });
    const top = maxWaterSpeed(platform);
    const peak = c.current.speedMps * (1 + c.current.turbulence * 2);
    if (platform === "rov" && peak > top * 0.9) out.push({ level: "warn", text: `The current peaks near ${peak.toFixed(2)} m/s; the ROV makes ${top.toFixed(2)} m/s. It cannot hold station.` });
    if (platform === "auv" && c.current.speedMps > c.speedMps * 0.6) out.push({ level: "warn", text: "The current is over 60 percent of the AUV's speed: survey lines will crab and some legs will crawl." });
    const blur = c.site.exposureS * (cam.width / 2 / Math.tan((cam.hfovDeg * Math.PI) / 360)) * (c.speedMps / Math.max(0.3, Math.min(slant, reach)));
    if (blur > 6) out.push({ level: "warn", text: `At ${c.speedMps.toFixed(1)} m/s a ${(c.site.exposureS * 1000).toFixed(1)} ms exposure smears the image by ${blur.toFixed(0)} px. Shorten it or slow down.` });
  }
  if (reach <= 0.35) out.push({ level: "warn", text: `No working range: the water leaves less than 85 percent of the signal beyond 0.3 m (visibility ${vis.toFixed(1)} m).` });
  if (env.light.source === "surface") {
    const left = (env.light.sunFactor ?? 1) * c.lighting * Math.exp(-optics.kd[1] * depth);
    if (left < 0.002 && c.lamps < 0.05) out.push({ level: "warn", text: "Daylight does not reach the seabed and the lamps are off: the camera sees nothing." });
    else if (left < 0.002) out.push({ level: "info", text: "Daylight does not reach the seabed: this is a lamp-lit test." });
  }
  if (c.site.waveHeightM > 0) {
    const k = waveNumber(c.site.wavePeriodS, depth);
    const bottom = k * depth > 12 ? 0 : (Math.PI * c.site.waveHeightM) / (c.site.wavePeriodS * Math.sinh(k * depth));
    out.push({ level: bottom > maxWaterSpeed(platform) * 0.7 && platform === "rov" ? "warn" : "info", text: `Waves move the water at the seabed by ${bottom.toFixed(2)} m/s back and forth.` });
    const limit = breakingHeight(c.site.wavePeriodS, depth);
    if (c.site.waveHeightM > 0.97 * limit) out.push({ level: "info", text: `Wave height is at the breaking limit for this depth and period (${limit.toFixed(1)} m).` });
  }
  const st = env.water.stratification;
  if (st && st.extraNtu > 0 && Math.abs(st.depthM - depth) < st.thicknessM / 2 + c.altitudeM) out.push({ level: "info", text: "The turbid layer reaches the survey altitude: the working range near the seabed is shorter than shown." });
  if (c.site.temperatureC <= freezingPoint(c.site.salinityPsu) + 0.15) out.push({ level: "info", text: "At its freezing point: the surface would be iced over." });
  return out;
}

/* ---------- presets ---------- */

export interface SitePreset {
  id: string;
  name: string;
  note: string;
  turbidity?: number;
  lighting?: number;
  lamps?: number;
  current?: { speedMps?: number; headingDeg?: number; turbulence?: number; variability?: number };
  site?: Partial<SiteParams>;
}

/** Conditions a real survey of each place meets. Representative, not measured at a site. */
export const PRESETS: Record<FieldEnvironmentId, SitePreset[]> = {
  harbor: [
    { id: "spring-tide", name: "Spring tide", note: "Fast ebb stirs the mud", turbidity: 0.2, current: { speedMps: 0.7, turbulence: 0.18 } },
    { id: "after-storm", name: "After a storm", note: "Runoff, chop and silt", turbidity: 0.3, lighting: 0.5, current: { speedMps: 0.35, turbulence: 0.25 }, site: { waveHeightM: 0.4, wavePeriodS: 4, cdom440: 0.4, salinityPsu: 22 } },
    { id: "bloom", name: "Algal bloom", note: "Green, absorbing particles", turbidity: 0.18, site: { cdom440: 0.35, particleAlbedo: 0.8, backscatterRatio: 0.008, fouling: 0.4, temperatureC: 19 } },
    { id: "winter-dusk", name: "Winter, low sun", note: "Cold and dim", turbidity: 0.08, lighting: 0.5, lamps: 0.9, site: { temperatureC: 4, sunElevationDeg: 12 } },
  ],
  river: [
    { id: "low-flow", name: "Summer low flow", note: "Clear and slow", turbidity: 0.02, current: { speedMps: 0.25, turbulence: 0.1 }, site: { temperatureC: 20 } },
    { id: "spate", name: "Spate", note: "Fast, brown, full of silt", turbidity: 0.16, lighting: 0.5, current: { speedMps: 1.4, turbulence: 0.25 }, site: { cdom440: 1.6, temperatureC: 9 } },
    { id: "peat", name: "Peat stained", note: "Clear of silt, dark as tea", turbidity: 0.02, lamps: 0.9, site: { cdom440: 4, temperatureC: 8 } },
    { id: "buried", name: "After a flood", note: "Targets half buried in new silt", turbidity: 0.06, site: { extraBurial: 0.5, seabedReflectance: 0.12 } },
  ],
  deepsea: [
    { id: "clear", name: "Clear abyss", note: "Least particles", turbidity: 0.05 },
    { id: "nepheloid", name: "Nepheloid layer", note: "Turbid water over the bed", turbidity: 0.3, site: { layerDepthM: 1498, layerThicknessM: 8, layerNtu: 1.2 } },
    { id: "benthic-storm", name: "Benthic storm", note: "Resuspended ooze, strong flow", turbidity: 0.8, current: { speedMps: 0.4, turbulence: 0.2 } },
    { id: "failing-lamps", name: "Failing lamps", note: "A quarter of the light", lighting: 0.2 },
  ],
  reef: [
    { id: "swell", name: "Ocean swell", note: "Long waves surge over the reef", turbidity: 0.25, current: { turbulence: 0.25 }, site: { waveHeightM: 1.2, wavePeriodS: 10 } },
    { id: "overcast", name: "Early morning", note: "Low sun, flat light", lighting: 0.5, site: { sunElevationDeg: 10 } },
    { id: "plume", name: "River plume", note: "Fresh, silty water over the reef", turbidity: 0.7, site: { salinityPsu: 27, cdom440: 0.2, particleAlbedo: 0.95, backscatterRatio: 0.018 } },
    { id: "overgrown", name: "Overgrown targets", note: "Years of growth", site: { fouling: 0.9, extraBurial: 0.2 } },
  ],
  lake: [
    { id: "winter-mixed", name: "Winter, mixed", note: "Cold, no layer", turbidity: 0.05, lighting: 0.5, site: { temperatureC: 4, layerNtu: 0, sunElevationDeg: 18 } },
    { id: "bloom", name: "Summer bloom", note: "Algae near the surface", turbidity: 0.18, lamps: 0.8, site: { cdom440: 1.1, particleAlbedo: 0.78, backscatterRatio: 0.008, temperatureC: 24, fouling: 0.3 } },
    { id: "strong-layer", name: "Strong thermocline", note: "A thick turbid layer", site: { layerDepthM: 9, layerThicknessM: 4, layerNtu: 8 } },
    { id: "drawdown", name: "Reservoir drawdown", note: "Stirred silt buries the bed", turbidity: 0.2, current: { speedMps: 0.15 }, site: { extraBurial: 0.4 } },
  ],
  ocean: [
    { id: "storm", name: "Storm swell", note: "Big waves felt at depth", turbidity: 0.5, lighting: 0.4, current: { speedMps: 0.5, turbulence: 0.15 }, site: { waveHeightM: 5, wavePeriodS: 12 } },
    { id: "night", name: "Night", note: "Lamps only", lighting: 0, lamps: 1, site: { sunElevationDeg: 0 } },
    { id: "bloom", name: "Spring bloom", note: "Productive shelf water", turbidity: 0.7, site: { cdom440: 0.08, particleAlbedo: 0.82 } },
    { id: "strong-current", name: "Strong current", note: "Tidal race over the shelf", current: { speedMps: 0.8, turbulence: 0.12 } },
  ],
};
