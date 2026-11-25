// ANALYTICAL detector for the field environments. This is NOT a neural network and never reports itself as YOLO:
// it is a physically motivated confidence model that answers "could a reasonable detector see this object, from
// here, through this water?". Real model evaluation runs on the backend against rendered frames (docs/ARCHITECTURE.md).
//
// confidence = detectability * geometry * evidence * size * blur +- seeded jitter
//   geometry: 1 - 0.30 r^2 - 0.15 burial (the lab's model, lib/sim/detection.ts)
//   evidence: mean of water * light over the best-seen 35 percent of the surface facing the camera. Each surface patch
//             has its own path, so a 5 m wreck is judged by the hull in front of the lens, not by its far centre, and a
//             wreck overflowing the frame still counts; patches out of frame or hidden contribute nothing. In murky water the
//             only readable views are close ones, where a large object can never show 35 percent of itself: there the
//             evidence is instead how much of the picture it fills (FRAME_FRACTION, with a partial-view penalty).
//   water:    contrastSignal(contrastRatio(...)) from lib/optics/water.ts with this environment's light paths
//   light:    shot-noise-limited signal from daylight at the object's depth plus the vehicle's lamps
//   size:     smoothstep on the projected size in pixels (small objects carry few features)
//   blur:     motion smear during the exposure, from vehicle speed and turn rate
// docs/PHYSICS.md section 7 documents each term.

import { contrastRatio, waterOptics, type WaterOptics } from "../optics/water";
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
  /** seabed height (world Y); without it the bed is taken as level at the burial line */
  bed?: (x: number, z: number) => number;
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
  /** 0..1 of the best-placed surface that is hidden behind terrain or structures */
  occluded: number;
  /** projected size, px (smaller side) */
  sizePx: number;
  blurPx: number;
  state: "DETECTED" | "LOCKED" | "COASTING";
  /** seconds the track has been below the threshold */
  coastS: number;
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
  /** light gathered against the platform's own exposure */
  exposureGain?: number;
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

/** Share of each new 10 Hz reading that enters a track's confidence, and how long a track may coast. */
export const TRACK_BLEND = 0.5;
export const COAST_S = 0.6;
export const CLASSIFY_THRESHOLD = 0.65;
export const HYSTERESIS = 0.05;
/**
 * Share of the camera-facing surface a detector needs to see well; less than this scales the evidence down. The trained
 * models above agree: confidence 0.61 with 20 to 30 percent of an object visible, 0.75 at 30 to 40, 0.89 at 40 to 60.
 */
export const EVIDENCE_FRACTION = 0.35;
/** Share of the picture a readable object has to fill to count without showing EVIDENCE_FRACTION of itself. */
export const FRAME_FRACTION = 0.3;
/** Most a close, partial view is worth against seeing the object properly. ASSUMPTION, not measured. */
export const PARTIAL_VIEW = 0.95;
/**
 * Contrast at which the water stops limiting a detector, and where it is blind (Koschmieder). Between them the signal
 * is linear in log contrast. Calibrated on YOLOv8n models trained on rendered frames and tested on held-out ones (173
 * objects in 72 frames): with murky water in the training set they find every object, at 0.9 confidence or more, down
 * to 3 to 5 percent contrast. Trained on clear water only, the same network is blind below 8 percent: a detector that
 * was never shown murk does worse than this.
 */
export const CONTRAST_FULL = 0.05;
export const CONTRAST_BLIND = 0.02;

/** What each class degrades to below the classify threshold: the deterministic confusion paths. */
export const CONFUSION: Record<GtClass, FieldClass> = {
  SHIPWRECK: "UNKNOWN",
  MINE: "UNKNOWN",
  DEBRIS: "UNKNOWN",
  TIRE: "DEBRIS",
  PIPELINE: "DEBRIS",
};

/**
 * Illuminance on the object for full signal, lux. A low-light camera (f/2, 2.8 um pixels, quantum efficiency 0.5) at
 * 1/120 s collects about 75 electrons per pixel from a 20 percent reflector under 50 lux: a signal-to-noise ratio near
 * 9 in every pixel, before a detector averages over any. Below it the shot-noise square root applies.
 */
export const FULL_SIGNAL_LUX = 50;
/** Daylight on the water at full lighting, lux, and the fraction of it that gives full signal. */
export const DAYLIGHT_LUX = 100_000;
export const DAYLIGHT_REFERENCE = FULL_SIGNAL_LUX / DAYLIGHT_LUX;
/**
 * Range at which a 6000 lm, 135 degree lamp set (1546 cd) gives that illuminance, m. Other lamp sets scale with the
 * square root of their flux (inverse-square law): lampReferenceM().
 */
export const LAMP_REFERENCE_M = Math.sqrt(6000 / (2 * Math.PI * (1 - Math.cos((67.5 * Math.PI) / 180))) / FULL_SIGNAL_LUX);
export const lampReferenceM = (lumens: number) => LAMP_REFERENCE_M * Math.sqrt(Math.max(0, lumens) / 6000);

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
export function lightTerm(env: EnvironmentDefinition, optics: WaterOptics, lighting: number, lamps: number, objectDepthM: number, distanceM: number, lampRefM = LAMP_REFERENCE_M, exposureGain = 1): number {
  const kd = optics.kd[1];
  const d = Math.max(0.1, distanceM);
  const lampSignal = (env.light.source === "lamp" ? lighting : lamps) * Math.exp(-kd * d) * (lampRefM / d) ** 2;
  const daySignal = env.light.source === "lamp" ? 0 : (Math.pow(Math.min(1, Math.max(0, lighting)), 0.6) * (env.light.sunFactor ?? 1) * Math.exp(-kd * Math.max(0, objectDepthM))) / DAYLIGHT_REFERENCE;
  return Math.sqrt(Math.min(1, Math.max(0, (lampSignal + daySignal) * exposureGain)));
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** 0..1 of a detector's signal that survives at an apparent contrast ratio. */
export function contrastSignal(ratio: number): number {
  if (!(ratio > 0)) return 0;
  return Math.min(1, Math.max(0, Math.log(ratio / CONTRAST_BLIND) / Math.log(CONTRAST_FULL / CONTRAST_BLIND)));
}

/** Water times light on a surface patch: the one function the detector and the mission planner both use. */
export function pathSignal(env: EnvironmentDefinition, optics: WaterOptics, c: { lighting: number; lamps: number; lampReferenceM: number; exposureGain?: number }, cameraY: number, objectY: number, distanceM: number): number {
  const objectDepth = Math.max(0, -objectY);
  const paths = env.light.source === "lamp" ? { objectDepthM: distanceM, veilDepthM: distanceM / 2 } : { objectDepthM: objectDepth, veilDepthM: Math.max(0, -(cameraY + objectY) / 2) };
  const water = contrastSignal(contrastRatio(optics, { pathM: distanceM, ...paths, backgroundReflectance: env.seabed.reflectance }));
  return water > 0 ? water * lightTerm(env, optics, c.lighting, c.lamps, objectDepth, distanceM, c.lampReferenceM, c.exposureGain) : 0;
}

/**
 * Longest straight-line range to the seabed at which `keep` of the signal survives, m. The survey altitude and
 * stand-off come from this, so the planner can never send the camera somewhere the detector is blind.
 */
export function workingRange(env: EnvironmentDefinition, c: { turbidity: number; lighting: number; lamps: number; lampReferenceM: number; exposureGain?: number }, keep = 0.85): number {
  const bedY = -env.geometry.terrain.depthM;
  let best = 0.3;
  for (let d = 0.35; d <= 12; d += 0.05) {
    const camY = Math.min(-0.1, bedY + d * 0.6);
    const optics = pathOptics(env, c.turbidity, [0, camY, 0], [0, bedY, 0]);
    if (pathSignal(env, optics, c, camY, bedY, d) < keep) break;
    best = d;
  }
  return best;
}

/** Distance from a target's centre to its box surface along a horizontal world direction, m. */
export function approachExtent(t: Pick<TargetInstance, "yawDeg" | "halfExtents">, dx: number, dz: number): number {
  const r = (t.yawDeg * Math.PI) / 180;
  const lx = Math.abs(dx * Math.cos(r) - dz * Math.sin(r));
  const lz = Math.abs(dx * Math.sin(r) + dz * Math.cos(r));
  return Math.min(lx > 1e-9 ? t.halfExtents[0] / lx : Infinity, lz > 1e-9 ? t.halfExtents[2] / lz : Infinity);
}

/**
 * Boxes an object is made of, in its own frame about its drawn centre, clipped to what stands clear of the seabed.
 * The wreck's bow is gone and only the deckhouse reaches its full height (components/field/targets.ts draws the same
 * hull); judging it as one solid box would see a ship where there is open water. Everything else fills its box.
 */
interface Part {
  lo: Vec3;
  hi: Vec3;
  /** the part's own underside, whatever buries it */
  base: number;
}
/** The wreck's list, rad about its length, and the scale that keeps the listing hull inside its extents. */
export const WRECK_LIST = -0.21;
export const WRECK_SCALE = 0.96;
function parts(t: TargetInstance): Part[] {
  const [hx, hy, hz] = t.halfExtents;
  const bed = -hy + 2 * hy * t.burial;
  if (t.class !== "SHIPWRECK") return [{ lo: [-hx, bed, -hz], hi: [hx, hy, hz], base: -hy }];
  const k = WRECK_SCALE;
  return [
    { lo: [-0.98 * hx, Math.min(bed, 0.1 * hy), -0.92 * hz * k], hi: [0.72 * hx, 0.15 * hy * k, 0.92 * hz * k], base: -0.98 * hy * k },
    { lo: [-0.83 * hx, Math.max(bed, 0.15 * hy * k), -0.5 * hz * k], hi: [-0.49 * hx, Math.max(bed + 0.01, hy * k), 0.5 * hz * k], base: 0.15 * hy * k },
  ];
}
/** Local frame to world, and the world direction back to local: yaw about +Y, and the wreck's list. */
function frame(t: TargetInstance) {
  const r = (t.yawDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const l = t.class === "SHIPWRECK" ? WRECK_LIST : 0;
  const cl = Math.cos(l);
  const sl = Math.sin(l);
  const dir = (x: number, y: number, z: number): Vec3 => {
    const y1 = y * cl - z * sl;
    const z1 = y * sl + z * cl;
    return [x * c + z1 * s, y1, -x * s + z1 * c];
  };
  const centre: Vec3 = [t.position[0], t.position[1] - t.burial * t.halfExtents[1], t.position[2]];
  return {
    dir,
    point: (x: number, y: number, z: number): Vec3 => {
      const d = dir(x, y, z);
      return [centre[0] + d[0], centre[1] + d[1], centre[2] + d[2]];
    },
    back: (v: Vec3): Vec3 => {
      const x = v[0] * c - v[2] * s;
      const z1 = v[0] * s + v[2] * c;
      return [x, v[1] * cl + z1 * sl, -v[1] * sl + z1 * cl];
    },
    centre,
  };
}

/** Lattice on the exposed surface: the top and the four sides of every part that stands clear of the seabed. */
interface SurfacePatch {
  p: Vec3;
  n: Vec3;
}
const LATTICE = [-1, -0.5, 0, 0.5, 1];
export function surfacePatches(t: TargetInstance): SurfacePatch[] {
  const f = frame(t);
  const out: SurfacePatch[] = [];
  for (const { lo, hi, base } of parts(t)) {
    const push = (a: number, up: number, b: number, nx: number, ny: number, nz: number) => {
      const x = lo[0] + ((a + 1) / 2) * (hi[0] - lo[0]);
      const z = lo[2] + ((b + 1) / 2) * (hi[2] - lo[2]);
      let y0 = lo[1];
      if (t.bed && up < 1) {
        // the side stands on the ground that is really there
        const q = f.point(x, lo[1], z);
        y0 = Math.min(hi[1] - 0.02, Math.max(base, lo[1] + t.bed(q[0], q[2]) - q[1]));
      }
      out.push({ p: f.point(x, y0 + up * (hi[1] - y0), z), n: f.dir(nx, ny, nz) });
    };
    for (const a of LATTICE) {
      for (const b of [-1, 0, 1]) push(a, 1, b, 0, 1, 0);
      for (const b of [0.05, 0.5, 1])
        for (const sgn of [-1, 1]) {
          push(a, b, sgn, 0, 0, sgn);
          push(sgn, b, a, sgn, 0, 0);
        }
    }
  }
  return out;
}

/** A pipe or cable is never seen whole: it is judged by the segment in view, this many half-widths long. */
const SEGMENT_ASPECT = 6;
export function segments(t: TargetInstance): TargetInstance[] {
  const [hx, hy, hz] = t.halfExtents;
  const n = Math.max(1, Math.ceil(hx / (SEGMENT_ASPECT * Math.max(hy, hz))));
  if (n === 1) return [t];
  const r = (t.yawDeg * Math.PI) / 180;
  const half = hx / n;
  return Array.from({ length: n }, (_, i) => {
    const lx = -hx + half * (2 * i + 1);
    return { ...t, position: [t.position[0] + lx * Math.cos(r), t.position[1], t.position[2] - lx * Math.sin(r)] as Vec3, halfExtents: [half, hy, hz] as [number, number, number] };
  });
}

/** A target's box in the frame, normalised u, v, w, h clamped to it; null when none of it is in the picture. */
export function targetBox(camera: CameraPose, t: TargetInstance): [number, number, number, number] | null {
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity;
  for (const seg of segments(t))
    for (const patch of surfacePatches(seg)) {
      if (dot(sub(camera.position, patch.p), patch.n) <= 0) continue;
      const q = project(camera, patch.p);
      if (!(q.depth > 0.05)) continue;
      minU = Math.min(minU, q.u);
      maxU = Math.max(maxU, q.u);
      minV = Math.min(minV, q.v);
      maxV = Math.max(maxV, q.v);
    }
  const u = Math.min(1, Math.max(0, minU));
  const v = Math.min(1, Math.max(0, minV));
  const w = Math.min(1, Math.max(0, maxU)) - u;
  const h = Math.min(1, Math.max(0, maxV)) - v;
  return w > 0 && h > 0 ? [u, v, w, h] : null;
}

/** Ray grid over the image; each ray's hit on a target's exposed box, if any. */
const RAYS_X = 14;
const RAYS_Y = 10;
export function boxHits(camera: CameraPose, t: TargetInstance): Vec3[] {
  const f = frame(t);
  const boxes = parts(t);
  const o = f.back(sub(camera.position, f.centre));
  const tanH = Math.tan((camera.hfovDeg * Math.PI) / 360);
  const tanV = tanH / camera.aspect;
  const out: Vec3[] = [];
  for (let i = 0; i < RAYS_X; i++)
    for (let j = 0; j < RAYS_Y; j++) {
      const x = (((i + 0.5) / RAYS_X) * 2 - 1) * tanH;
      const y = (1 - ((j + 0.5) / RAYS_Y) * 2) * tanV;
      const dir: Vec3 = [0, 1, 2].map((k) => camera.forward[k] + camera.right[k] * x + camera.up[k] * y) as Vec3;
      const d = f.back(dir);
      let near = Infinity;
      for (const { lo, hi } of boxes) {
        let t0 = 0.05;
        let t1 = Infinity;
        for (let k = 0; k < 3 && t0 <= t1; k++) {
          if (Math.abs(d[k]) < 1e-9) {
            if (o[k] < lo[k] || o[k] > hi[k]) t1 = -1;
            continue;
          }
          const a = (lo[k] - o[k]) / d[k];
          const b = (hi[k] - o[k]) / d[k];
          t0 = Math.max(t0, Math.min(a, b));
          t1 = Math.min(t1, Math.max(a, b));
        }
        if (t0 <= t1) near = Math.min(near, t0);
      }
      if (near < Infinity) out.push([camera.position[0] + dir[0] * near, camera.position[1] + dir[1] * near, camera.position[2] + dir[2] * near]);
    }
  return out;
}

export function runFieldDetection(input: DetectorInput): FieldDetection[] {
  const { env, camera, targets, previous } = input;
  const out: FieldDetection[] = [];
  const f = focalPx(camera);
  const speed = len(input.cameraVelocity);
  // contrast at range d is at least exp(-c d) of the clearest channel: past this nothing can exceed 2 percent
  const clear = Math.min(...pathOptics(env, input.turbidity, [0, 0, 0], [0, 0, 0]).c);
  const blind = Math.min(60, (1.6 * Math.log(1 / CONTRAST_BLIND)) / clear);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    // beyond the range at which any contrast survives: nothing to project
    if (len(sub(t.position, camera.position)) - Math.hypot(...t.halfExtents) > blind) continue;
    let minU = Infinity,
      minV = Infinity,
      maxU = -Infinity,
      maxV = -Infinity,
      evidence = 0;
    let optics: WaterOptics | null = null;
    let used: { p: Vec3; d: number; s: number }[] = [];
    let occluded = 0;
    // the `need` best-seen points with a clear line to the lens: what terrain or a structure hides is not evidence
    const clearest = (all: typeof used, need: number) => {
      const seen: typeof used = [];
      let tested = 0;
      for (const x of all.sort((a, b) => b.s - a.s || a.d - b.d)) {
        if (seen.length >= need || x.s <= 0) break;
        tested++;
        if (input.occlusion(camera.position, x.p) < 0.5) seen.push(x);
      }
      return { seen, e: seen.reduce((a, x) => a + x.s, 0) / need, occluded: tested ? 1 - seen.length / tested : 0 };
    };
    for (const seg of segments(t)) {
      // patches facing the lens, and which of them land in the frame
      let facing = 0;
      const inFrame: typeof used = [];
      for (const patch of surfacePatches(seg)) {
        const view = sub(camera.position, patch.p);
        if (dot(view, patch.n) <= 0) continue;
        facing++;
        const q = project(camera, patch.p);
        if (!(q.depth > 0.05)) continue;
        minU = Math.min(minU, q.u);
        maxU = Math.max(maxU, q.u);
        minV = Math.min(minV, q.v);
        maxV = Math.max(maxV, q.v);
        if (q.u < 0 || q.u > 1 || q.v < 0 || q.v > 1) continue;
        const d = len(view);
        optics ??= pathOptics(env, input.turbidity, camera.position, patch.p);
        inFrame.push({ p: patch.p, d, s: pathSignal(env, optics, input, camera.position[1], patch.p[1], d) });
      }
      if (!facing) continue;
      const need = Math.max(1, Math.ceil(facing * EVIDENCE_FRACTION));
      const best = clearest(inFrame, need);
      if (best.e > evidence) [evidence, used, occluded] = [best.e, best.seen, best.occluded];
    }
    if (!(maxU > minU && maxV > minV) || maxU < 0 || minU > 1 || maxV < 0 || minV > 1) continue;
    if (evidence < PARTIAL_VIEW) {
      const hits = boxHits(camera, t);
      if (hits.length) {
        optics ??= pathOptics(env, input.turbidity, camera.position, hits[0]);
        const water = optics;
        const scored = hits.map((p) => {
          const d = len(sub(p, camera.position));
          return { p, d, s: pathSignal(env, water, input, camera.position[1], p[1], d) };
        });
        const needHits = Math.ceil(RAYS_X * RAYS_Y * FRAME_FRACTION);
        const best = clearest(scored, needHits);
        const filled = PARTIAL_VIEW * best.e;
        if (filled > evidence) [evidence, used, occluded] = [filled, best.seen, best.occluded];
      }
    }
    if (evidence <= 0 || !used.length) continue;
    const distance = used.reduce((a, x) => a + x.d, 0) / used.length;

    const u = Math.min(1, Math.max(0, minU));
    const v = Math.min(1, Math.max(0, minV));
    const w = Math.min(1, Math.max(0, maxU)) - u;
    const h = Math.min(1, Math.max(0, maxV)) - v;
    if (!(w > 0 && h > 0)) continue;

    const cu = u + w / 2;
    const cv = v + h / 2;
    const rSq = (cu * 2 - 1) ** 2 + (cv * 2 - 1) ** 2;
    const geometry = 1 - 0.3 * rSq - 0.15 * t.burial;

    const sizePx = Math.min(w * camera.width, h * camera.height);
    const size = smoothstep(6, 28, sizePx);
    // smear: lateral speed over distance plus turn rate, both in pixels over the exposure
    const along = dot(input.cameraVelocity, camera.forward);
    const lateral = Math.sqrt(Math.max(0, speed * speed - along * along));
    const blurPx = input.exposureS * f * (lateral / Math.max(0.2, distance) + input.cameraAngularRate);
    const blur = 1 / (1 + (blurPx / 8) ** 2);

    const jitter = (hash01(i + 1, input.tick, input.seed) - 0.5) * 0.02;
    const raw = Math.min(0.995, Math.max(0, t.detectability * geometry * evidence * size * blur + jitter));

    // a tracker, as every real pipeline has behind its detector: confidence is smoothed over about 0.2 s, and a track
    // survives a short blur or glance away (coasts) as long as the object is still in the picture
    const prev = previous.get(t.id);
    const confidence = prev ? prev.confidence + TRACK_BLEND * (raw - prev.confidence) : raw;
    const gate = prev ? input.threshold - HYSTERESIS : input.threshold;
    const coastS = confidence >= gate ? 0 : (prev?.coastS ?? Infinity) + input.dt;
    if (coastS > COAST_S || (coastS > 0 && raw < 0.1)) continue;
    // a track keeps the class it was once recognised as, as trackers that vote over their history do: an object does not
    // turn into something else because the next view of it is worse
    const cls: FieldClass = coastS > 0 ? prev!.class : prev?.class === t.class || confidence >= CLASSIFY_THRESHOLD ? t.class : CONFUSION[t.class];
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
      state: coastS > 0 ? "COASTING" : age >= 0.6 ? "LOCKED" : "DETECTED",
      coastS,
      age,
    });
  }
  return out;
}
