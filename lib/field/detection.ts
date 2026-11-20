// ANALYTICAL detector for the field environments. This is NOT a neural network and never reports itself as YOLO:
// it is a physically motivated confidence model that answers "could a reasonable detector see this object, from
// here, through this water?". Real model evaluation runs on the backend against rendered frames (docs/ARCHITECTURE.md).
//
// confidence = detectability * geometry * water * light * size * blur * (1 - occluded)^1.5 +- seeded jitter
//   geometry: 1 - 0.30 r^2 - 0.15 burial (the lab's model, lib/sim/detection.ts)
//   water:    waterDetectability(contrastRatio(...)) from lib/optics/water.ts with this environment's light paths
//   light:    shot-noise-limited signal from daylight at the object's depth plus the vehicle's lamps
//   size:     smoothstep on the projected size in pixels (small objects carry few features)
//   blur:     motion smear during the exposure, from vehicle speed and turn rate
// docs/PHYSICS.md section 7 documents each term.

import { contrastRatio, waterDetectability, waterOptics, type WaterOptics } from "../optics/water";
import { hash01 } from "../sim/rng";
import { dot, len, sub, type Vec3 } from "../physics/math";
import type { EnvironmentDefinition, GtClass } from "../world/schema";
import { ntuAt } from "../world/environments";
import { focalPx, project, type CameraPose } from "./camera";

export type FieldClass = GtClass | "UNKNOWN";

export interface TargetInstance {
  id: string;
  class: GtClass;
  /** world centre of the object, m */
  position: Vec3;
  yawDeg: number;
  halfExtents: [number, number, number];
  detectability: number;
  burial: number;
}

export interface FieldDetection {
  targetId: string;
  trueClass: GtClass;
  class: FieldClass;
  confidence: number;
  correct: boolean;
  /** normalised u, v, w, h from the top-left of the frame */
  bbox: [number, number, number, number];
  distance: number;
  /** 0..1 of the object hidden behind terrain or structures */
  occluded: number;
  /** projected size, px (smaller side) */
  sizePx: number;
  blurPx: number;
  state: "DETECTED" | "LOCKED";
  age: number;
}

export interface DetectorInput {
  env: EnvironmentDefinition;
  turbidity: number;
  /** daylight (surface environments) or lamp power (lamp environments), 0..1 */
  lighting: number;
  /** vehicle lamp power in surface environments, 0..1 */
  lamps: number;
  threshold: number;
  camera: CameraPose;
  /** camera motion: world velocity m/s and angular rate magnitude rad/s */
  cameraVelocity: Vec3;
  cameraAngularRate: number;
  exposureS: number;
  /** range at which the platform's lamps give full signal, m (lampReferenceM of its flux) */
  lampReferenceM: number;
  targets: TargetInstance[];
  /** returns 0..1 of a segment blocked by terrain and solids */
  occlusion: (from: Vec3, to: Vec3) => number;
  seed: number;
  tick: number;
  previous: Map<string, FieldDetection>;
  dt: number;
}

export const CLASSIFY_THRESHOLD = 0.65;
export const HYSTERESIS = 0.05;
export const CLASS_HYSTERESIS = 0.03;
export const MIN_VISIBLE_FRACTION = 0.3;

/** What each class degrades to below the classify threshold: the deterministic confusion paths. */
export const CONFUSION: Record<GtClass, FieldClass> = {
  SHIPWRECK: "UNKNOWN",
  MINE: "UNKNOWN",
  DEBRIS: "UNKNOWN",
  TIRE: "DEBRIS",
  PIPELINE: "DEBRIS",
};

/**
 * Lamp irradiance reference distance: a 6000 lm lamp set lights the seabed to full signal at this range, m.
 * Other lamp sets scale with the square root of their flux (inverse-square law): lampReferenceM().
 */
export const LAMP_REFERENCE_M = 2.5;
export const lampReferenceM = (lumens: number) => LAMP_REFERENCE_M * Math.sqrt(Math.max(0, lumens) / 6000);
/** Fraction of surface daylight at which the camera reaches full signal-to-noise at its auto-exposure limit. */
export const DAYLIGHT_REFERENCE = 0.05;

/** Optics for a path, including a stratified layer's extra particles over the part of the path inside it. */
export function pathOptics(env: EnvironmentDefinition, turbidity: number, a: Vec3, b: Vec3): WaterOptics {
  let ntu = ntuAt(env, turbidity);
  const st = env.water.stratification;
  if (st) {
    const d0 = -a[1];
    const d1 = -b[1];
    const lo = st.depthM - st.thicknessM / 2;
    const hi = st.depthM + st.thicknessM / 2;
    const span = Math.abs(d1 - d0);
    const inside = Math.max(0, Math.min(Math.max(d0, d1), hi) - Math.max(Math.min(d0, d1), lo));
    ntu += st.extraNtu * (span > 1e-6 ? inside / span : d0 >= lo && d0 <= hi ? 1 : 0);
  }
  return waterOptics({ ...env.water.optics, ntu });
}

/** Light term: shot-noise-limited quality of the signal on the object, 0..1. */
export function lightTerm(env: EnvironmentDefinition, optics: WaterOptics, lighting: number, lamps: number, objectDepthM: number, distanceM: number, lampRefM = LAMP_REFERENCE_M): number {
  const kd = optics.kd[1];
  const d = Math.max(0.1, distanceM);
  const lampSignal = (env.light.source === "lamp" ? lighting : lamps) * Math.exp(-kd * d) * (lampRefM / d) ** 2;
  const daySignal = env.light.source === "lamp" ? 0 : (Math.pow(Math.min(1, Math.max(0, lighting)), 0.6) * Math.exp(-kd * Math.max(0, objectDepthM))) / DAYLIGHT_REFERENCE;
  return Math.sqrt(Math.min(1, Math.max(0, lampSignal + daySignal)));
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** World corners of a target's oriented box (yaw only), burial applied. */
export function targetCorners(t: TargetInstance): Vec3[] {
  const [hx, hy, hz] = t.halfExtents;
  const r = (t.yawDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const cy = t.position[1] - t.burial * hy;
  const out: Vec3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const lx = sx * hx;
        const lz = sz * hz;
        out.push([t.position[0] + lx * c + lz * s, cy + sy * hy, t.position[2] - lx * s + lz * c]);
      }
  return out;
}

export function runFieldDetection(input: DetectorInput): FieldDetection[] {
  const { env, camera, targets, previous } = input;
  const out: FieldDetection[] = [];
  const f = focalPx(camera);
  const speed = len(input.cameraVelocity);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const corners = targetCorners(t);
    let minU = Infinity,
      minV = Infinity,
      maxU = -Infinity,
      maxV = -Infinity,
      behind = false;
    for (const p of corners) {
      const q = project(camera, p);
      if (!(q.depth > 0.05)) {
        behind = true;
        break;
      }
      minU = Math.min(minU, q.u);
      maxU = Math.max(maxU, q.u);
      minV = Math.min(minV, q.v);
      maxV = Math.max(maxV, q.v);
    }
    if (behind) continue;
    const u = Math.min(1, Math.max(0, minU));
    const v = Math.min(1, Math.max(0, minV));
    const w = Math.min(1, Math.max(0, maxU)) - u;
    const h = Math.min(1, Math.max(0, maxV)) - v;
    const full = (maxU - minU) * (maxV - minV);
    if (!(full > 0) || (w * h) / full < MIN_VISIBLE_FRACTION) continue;

    const toObj = sub(t.position, camera.position);
    const distance = len(toObj);
    // occlusion: the centre and the top face corners, each traced to the lens
    const probes: Vec3[] = [t.position, corners[2], corners[3], corners[6], corners[7]];
    let occ = 0;
    for (const p of probes) occ += input.occlusion(camera.position, p);
    const occluded = occ / probes.length;
    if (occluded >= 0.95) continue;

    const cu = u + w / 2;
    const cv = v + h / 2;
    const rSq = (cu * 2 - 1) ** 2 + (cv * 2 - 1) ** 2;
    const geometry = 1 - 0.3 * rSq - 0.15 * t.burial;

    const optics = pathOptics(env, input.turbidity, camera.position, t.position);
    const objectDepth = Math.max(0, -t.position[1]);
    const lamp = env.light.source === "lamp";
    const paths = lamp
      ? { objectDepthM: distance, veilDepthM: distance / 2 }
      : { objectDepthM: objectDepth, veilDepthM: Math.max(0, -(camera.position[1] + t.position[1]) / 2) };
    const water = waterDetectability(contrastRatio(optics, { pathM: distance, ...paths, backgroundReflectance: env.seabed.reflectance }));
    const light = lightTerm(env, optics, input.lighting, input.lamps, objectDepth, distance, input.lampReferenceM);

    const sizePx = Math.min(w * camera.width, h * camera.height);
    const size = smoothstep(6, 28, sizePx);
    // smear: lateral speed over distance plus turn rate, both in pixels over the exposure
    const along = dot(input.cameraVelocity, camera.forward);
    const lateral = Math.sqrt(Math.max(0, speed * speed - along * along));
    const blurPx = input.exposureS * f * (lateral / Math.max(0.2, distance) + input.cameraAngularRate);
    const blur = 1 / (1 + (blurPx / 8) ** 2);

    const jitter = (hash01(i + 1, input.tick, input.seed) - 0.5) * 0.02;
    const confidence = Math.min(0.995, Math.max(0, t.detectability * geometry * water * light * size * blur * Math.pow(1 - occluded, 1.5) + jitter));

    const prev = previous.get(t.id);
    const gate = prev ? input.threshold - HYSTERESIS : input.threshold;
    if (confidence < gate) continue;
    const classGate = prev?.class === t.class ? CLASSIFY_THRESHOLD - CLASS_HYSTERESIS : CLASSIFY_THRESHOLD;
    const cls: FieldClass = confidence >= classGate ? t.class : CONFUSION[t.class];
    const age = prev ? prev.age + input.dt : 0;
    out.push({
      targetId: t.id,
      trueClass: t.class,
      class: cls,
      confidence,
      correct: cls === t.class,
      bbox: [u, v, w, h],
      distance,
      occluded,
      sizePx,
      blurPx,
      state: age >= 0.6 ? "LOCKED" : "DETECTED",
      age,
    });
  }
  return out;
}
