// Learned gantry navigation: model-based reinforcement learning over "where should the camera look next".
// Deterministic for a seed. The policy sees only what the rig could know: the carriage position, the detections reported
// so far (ESTIMATED positions), the viewpoints already visited, and the water it senses.
//
//   reward  = 0.5 per new object, 1 per object first classified correctly, -0.5 per wrong label (returned when corrected),
//             minus 0.03 per second of travel and dwell
//   learned = the discovery reward of a viewpoint, r(phi) = w . phi, by stochastic regression on explored episodes
//   policy  = beam search over the next viewpoints with the learned reward, the known travel time and the known optics;
//             STOP when no plan is worth its time. One viewpoint is executed, then it replans on what was actually seen.
//
// docs/AUTONOMY.md documents the features, the training and the held-out evaluation.

import { CAMERA, DETECTION, GANTRY, TEST, clamp } from "../sim/constants";
import { lampLight, runDetection } from "../sim/detection";
import { ENVIRONMENTS, ENVIRONMENT_IDS, environmentWater, lightPaths } from "../sim/environments";
import { contrastRatio, waterDetectability, waterOptics } from "../optics/water";
import { mulberry32 } from "../sim/rng";
import { defaultScenario } from "../sim/scenario";
import type { Detection, Scenario } from "../sim/types";
import type { PlannerObservation, ScanPlanner, Viewpoint } from "../gantry/strategies";

export const FEATURES = ["bias", "new floor readable (typical object)", "new floor readable (distinct object)", "new floor readable (faint object)", "confirm uncertain label", "re-check sure label"] as const;
export type NavWeights = number[];
export const MAX_VIEWPOINTS = 20;
/** Reward: cost of a second of scan. */
export const TIME_COST = 0.03;
/** Planning: below the reward's cost, so the policy scans as thoroughly as the best hand-written planner (chosen on validation layouts). */
const PLAN_TIME_COST = 0.015;
const PLAN_DEPTH = 5;
const BEAM_WIDTH = 8;
/** Objects the floor is judged readable for: typical, distinct (wreck, mine) and faint (bracket, pipe). */
const OBJECT_KINDS = [0.8, 0.97, 0.71];

const [COLS, ROWS] = TEST.coverageGrid;
const CELLS: [number, number][] = [];
for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) CELLS.push([((c + 0.5) / COLS) * GANTRY.travelX, ((r + 0.5) / ROWS) * GANTRY.travelY]);
const GRID: [number, number][] = [];
for (let x = 5; x <= GANTRY.travelX - 5; x += 5) for (let y = 5; y <= GANTRY.travelY - 5; y += 5) GRID.push([x, y]);

export type WaterContext = Pick<Scenario, "environment" | "turbidity" | "lighting" | "gantrySpeed" | "threshold">;

/** How readable each floor cell is from each grid viewpoint, 0..1, for one kind of object: [viewpoint][cell]. */
export type ReadMap = Float32Array[];

/** The detector's own confidence model, so in murk the readable patch shrinks and the policy looks closer together. */
function readability(w: WaterContext, detectability: number): ReadMap {
  const env = ENVIRONMENTS[w.environment];
  const optics = waterOptics(environmentWater(env, w.turbidity));
  const tanH = Math.tan((CAMERA.hfovDeg * Math.PI) / 360);
  const z = 0.02;
  const halfW = CAMERA.lensHeight * tanH * 100;
  const halfH = halfW / CAMERA.aspect;
  const q = (dx: number, dy: number) => {
    const u = dx / halfW;
    const v = dy / halfH;
    if (Math.abs(u) > 1 || Math.abs(v) > 1) return 0;
    const distance = Math.hypot(dx / 100, dy / 100, CAMERA.lensHeight - z);
    const water = waterDetectability(contrastRatio(optics, { pathM: distance, ...lightPaths(env, z, distance), backgroundReflectance: env.seabedReflectance }));
    const light = env.light === "lamp" ? lampLight(w.lighting, optics.kd[1], distance) : Math.pow(clamp(w.lighting, 0, 1), DETECTION.lightingGamma);
    const conf = detectability * (1 - DETECTION.centeringWeight * (u * u + v * v) - DETECTION.burialWeight * 0.2) * water * light;
    return clamp((conf - (w.threshold - 0.03)) / 0.08, 0, 1);
  };
  // grid offsets repeat, so each distinct offset is evaluated once
  const memo = new Map<string, number>();
  return GRID.map(([x, y]) =>
    Float32Array.from(CELLS, ([cx, cy]) => {
      const dx = Math.abs(cx - x);
      const dy = Math.abs(cy - y);
      const k = `${dx.toFixed(3)},${dy.toFixed(3)}`;
      let val = memo.get(k);
      if (val === undefined) memo.set(k, (val = q(dx, dy)));
      return val;
    }),
  );
}

export const readMaps = (w: WaterContext): ReadMap[] => OBJECT_KINDS.map((d) => readability(w, d));

/** Seconds to travel a distance with the machine's trapezoidal profile. */
export function travelSeconds(cm: number, speedScale: number): number {
  const v = GANTRY.maxSpeed * speedScale;
  const a = GANTRY.accel;
  return cm <= (v * v) / a ? 2 * Math.sqrt(cm / a) : cm / v + v / a;
}

function nearestGrid(x: number, y: number): number {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < GRID.length; i++) {
    const d = Math.hypot(GRID[i][0] - x, GRID[i][1] - y);
    if (d < bd) [bd, bi] = [d, i];
  }
  return bi;
}

export const dot = (w: NavWeights, phi: number[]) => {
  let s = 0;
  for (let i = 0; i < phi.length; i++) s += phi[i] * w[i];
  return s;
};

export interface NavAction extends Viewpoint {
  phi: number[];
  timeS: number;
  cell: number;
  /** object re-centred on, if any */
  objectId: string | null;
}

/** What the policy remembers during one scan. */
export class NavState {
  private best: Float32Array[] = OBJECT_KINDS.map(() => new Float32Array(CELLS.length));
  private visited = new Set<string>();
  count = 0;
  constructor(
    readonly water: WaterContext,
    private readonly maps = readMaps(water),
  ) {}

  actions(x: number, y: number, seen: ReadonlyMap<string, Detection>): NavAction[] {
    const out: NavAction[] = [];
    const add = (vx: number, vy: number, cell: number, d: Detection | null) => {
      const gains: number[] = [];
      let top = 0;
      for (let k = 0; k < this.maps.length; k++) {
        const m = this.maps[k][cell];
        const b = this.best[k];
        let g = 0;
        for (let c = 0; c < m.length; c++) if (m[c] > b[c]) g += m[c] - b[c];
        gains.push(g / 10);
        top = Math.max(top, g);
      }
      if (!d && top < 0.05) return;
      const unsure = d !== null && (d.class === "UNKNOWN" || d.confidence < DETECTION.classifyThreshold + 0.05);
      out.push({
        x: vx,
        y: vy,
        reason: d ? `re-centre ${d.objectId} (${(d.confidence * 100).toFixed(0)}%)` : `${top.toFixed(1)} cells newly readable`,
        phi: [1, ...gains, unsure ? 1 : 0, d && !unsure ? 1 : 0],
        timeS: travelSeconds(Math.hypot(vx - x, vy - y), this.water.gantrySpeed) + TEST.dwellSeconds,
        cell,
        objectId: d?.objectId ?? null,
      });
    };
    for (let i = 0; i < GRID.length; i++) if (Math.hypot(GRID[i][0] - x, GRID[i][1] - y) >= 1) add(GRID[i][0], GRID[i][1], i, null);
    for (const d of seen.values()) if (!this.visited.has(d.objectId) && d.confidence < 0.8) add(d.estX, d.estY, nearestGrid(d.estX, d.estY), d);
    return out;
  }

  visit(a: NavAction): void {
    this.maps.forEach((m, k) => {
      const b = this.best[k];
      for (let c = 0; c < b.length; c++) if (m[a.cell][c] > b[c]) b[c] = m[a.cell][c];
    });
    if (a.objectId) this.visited.add(a.objectId);
    this.count++;
  }

  private fork(): NavState {
    const n = new NavState(this.water, this.maps);
    n.best = this.best.map((b) => b.slice());
    n.visited = new Set(this.visited);
    n.count = this.count;
    return n;
  }

  /** Beam search over the next viewpoints with the learned reward; null = STOP (no plan is worth its time). */
  plan(w: NavWeights, x: number, y: number, seen: ReadonlyMap<string, Detection>): { action: NavAction | null; value: number } {
    interface Node {
      first: NavAction | null;
      state: NavState;
      x: number;
      y: number;
      value: number;
    }
    let best: { action: NavAction | null; value: number } = { action: null, value: 0 };
    let beam: Node[] = [{ first: null, state: this, x, y, value: 0 }];
    for (let depth = 0; depth < PLAN_DEPTH; depth++) {
      const next: { parent: Node; a: NavAction; value: number }[] = [];
      for (const p of beam) {
        if (p.state.count >= MAX_VIEWPOINTS) continue;
        for (const a of p.state.actions(p.x, p.y, seen)) next.push({ parent: p, a, value: p.value + dot(w, a.phi) - PLAN_TIME_COST * a.timeS });
      }
      if (!next.length) break;
      next.sort((a, b) => b.value - a.value);
      // keep plans that end somewhere different, or the beam fills with near copies of one plan
      const kept: typeof next = [];
      for (const n of next) {
        if (kept.length >= BEAM_WIDTH) break;
        if (!kept.some((k) => k.parent === n.parent && Math.hypot(k.a.x - n.a.x, k.a.y - n.a.y) < 8)) kept.push(n);
      }
      if (kept[0].value > best.value + 1e-9) best = { action: kept[0].parent.first ?? kept[0].a, value: kept[0].value };
      beam = kept.map(({ parent, a, value }) => {
        const state = parent.state.fork();
        state.visit(a);
        return { first: parent.first ?? a, state, x: a.x, y: a.y, value };
      });
    }
    return best;
  }

  /** Share of the floor seen well enough to find a typical object. */
  readableFraction(): number {
    let s = 0;
    for (const v of this.best[0]) s += v;
    return s / this.best[0].length;
  }
}

/** The trained policy behind the ScanPlanner interface the lab's test runner already uses. */
export class LearnedPlanner implements ScanPlanner {
  readonly id = "learned" as const;
  readonly total = null;
  private state: NavState;
  constructor(
    private readonly w: NavWeights,
    water: WaterContext,
  ) {
    this.state = new NavState(water);
  }
  next(obs: PlannerObservation): Viewpoint | null {
    if (this.state.count >= MAX_VIEWPOINTS) return null;
    const { action } = this.state.plan(this.w, obs.x, obs.y, obs.seen);
    if (!action) return null;
    this.state.visit(action);
    return { x: action.x, y: action.y, reason: action.reason };
  }
}

/* ---------- training ---------- */

/** A random layout in a random water the wreck can still be found in. */
export function randomScenario(seed: number): Scenario {
  const rand = mulberry32(seed);
  const s = defaultScenario();
  s.environment = ENVIRONMENT_IDS[Math.floor(rand() * ENVIRONMENT_IDS.length)];
  s.turbidity = clamp(ENVIRONMENTS[s.environment].defaults.turbidity * (0.4 + 1.2 * rand()), 0, 1);
  s.lighting = 0.45 + 0.5 * rand();
  s.seed = Math.floor(rand() * 2 ** 31);
  const placed: [number, number][] = [];
  for (const o of s.objects) {
    let x = 0;
    let y = 0;
    for (let k = 0; k < 40; k++) {
      x = 6 + rand() * (GANTRY.travelX - 12);
      y = 4 + rand() * (GANTRY.travelY - 8);
      if (placed.every(([px, py]) => Math.hypot(px - x, py - y) > 14)) break;
    }
    placed.push([x, y]);
    o.x = Math.round(x * 10) / 10;
    o.y = Math.round(y * 10) / 10;
    o.rotation = Math.floor(rand() * 180) - 90;
  }
  return s;
}

const labelValue = (d: Detection) => 0.5 + (d.correct ? 1 : d.class === "UNKNOWN" ? 0 : -0.5);
const total = (seen: ReadonlyMap<string, Detection>) => [...seen.values()].reduce((s, d) => s + labelValue(d), 0);

export interface EpisodeResult {
  reward: number;
  found: number;
  correct: number;
  timeS: number;
  viewpoints: number;
}

/**
 * One scan in the fast environment: the detector at each viewpoint, analytic travel time. `choose` picks the action
 * (null stops); `learn` receives each transition's features and discovery reward.
 */
export function runEpisode(scenario: Scenario, choose: (state: NavState, x: number, y: number, seen: ReadonlyMap<string, Detection>) => NavAction | null, learn?: (phi: number[], discovery: number) => void): EpisodeResult {
  const state = new NavState(scenario);
  const seen = new Map<string, Detection>();
  let x = 0;
  let y = 0;
  let time = 0;
  while (state.count < MAX_VIEWPOINTS) {
    const a = choose(state, x, y, seen);
    if (!a) break;
    const before = total(seen);
    x = a.x;
    y = a.y;
    time += a.timeS;
    state.visit(a);
    // the detector runs at 10 Hz through the dwell; four passes carry its jitter and hysteresis
    let previous = new Map<string, Detection>();
    for (let k = 0; k < 4; k++) {
      const { detections } = runDetection({ gantryX: x, gantryY: y, scenario, time: time - TEST.dwellSeconds * (1 - k / 4), previous, dt: TEST.dwellSeconds / 4 });
      previous = new Map(detections.map((d) => [d.objectId, d]));
      for (const d of detections) {
        const prev = seen.get(d.objectId);
        if (!prev || d.confidence > prev.confidence) seen.set(d.objectId, d);
      }
    }
    learn?.(a.phi, total(seen) - before);
  }
  const ds = [...seen.values()];
  return { reward: total(seen) - TIME_COST * time, found: ds.length, correct: ds.filter((d) => d.correct).length, timeS: time, viewpoints: state.count };
}

export interface TrainOptions {
  episodes: number;
  seed: number;
}

/**
 * Learns the discovery reward from explored episodes: epsilon-greedy on the one-step value, epsilon 1 to 0.1.
 * `step(n)` runs n more episodes, so a browser can train in slices and draw the curve.
 */
export class NavTrainer {
  weights: NavWeights = FEATURES.map(() => 0);
  episode = 0;
  readonly curve: EpisodeResult[] = [];
  private readonly rand: () => number;
  constructor(readonly opts: TrainOptions) {
    this.rand = mulberry32(opts.seed);
  }
  get done(): boolean {
    return this.episode >= this.opts.episodes;
  }
  step(n: number): void {
    for (let k = 0; k < n && !this.done; k++) {
      const p = this.episode / Math.max(1, this.opts.episodes - 1);
      const eps = 1 - 0.9 * p;
      const lr = 0.02 * (1 - 0.9 * p);
      const w = this.weights;
      const value = (a: NavAction) => dot(w, a.phi) - TIME_COST * a.timeS;
      const choose = (state: NavState, x: number, y: number, seen: ReadonlyMap<string, Detection>) => {
        const acts = state.actions(x, y, seen);
        if (!acts.length) return null;
        if (this.rand() < eps) return this.rand() < 0.15 ? null : acts[Math.floor(this.rand() * acts.length)];
        const top = acts.reduce((b, a) => (value(a) > value(b) ? a : b));
        return value(top) > 0 ? top : null;
      };
      this.curve.push(
        runEpisode(randomScenario(this.opts.seed * 100003 + this.episode + 1), choose, (phi, r) => {
          const err = clamp(r - dot(w, phi), -3, 3);
          for (let i = 0; i < w.length; i++) w[i] += lr * err * phi[i];
        }),
      );
      this.episode++;
    }
  }
}
