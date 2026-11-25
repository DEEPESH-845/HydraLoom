// Cross-model analysis: where each model performs best, where it fails, who wins where, and what a router would gain.

import { LIGHTING, MIN_SUPPORT, TURBIDITY, ZERO, addCounts, f1, recall, sliceScore, type Counts, type ModelProfile, type Slice } from "./profile";

/** Models are only comparable on the same dataset. */
export function comparableGroups(profiles: ModelProfile[]): { datasetId: string; datasetName: string; profiles: ModelProfile[] }[] {
  const groups = new Map<string, { datasetId: string; datasetName: string; profiles: ModelProfile[] }>();
  for (const p of profiles) {
    const k = p.datasetId ?? "unknown";
    const g = groups.get(k) ?? { datasetId: k, datasetName: p.datasetName, profiles: [] };
    g.profiles.push(p);
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.profiles.length - a.profiles.length);
}

/** Slice keys that describe where the frame was taken, not a condition a model can be good or bad at. */
const POSITIONAL = /^(gantry_|camera_|vehicle_(x|z|heading|pitch|roll)|seed|frame|heading|pitch|roll|yaw|pan|tilt|x_|y_|z_|environment_seed|platform$|site$)/;
export const isCondition = (key: string) => !POSITIONAL.test(key);

export const supported = (s: Counts) => s.nGt >= MIN_SUPPORT;

/** Best and worst supported condition slices of one model. Keys with a single bucket say nothing and are skipped. */
export function strengths(p: ModelProfile, top = 3): { best: Slice[]; worst: Slice[] } {
  const perKey = new Map<string, number>();
  for (const s of p.slices) if (supported(s) && isCondition(s.key)) perKey.set(s.key, (perKey.get(s.key) ?? 0) + 1);
  const ranked = p.slices.filter((s) => supported(s) && (perKey.get(s.key) ?? 0) > 1 && sliceScore(s) !== null).sort((a, b) => sliceScore(b)! - sliceScore(a)!);
  // a slice scoring zero is not a strength, whatever it ranks above
  return { best: ranked.filter((s) => sliceScore(s)! > 0).slice(0, top), worst: ranked.slice(-top).reverse() };
}

export interface WinnerCell {
  t: number;
  l: number;
  /** model index, or null when no model has enough support here */
  winner: number | null;
  scores: (number | null)[];
  /** lead over the runner-up */
  margin: number;
}

/** Which model has the best F1 in each turbidity x lighting cell; null when fewer than two models share cells. */
export function winnerMap(ps: ModelProfile[]): WinnerCell[][] | null {
  if (ps.length === 0 || ps.some((p) => !p.cells)) return null;
  // a tie goes to the better model overall: switching for nothing is a cost
  const overall = ps.map((p) => f1(p.overall) ?? 0);
  return TURBIDITY.map((_, t) =>
    LIGHTING.map((_, l) => {
      const scores = ps.map((p) => (supported(p.cells![t][l]) ? f1(p.cells![t][l]) : null));
      let winner: number | null = null;
      scores.forEach((s, i) => {
        if (s !== null && s > 0 && (winner === null || s > scores[winner]! + 1e-9 || (s > scores[winner]! - 1e-9 && overall[i] > overall[winner]))) winner = i;
      });
      const rest = scores.filter((s, i): s is number => s !== null && i !== winner);
      return { t, l, winner, scores, margin: winner === null || !rest.length ? 0 : scores[winner]! - Math.max(...rest) };
    }),
  );
}

export interface RoutingGain {
  bestSingle: { index: number; f1: number };
  routed: { f1: number; counts: Counts };
  /** a routing decision is only as good as its sample: cells decided by a margin below 0.02 */
  closeCells: number;
}

/** F1 of always running the per-cell winner against the best single model, on the same frames. In-sample, an upper bound. */
export function routingGain(ps: ModelProfile[]): RoutingGain | null {
  const map = winnerMap(ps);
  if (!map) return null;
  let counts = { ...ZERO };
  const singles = ps.map(() => ({ ...ZERO }) as Counts);
  let closeCells = 0;
  for (const row of map)
    for (const c of row) {
      if (c.winner === null) continue;
      counts = addCounts(counts, ps[c.winner].cells![c.t][c.l]);
      ps.forEach((p, i) => (singles[i] = addCounts(singles[i], p.cells![c.t][c.l])));
      if (c.margin < 0.02) closeCells++;
    }
  if (counts.nGt === 0) return null;
  const scores = singles.map((s) => f1(s) ?? 0);
  const index = scores.indexOf(Math.max(...scores));
  return { bestSingle: { index, f1: scores[index] }, routed: { f1: f1(counts) ?? 0, counts }, closeCells };
}

/** Conditions no model in the set handles: the gap more data has to close, not a model choice. */
export function sharedBlindSpots(ps: ModelProfile[], floor = 0.5): { key: string; bucket: string; best: number; model: string }[] {
  const out: { key: string; bucket: string; best: number; model: string }[] = [];
  const ids = [...new Set(ps.flatMap((p) => p.slices.filter((s) => isCondition(s.key)).map((s) => s.id)))];
  for (const id of ids) {
    let best = -1;
    let model = "";
    let ref: Slice | null = null;
    for (const p of ps) {
      const s = p.slices.find((x) => x.id === id);
      const r = s && supported(s) ? recall(s) : null;
      if (s && r !== null && r > best) [best, model, ref] = [r, p.name, s];
    }
    if (ref && best < floor) out.push({ key: ref.key, bucket: ref.bucket, best, model });
  }
  // a joint cell can be a blind spot although both of its marginal slices look fine
  for (const row of winnerMap(ps) ?? [])
    for (const c of row) {
      if (!ps.some((p) => supported(p.cells![c.t][c.l]))) continue;
      const r = Math.max(...ps.map((p) => recall(p.cells![c.t][c.l]) ?? 0));
      if (r < floor) out.push({ key: "turbidity x lighting", bucket: `${TURBIDITY[c.t]}, ${LIGHTING[c.l]}`, best: r, model: ps.find((p) => (recall(p.cells![c.t][c.l]) ?? 0) === r)!.name });
    }
  return out.sort((a, b) => a.best - b.best);
}
