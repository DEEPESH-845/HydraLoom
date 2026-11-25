// Specific changes worth making, each with the numbers behind it and an honest effect:
//   exact       recomputed from stored detections (a threshold change) or stored counts (routing), on the same frames
//   upper bound what closing a gap completely would give; training changes cannot be predicted, only bounded
// Nothing here claims improved weights.

import { f1, precision, recall, type ModelProfile, type Slice } from "./profile";
import { isCondition, routingGain, sharedBlindSpots, supported } from "./compare";

export interface Advice {
  id: string;
  /** null = about the set of models */
  modelId: string | null;
  kind: "threshold" | "augmentation" | "data" | "resolution" | "routing" | "operation" | "compute";
  title: string;
  /** the concrete change, ready to paste or do */
  change: string;
  evidence: string;
  tradeoff: string;
  effect: { before: number; after: number; basis: "exact" | "upper bound" } | null;
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(0)}%`);
const keyName = (k: string) => k.replace(/_(m|mps|px)$/, "").replace(/_/g, " ");

const AUGMENT: Record<string, { change: string; tradeoff: string }> = {
  turbidity: { change: "hyp.yaml: hsv_s 0.9; add haze/backscatter augmentation (albumentations RandomFog p=0.2)", tradeoff: "Haze augmentation can cost a little clear-water precision; re-run the clear slice." },
  ntu: { change: "hyp.yaml: hsv_s 0.9; add haze/backscatter augmentation (albumentations RandomFog p=0.2)", tradeoff: "Haze augmentation can cost a little clear-water precision; re-run the clear slice." },
  lighting: { change: "hyp.yaml: hsv_v 0.6; add dark frames from the lighting sweep capture preset", tradeoff: "Too much brightness jitter hurts well-lit scenes; check the bright slice." },
  motion_blur_px: { change: "Add MotionBlur (p=0.15) to training, or halve exposure time / vehicle speed", tradeoff: "Shorter exposure needs more light; blur augmentation softens fine detail." },
  vehicle_speed_mps: { change: "Cap survey speed at the best bucket's upper edge, or shorten exposure", tradeoff: "Slower surveys cover less area per hour." },
  occlusion: { change: "hyp.yaml: mixup 0.1, copy_paste 0.1; capture partially buried targets", tradeoff: "Mixup slows convergence; keep it small." },
};

/** Slices of one key, weakest first, with the gap to the strongest supported bucket. */
function gap(p: ModelProfile, key: string): { worst: Slice; best: Slice; size: number } | null {
  const ss = p.slices.filter((s) => s.key === key && supported(s));
  if (ss.length < 2) return null;
  const by = (a: Slice, b: Slice) => recall(a)! - recall(b)!;
  const sorted = [...ss].sort(by);
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];
  return { worst, best, size: recall(best)! - recall(worst)! };
}

/** Overall F1 if the weak bucket's recall rose to the strong bucket's, false positives unchanged. */
function closingGap(p: ModelProfile, worst: Slice, best: Slice): number {
  const gained = Math.max(0, Math.round(worst.nGt * recall(best)!) - worst.tp);
  return f1({ ...p.overall, tp: p.overall.tp + gained, fn: Math.max(0, p.overall.fn - gained) }) ?? 0;
}

export function adviseModel(p: ModelProfile, budgetMs: number): Advice[] {
  const out: Advice[] = [];
  const base = f1(p.overall) ?? 0;
  const add = (a: Omit<Advice, "id" | "modelId">) => out.push({ ...a, id: `${p.id}:${out.length}`, modelId: p.id });

  if (p.overall.tp === 0) {
    add({
      kind: "data",
      title: "This model finds none of the targets",
      change: "Check the class map first (Model Lab, step 3). If its classes are not these objects, fine-tune it: capture the Condition grid, export the YOLO zip from Model Lab and train on it",
      evidence: `0 of ${p.overall.nGt} labelled objects were found${p.overall.fp ? ` and ${p.overall.fp} boxes were false` : " and nothing was reported"}.`,
      tradeoff: "Use different layouts and seeds for training and for this benchmark, or the score only measures memory.",
      effect: null,
    });
    return out;
  }

  const peak = p.sweep.filter((s) => s.f1 !== null).reduce<(typeof p.sweep)[number] | null>((b, s) => (!b || s.f1! > b.f1! + 1e-9 ? s : b), null);
  if (peak && Math.abs(peak.conf - p.conf) >= 0.05 && peak.f1! - base >= 0.01)
    add({
      kind: "threshold",
      title: `Set the confidence threshold to ${peak.conf.toFixed(2)}`,
      change: `inference.yaml: conf: ${peak.conf.toFixed(2)} (now ${p.conf.toFixed(2)})`,
      evidence: `The sweep peaks at precision ${pct(peak.precision)}, recall ${pct(peak.recall)}; now ${pct(precision(p.overall))} and ${pct(recall(p.overall))}.`,
      tradeoff: peak.conf > p.conf ? "Fewer false alarms, some weak true detections lost." : "More weak objects found, more false alarms.",
      effect: { before: base, after: peak.f1!, basis: "exact" },
    });

  for (const key of [...new Set(p.slices.map((s) => s.key))].filter((k, _, all) => isCondition(k) && !(k === "ntu" && all.includes("turbidity")))) {
    const g = gap(p, key);
    if (!g || g.size < 0.15) continue;
    const aug = AUGMENT[key];
    const ev = `Recall ${pct(recall(g.worst))} at ${keyName(key)} "${g.worst.bucket}" (${g.worst.nGt} objects) against ${pct(recall(g.best))} at "${g.best.bucket}".`;
    const effect = { before: base, after: closingGap(p, g.worst, g.best), basis: "upper bound" as const };
    if (aug) add({ kind: "augmentation", title: `Train for ${keyName(key)} "${g.worst.bucket}"`, change: aug.change, evidence: ev, tradeoff: aug.tradeoff, effect });
    else if (key === "distance_m") add({ kind: "operation", title: `Work closer than "${g.worst.bucket}"`, change: `Set the stand-off to the "${g.best.bucket}" range, or raise imgsz (640 to 960) and retrain at that size`, evidence: ev, tradeoff: "A closer camera covers less floor per view; a larger image costs latency roughly with its square.", effect });
    else if (key === "object_size") add({ kind: "resolution", title: "Raise the input resolution for small objects", change: "inference.yaml and hyp.yaml: imgsz 960", evidence: ev, tradeoff: "Latency grows roughly with imgsz squared; re-check the compute budget.", effect });
    else if (!["current_dir_deg", "environment", "platform", "seed"].includes(key)) add({ kind: "data", title: `Collect data at ${keyName(key)} "${g.worst.bucket}"`, change: `Capture a sweep of ${keyName(key)} in the twin and add it to training`, evidence: ev, tradeoff: "More frames to render and label-check.", effect });
  }

  const classes = Object.entries(p.byClass).filter(([, c]) => supported(c));
  if (classes.length > 1) {
    const sorted = [...classes].sort((a, b) => recall(a[1])! - recall(b[1])!);
    const [wName, w] = sorted[0];
    const [bName, b] = sorted[sorted.length - 1];
    if (recall(b)! - recall(w)! >= 0.15)
      add({
        kind: "data",
        title: `${wName} is the weakest class`,
        change: `Add ${wName} examples (more poses, burial and water) and oversample it; hyp.yaml: cls 1.0 if it is mostly misclassified`,
        evidence: `${wName} recall ${pct(recall(w))} (${w.nGt} objects) against ${bName} ${pct(recall(b))}.`,
        tradeoff: "Watch the other classes' precision after rebalancing.",
        effect: { before: base, after: closingGap(p, { ...w, id: "", key: "", bucket: "", order: 0, hasPrecision: true }, { ...b, id: "", key: "", bucket: "", order: 0, hasPrecision: true }), basis: "upper bound" },
      });
  }
  const top = p.confusions[0];
  if (top && top.count >= 3 && top.count / Math.max(1, p.overall.tp) >= 0.03)
    add({ kind: "data", title: `Separate ${top.gt} from ${top.pred}`, change: `Add hard pairs of ${top.gt} and ${top.pred} in the same frames; hyp.yaml: cls 1.0`, evidence: `${top.count} ${top.gt} objects were reported as ${top.pred}.`, tradeoff: "A higher class loss can slow box regression.", effect: null });
  if (p.latencyMs !== null && p.latencyMs > budgetMs)
    add({ kind: "compute", title: "Too slow for the frame budget", change: "Export to ONNX/NCNN INT8, drop imgsz, or use a smaller variant on this device", evidence: `${p.latencyMs.toFixed(0)} ms per frame (${p.latencyKind}) against a ${budgetMs.toFixed(0)} ms budget.`, tradeoff: "Quantisation usually costs 1 to 3 points of mAP; re-run this benchmark on the export.", effect: null });
  return out;
}

export function adviseSet(ps: ModelProfile[]): Advice[] {
  const out: Advice[] = [];
  const g = routingGain(ps);
  if (g && ps.length > 1 && g.routed.f1 - g.bestSingle.f1 >= 0.005)
    out.push({
      id: "set:routing",
      modelId: null,
      kind: "routing",
      title: "Switch models by condition",
      change: "Deploy the learned switching policy (Autonomy, export policy JSON) instead of one model",
      evidence: `Running each cell's best model scores F1 ${pct(g.routed.f1)} against ${pct(g.bestSingle.f1)} for ${ps[g.bestSingle.index].name} alone${g.closeCells ? `; ${g.closeCells} cell(s) are decided by under 2 points` : ""}.`,
      tradeoff: "Needs the models resident in memory or a load delay at each switch. The gain is measured on the same frames that chose the winners.",
      effect: { before: g.bestSingle.f1, after: g.routed.f1, basis: "exact" },
    });
  const dead = ps.filter((p, i) => ps.some((q, j) => j !== i && dominates(q, p)));
  for (const p of dead.filter((x) => x.overall.tp > 0)) out.push({ id: `set:drop:${p.id}`, modelId: p.id, kind: "compute", title: `${p.name} never earns its place`, change: "Leave it out of the deployed set", evidence: "Another model matches or beats it in every condition cell and is no slower.", tradeoff: "None on this benchmark; keep it if it covers conditions not tested here.", effect: null });
  for (const b of sharedBlindSpots(ps).slice(0, 3))
    out.push({ id: `set:blind:${b.key}:${b.bucket}`, modelId: null, kind: "data", title: `No model works at ${keyName(b.key)} "${b.bucket}"`, change: `Capture and label ${keyName(b.key)} "${b.bucket}" frames and retrain at least one model on them; until then treat this condition as out of envelope`, evidence: `The best recall there is ${pct(b.best)} (${b.model}). No choice of model fixes it.`, tradeoff: "Until retrained, limit operations to conditions inside the envelope.", effect: null });
  return out;
}

function dominates(a: ModelProfile, b: ModelProfile): boolean {
  if (!a.cells || !b.cells || (a.latencyMs ?? Infinity) > (b.latencyMs ?? Infinity)) return false;
  return a.cells.every((row, t) => row.every((c, l) => !supported(b.cells![t][l]) || (supported(c) && (f1(c) ?? 0) >= (f1(b.cells![t][l]) ?? 0))));
}
