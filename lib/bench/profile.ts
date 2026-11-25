// A vision model's measured behaviour across test conditions, in one shape for both sources:
//   measured:  a completed backend run (real inference on rendered, ground-truth-labelled frames)
//   simulated: a seeded roster of archetypes for demonstrating the platform with no models uploaded. Never a real model.

import { contrastRatio, waterDetectability, waterOptics } from "../optics/water";
import { ENVIRONMENTS, environmentWater, lightPaths } from "../sim/environments";
import { mulberry32 } from "../sim/rng";
import type { RunMetrics, RunRecord } from "../api/types";
import { GT_CLASSES, type GtClass } from "../world/schema";

/** Bucket labels and edges match backend/gantrylab/metrics/buckets.py. */
export const TURBIDITY = ["clear", "light", "moderate", "heavy"] as const;
export const LIGHTING = ["dark", "dim", "bright"] as const;
export const TURBIDITY_EDGES = [0.1, 0.3, 0.6];
export const LIGHTING_EDGES = [0.3, 0.6];
const bucketOf = (edges: number[], v: number) => edges.filter((e) => v >= e).length;
export const turbidityBucket = (t: number) => bucketOf(TURBIDITY_EDGES, t);
export const lightingBucket = (l: number) => bucketOf(LIGHTING_EDGES, l);
/** One setting inside each turbidity and lighting bucket, for the capture presets that fill every joint cell. */
export const CONDITION_GRID: [number, number][] = [0.05, 0.2, 0.45, 0.65].flatMap((t) => [0.2, 0.45, 0.8].map((l) => [t, l] as [number, number]));
/** Fewer ground-truth objects than this is not evidence. Stricter than the backend's 5: cells here decide which model runs. */
export const MIN_SUPPORT = 10;

export interface Counts {
  nGt: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface Slice extends Counts {
  id: string;
  key: string;
  bucket: string;
  order: number;
  /** false: predictions carry no such attribute, so only recall is defined */
  hasPrecision: boolean;
}

export interface SweepPoint {
  conf: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface ModelProfile {
  id: string;
  name: string;
  source: "measured" | "simulated";
  /** mock-adapter runs are not evidence about a model */
  mock: boolean;
  note: string;
  datasetId: string | null;
  datasetName: string;
  runId: string | null;
  latencyMs: number | null;
  latencyKind: "measured" | "estimated" | "simulated" | "not_measured";
  conf: number;
  overall: Counts;
  map50: number | null;
  byClass: Record<string, Counts>;
  slices: Slice[];
  /** turbidity (4) x lighting (3), or null when the dataset did not vary both */
  cells: Counts[][] | null;
  sweep: SweepPoint[];
  confusions: { gt: string; pred: string; count: number }[];
  fpTypes: Record<string, number>;
  fnTypes: Record<string, number>;
}

export const recall = (c: Counts) => (c.nGt > 0 ? c.tp / c.nGt : null);
export const precision = (c: Counts) => (c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : null);
export const f1 = (c: Counts) => (c.nGt > 0 || c.fp > 0 ? (2 * c.tp) / Math.max(1, 2 * c.tp + c.fp + c.fn) : null);
export const addCounts = (a: Counts, b: Counts): Counts => ({ nGt: a.nGt + b.nGt, tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn });
export const ZERO: Counts = { nGt: 0, tp: 0, fp: 0, fn: 0 };
export const sliceScore = (s: Slice) => (s.hasPrecision ? f1(s) : recall(s));

/* ---------- measured ---------- */

export function profileFromRun(run: RunRecord, m: RunMetrics): ModelProfile {
  const counts = (o: { n_gt: number; tp: number; fp: number | null; fn: number }): Counts => ({ nGt: o.n_gt, tp: o.tp, fp: o.fp ?? 0, fn: o.fn });
  let cells: Counts[][] | null = null;
  if (m.condition_cells?.length) {
    cells = TURBIDITY.map(() => LIGHTING.map(() => ({ ...ZERO })));
    for (const c of m.condition_cells) {
      const t = (TURBIDITY as readonly string[]).indexOf(c.turbidity);
      const l = (LIGHTING as readonly string[]).indexOf(c.lighting);
      if (t >= 0 && l >= 0) cells[t][l] = counts(c);
    }
  }
  const sw = m.pr.conf_sweep;
  return {
    id: run.id,
    name: `${run.model.name} v${run.model.version}`,
    source: "measured",
    mock: m.mock,
    note: m.mock ? "MOCK ADAPTER - not a real model evaluation" : `${m.n_frames} frames, ${run.adapter}`,
    datasetId: run.dataset.id,
    datasetName: run.dataset.name,
    runId: run.id,
    latencyMs: m.latency.total_ms.p50,
    latencyKind: m.latency.kind,
    conf: m.conf_threshold,
    overall: counts(m.overall),
    map50: m.overall.map50,
    byClass: Object.fromEntries(Object.entries(m.per_class).map(([k, c]) => [k, { nGt: c.support, tp: c.tp, fp: c.fp, fn: c.fn }])),
    slices: m.slices.map((s) => ({ ...counts(s), id: s.id, key: s.key, bucket: s.bucket, order: s.order, hasPrecision: s.scope === "full" })),
    cells,
    sweep: sw.thresholds.map((t, i) => ({ conf: t, precision: sw.precision[i], recall: sw.recall[i], f1: sw.f1[i] })),
    confusions: m.confused_pairs.map((c) => ({ gt: c.gt_class, pred: c.pred_class, count: c.count })),
    fpTypes: m.fp_types,
    fnTypes: m.fn_types,
  };
}

/* ---------- simulated roster ---------- */

interface Archetype {
  id: string;
  name: string;
  note: string;
  latencyMs: number;
  /** confidence on a perfect view */
  peak: number;
  /** how much of the water's contrast loss reaches the confidence, 0 (immune) .. 1 */
  water: number;
  /** same for light */
  light: number;
  /** same for distance */
  far: number;
  /** false positives per frame in clear and in heavy water */
  fp: [number, number];
  /** per-class skill; a low value is a class the training data lacked */
  classes: Partial<Record<GtClass, number>>;
}

const ROSTER: Archetype[] = [
  { id: "sim-general", name: "SIM General", note: "Strong in clear water, trained on little turbid data", latencyMs: 520, peak: 0.95, water: 0.95, light: 0.5, far: 0.35, fp: [0.1, 0.25], classes: { PIPELINE: 0.9 } },
  { id: "sim-turbid", name: "SIM Turbid-tuned", note: "Haze-augmented: holds up in silt, over-fires on clear-water clutter", latencyMs: 540, peak: 0.84, water: 0.45, light: 0.55, far: 0.4, fp: [0.75, 0.35], classes: { TIRE: 0.85 } },
  { id: "sim-lowlight", name: "SIM Low-light", note: "Brightness-augmented: best in the dark, average elsewhere", latencyMs: 560, peak: 0.83, water: 0.75, light: 0.1, far: 0.4, fp: [0.3, 0.45], classes: { MINE: 0.9 } },
  { id: "sim-nano", name: "SIM Nano", note: "Small and fast, misses small and distant objects", latencyMs: 140, peak: 0.86, water: 0.85, light: 0.55, far: 0.75, fp: [0.2, 0.4], classes: { MINE: 0.85, TIRE: 0.75 } },
];

const MID_T = [0.05, 0.2, 0.45, 0.65];
const MID_L = [0.15, 0.45, 0.8];
const DIST = [
  { label: "<1m", k: 0 },
  { label: "1-2m", k: 0.4 },
  { label: "2-4m", k: 1 },
];
const CONFUSION: Record<GtClass, GtClass> = { SHIPWRECK: "DEBRIS", MINE: "DEBRIS", DEBRIS: "MINE", TIRE: "DEBRIS", PIPELINE: "DEBRIS" };
const PER_CELL = 8; // objects of each class per (turbidity, lighting, distance) cell

interface Trial {
  t: number;
  l: number;
  d: number;
  /** null = a false positive */
  gt: GtClass | null;
  conf: number;
  pred: GtClass;
}

/** Contrast the tank's water leaves at the gantry's working distance, 0..1, per turbidity bucket. */
const waterQuality = MID_T.map((t) => {
  const env = ENVIRONMENTS.tank;
  return waterDetectability(contrastRatio(waterOptics(environmentWater(env, t)), { pathM: 0.42, ...lightPaths(env, 0.02, 0.42), backgroundReflectance: env.seabedReflectance }));
});

/** Runs an archetype over every condition cell; seeded, so the roster is identical everywhere. */
function simulate(a: Archetype, seed: number): Trial[] {
  const rand = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const out: Trial[] = [];
  for (let t = 0; t < TURBIDITY.length; t++)
    for (let l = 0; l < LIGHTING.length; l++)
      for (let d = 0; d < DIST.length; d++) {
        const loss = a.water * (1 - waterQuality[t]) + a.light * (1 - Math.pow(MID_L[l], 0.5)) + a.far * 0.45 * DIST[d].k;
        for (const gt of GT_CLASSES)
          for (let k = 0; k < PER_CELL; k++) {
            const conf = a.peak * (a.classes[gt] ?? 1) * (1 - loss) + 0.13 * gauss();
            const confused = conf < 0.5 && rand() < 0.3;
            out.push({ t, l, d, gt, conf: Math.min(0.99, conf), pred: confused ? CONFUSION[gt] : gt });
          }
        const rate = a.fp[0] + (a.fp[1] - a.fp[0]) * (t / (TURBIDITY.length - 1));
        // clutter fires like a real detector's background: many weak boxes, few strong ones
        for (let k = 0; k < PER_CELL * 6; k++) if (rand() < rate) out.push({ t, l, d, gt: null, conf: 0.03 + 0.17 * -Math.log(1 - 0.98 * rand()), pred: GT_CLASSES[Math.floor(rand() * GT_CLASSES.length)] });
      }
  return out;
}

function tally(trials: Trial[], conf: number): Counts {
  const c = { ...ZERO };
  for (const x of trials) {
    const fired = x.conf >= conf;
    if (x.gt) {
      c.nGt++;
      if (fired && x.pred === x.gt) c.tp++;
      else {
        c.fn++;
        if (fired) c.fp++; // a wrong label is both a miss and a false positive
      }
    } else if (fired) c.fp++;
  }
  return c;
}

export const SIM_CONF = 0.25;
const round2 = (v: number) => Math.round(v * 100) / 100;

function simulatedProfile(a: Archetype, seed: number): ModelProfile {
  const trials = simulate(a, seed);
  const conf = SIM_CONF;
  const slice = (key: string, labels: readonly string[], of: (x: Trial) => number, hasPrecision = true): Slice[] =>
    labels.map((bucket, order) => ({ ...tally(trials.filter((x) => of(x) === order), conf), id: `slice:${key}:${bucket}`, key, bucket, order, hasPrecision }));
  const sweep = Array.from({ length: 19 }, (_, i) => round2(0.05 + i * 0.05)).map((th) => {
    const c = tally(trials, th);
    return { conf: th, precision: precision(c), recall: recall(c), f1: f1(c) };
  });
  const confusions = new Map<string, number>();
  for (const x of trials) if (x.gt && x.conf >= conf && x.pred !== x.gt) confusions.set(`${x.gt}>${x.pred}`, (confusions.get(`${x.gt}>${x.pred}`) ?? 0) + 1);
  const missed = trials.filter((x) => x.gt && x.conf < conf).length;
  const wrong = trials.filter((x) => x.gt && x.conf >= conf && x.pred !== x.gt).length;
  return {
    id: a.id,
    name: a.name,
    source: "simulated",
    mock: false,
    note: a.note,
    datasetId: "sim-benchmark",
    datasetName: "Simulated condition grid",
    runId: null,
    latencyMs: a.latencyMs,
    latencyKind: "simulated",
    conf,
    overall: tally(trials, conf),
    map50: null,
    byClass: Object.fromEntries(GT_CLASSES.map((g) => [g, { ...tally(trials.filter((x) => x.gt === g), conf), fp: trials.filter((x) => x.gt !== g && x.conf >= conf && x.pred === g).length }])),
    slices: [...slice("turbidity", TURBIDITY, (x) => x.t), ...slice("lighting", LIGHTING, (x) => x.l), ...slice("distance_m", DIST.map((d) => d.label), (x) => x.d, false)],
    cells: TURBIDITY.map((_, t) => LIGHTING.map((_, l) => tally(trials.filter((x) => x.t === t && x.l === l), conf))),
    sweep,
    confusions: [...confusions].map(([k, count]) => ({ gt: k.split(">")[0], pred: k.split(">")[1], count })).sort((p, q) => q.count - p.count),
    fpTypes: { background: trials.filter((x) => !x.gt && x.conf >= conf).length, class_confusion: wrong },
    fnTypes: { below_conf_threshold: missed, misclassified: wrong },
  };
}

export const SIMULATED_ROSTER: ModelProfile[] = ROSTER.map((a, i) => simulatedProfile(a, 4242 + i));
