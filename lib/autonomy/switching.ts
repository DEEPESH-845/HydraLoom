// Automatic model switching as reinforcement learning: tabular Q-learning on after-states, deterministic for a seed.
// Q(context, loaded, a) = W(context, a) - switchCost * [a != loaded]. The load time is known, so only W is learned: the
// value of having model a running in a context, including what it will be worth as the water drifts.
//
//   state   sensed turbidity bucket (4) x lighting bucket (3) x model now loaded
//   action  which model processes the next frame (staying is free, switching costs its load time)
//   reward  frame score (true positives - 0.5 false positives) / objects, sampled from each model's benchmark cells,
//           minus a latency cost, minus the switch cost
//   water   drifts: the buckets random-walk as a survey crosses conditions, and the sensor misreads them sometimes
//
// The learner never sees the benchmark table, only the sampled rewards. Judged on held-out water sequences against every
// fixed model, random switching, and an oracle that knows the table.

import { mulberry32 } from "../sim/rng";
import { LIGHTING, MIN_SUPPORT, TURBIDITY, precision, recall, type Counts, type ModelProfile } from "../bench/profile";

export const T = TURBIDITY.length;
export const L = LIGHTING.length;
const CTX = T * L;
const GAMMA = 0.9;
const ORACLE_GAMMA = 0.995;

export interface SwitchConfig {
  /** score lost for a frame while the new model loads */
  switchCost: number;
  /** score lost per frame per multiple of the latency budget beyond one */
  latencyWeight: number;
  latencyBudgetMs: number;
  /** chance per frame that turbidity or lighting moves one bucket */
  drift: number;
  /** chance the sensed bucket is off by one */
  sensorError: number;
  seed: number;
}

export const DEFAULT_SWITCH: SwitchConfig = { switchCost: 0.25, latencyWeight: 0.05, latencyBudgetMs: 300, drift: 0.02, sensorError: 0.05, seed: 7 };

/** A roster is trainable when every model has measured turbidity x lighting cells. */
export const trainable = (ps: ModelProfile[]) => ps.length >= 2 && ps.every((p) => p.cells !== null);

const OBJECTS = 3;
/** Pulls thin cells toward the model's overall counts, so three lucky frames do not decide a policy. */
function smoothed(p: ModelProfile, c: Counts): { r: number; pr: number } {
  const r0 = recall(p.overall) ?? 0;
  const p0 = precision(p.overall) ?? 1;
  const k = MIN_SUPPORT;
  const fired = c.tp + c.fp;
  return { r: (c.tp + k * r0) / (c.nGt + k), pr: (c.tp + k * p0) / (fired + k) };
}

export class SwitchWorld {
  readonly models: ModelProfile[];
  /** recall, expected false positives per object and latency penalty, [model][ctx] */
  readonly r: number[][];
  readonly fp: number[][];
  readonly lat: number[];
  constructor(
    models: ModelProfile[],
    readonly cfg: SwitchConfig,
  ) {
    this.models = models;
    const s = models.map((m) => Array.from({ length: CTX }, (_, c) => smoothed(m, m.cells![Math.floor(c / L)][c % L])));
    this.r = s.map((row) => row.map((x) => x.r));
    this.fp = s.map((row) => row.map((x) => (x.pr > 0 ? (x.r * (1 - x.pr)) / x.pr : 1)));
    this.lat = models.map((m) => cfg.latencyWeight * Math.max(0, (m.latencyMs ?? 0) / cfg.latencyBudgetMs - 1));
  }
  /** Mean reward of running model a in true context c, from loaded model m. */
  expected(c: number, m: number, a: number): number {
    return this.r[a][c] - 0.5 * this.fp[a][c] - this.lat[a] - (a !== m ? this.cfg.switchCost : 0);
  }
  /** One frame's sampled reward. */
  sample(c: number, m: number, a: number, rand: () => number): number {
    let tp = 0;
    let fp = 0;
    for (let k = 0; k < OBJECTS; k++) {
      if (rand() < this.r[a][c]) tp++;
      if (rand() < Math.min(1, this.fp[a][c])) fp++;
    }
    return (tp - 0.5 * fp) / OBJECTS - this.lat[a] - (a !== m ? this.cfg.switchCost : 0);
  }
  /** Water drift: each bucket moves one step with probability `drift`. */
  step(c: number, rand: () => number): number {
    let t = Math.floor(c / L);
    let l = c % L;
    const move = (v: number, n: number) => (rand() < this.cfg.drift ? Math.min(n - 1, Math.max(0, v + (rand() < 0.5 ? -1 : 1))) : v);
    t = move(t, T);
    l = move(l, L);
    return t * L + l;
  }
  sense(c: number, rand: () => number): number {
    let t = Math.floor(c / L);
    let l = c % L;
    const miss = (v: number, n: number) => (rand() < this.cfg.sensorError ? Math.min(n - 1, Math.max(0, v + (rand() < 0.5 ? -1 : 1))) : v);
    t = miss(t, T);
    l = miss(l, L);
    return t * L + l;
  }
}

/** A context change is believed only when two readings in a row agree, so one misread never triggers a switch. */
export class Debounce {
  private raw: number;
  constructor(public value: number) {
    this.raw = value;
  }
  read(raw: number): number {
    if (raw === this.raw) this.value = raw;
    this.raw = raw;
    return this.value;
  }
}

export type Policy = (sensed: number, loaded: number, rand: () => number) => number;

export class SwitchLearner {
  /** W[ctx][action], learned */
  readonly w: number[][];
  readonly curve: { frame: number; reward: number }[] = [];
  frame = 0;
  private visits: number[][];
  private rand: () => number;
  private ctx: number;
  private sensed: number;
  private sensor: Debounce;
  private loaded = 0;
  private window = 0;
  constructor(
    readonly world: SwitchWorld,
    readonly frames = 60000,
  ) {
    const n = world.models.length;
    this.w = Array.from({ length: CTX }, () => Array<number>(n).fill(0));
    this.visits = Array.from({ length: CTX }, () => Array<number>(n).fill(0));
    this.rand = mulberry32(world.cfg.seed);
    this.ctx = Math.floor(this.rand() * CTX);
    this.sensed = world.sense(this.ctx, this.rand);
    this.sensor = new Debounce(this.sensed);
  }
  get done(): boolean {
    return this.frame >= this.frames;
  }
  q(c: number, m: number, a: number): number {
    return this.w[c][a] - (a !== m ? this.world.cfg.switchCost : 0);
  }
  step(n: number): void {
    const W = Math.max(1, Math.floor(this.frames / 60));
    for (let k = 0; k < n && !this.done; k++) {
      // a new survey every 400 frames, so training visits every water
      if (this.frame % 400 === 0) {
        this.ctx = Math.floor(this.rand() * CTX);
        this.sensed = this.world.sense(this.ctx, this.rand);
        this.sensor = new Debounce(this.sensed);
        this.loaded = Math.floor(this.rand() * this.world.models.length);
      }
      const eps = Math.max(0.1, 1 - this.frame / (0.8 * this.frames));
      const a = this.rand() < eps ? Math.floor(this.rand() * this.world.models.length) : this.policy(this.sensed, this.loaded, this.rand);
      const r = this.world.sample(this.ctx, this.loaded, a, this.rand);
      const own = r + (a !== this.loaded ? this.world.cfg.switchCost : 0);
      this.ctx = this.world.step(this.ctx, this.rand);
      const next = this.sensor.read(this.world.sense(this.ctx, this.rand));
      let best = -Infinity;
      for (let b = 0; b < this.world.models.length; b++) best = Math.max(best, this.q(next, a, b));
      const v = ++this.visits[this.sensed][a];
      this.w[this.sensed][a] += Math.max(0.005, 1 / (1 + v / 15)) * (own + GAMMA * best - this.w[this.sensed][a]);
      this.loaded = a;
      this.sensed = next;
      this.window += r;
      this.frame++;
      if (this.frame % W === 0) {
        this.curve.push({ frame: this.frame, reward: this.window / W });
        this.window = 0;
      }
    }
  }
  policy: Policy = (c, m) => {
    let best = m;
    for (let a = 0; a < this.world.models.length; a++) if (this.q(c, m, a) > this.q(c, m, best) + 1e-12) best = a;
    return best;
  };
  /** The model the policy wants in a context when switching is free: the winner map it has learned. */
  settled(c: number): number {
    return this.w[c].indexOf(Math.max(...this.w[c]));
  }
}

/** Optimal policy from the true table (value iteration on expected rewards, perfect sensing): the reference ceiling. */
export function oraclePolicy(w: SwitchWorld): Policy {
  const n = w.models.length;
  const d = w.cfg.drift;
  const moves = (v: number, size: number) => {
    const out: [number, number][] = [[v, 1 - d]];
    for (const s of [-1, 1]) out.push([Math.min(size - 1, Math.max(0, v + s)), d / 2]);
    return out;
  };
  let V = Array.from({ length: CTX }, () => Array<number>(n).fill(0));
  const Q = (c: number, m: number, a: number, next: number[]) => w.expected(c, m, a) + ORACLE_GAMMA * next[a];
  let ev: number[][] = [];
  // surveys are scored by their average, so the reference looks much further ahead than the learner has to
  for (let it = 0; it < 1200; it++) {
    ev = Array.from({ length: CTX }, (_, c) => Array.from({ length: n }, (_, a) => moves(Math.floor(c / L), T).reduce((s, [t, pt]) => s + moves(c % L, L).reduce((q, [l, pl]) => q + pt * pl * V[t * L + l][a], 0), 0)));
    V = V.map((row, c) => row.map((_, m) => Math.max(...row.map((_, a) => Q(c, m, a, ev[c])))));
  }
  return (c, m) => {
    let best = 0;
    for (let a = 1; a < n; a++) if (Q(c, m, a, ev[c]) > Q(c, m, best, ev[c])) best = a;
    return best;
  };
}

export interface Rollout {
  name: string;
  kind: "learned" | "fixed" | "random" | "oracle";
  reward: number;
  switches: number;
  /** objects found per object present */
  detectionRate: number;
}

/** Held-out surveys (seeds the learner never saw): mean reward per frame, identical water for every policy. */
export function evaluatePolicies(w: SwitchWorld, learner: SwitchLearner, surveys = 60, frames = 400): Rollout[] {
  const oracle = oraclePolicy(w);
  const entries: { name: string; kind: Rollout["kind"]; policy: Policy; perfect?: boolean; start: number }[] = [
    { name: "Learned switching", kind: "learned", policy: learner.policy, start: 0 },
    ...w.models.map((m, i) => ({ name: `Always ${m.name}`, kind: "fixed" as const, policy: () => i, start: i })),
    { name: "Random switching", kind: "random", policy: (_s: number, _m: number, rand: () => number) => Math.floor(rand() * w.models.length), start: 0 },
    { name: "Oracle (knows the table)", kind: "oracle", policy: oracle, perfect: true, start: 0 },
  ];
  return entries.map((e) => {
    let reward = 0;
    let switches = 0;
    let rate = 0;
    for (let s = 0; s < surveys; s++) {
      const water = mulberry32(900001 + s * 17 + w.cfg.seed * 1000003);
      const noise = mulberry32(700001 + s * 31 + w.cfg.seed * 1000003);
      const act = mulberry32(500001 + s);
      let c = Math.floor(water() * CTX);
      let loaded = e.start;
      const sensor = new Debounce(w.sense(c, noise));
      for (let f = 0; f < frames; f++) {
        const sensed = sensor.read(w.sense(c, noise));
        const a = e.policy(e.perfect ? c : sensed, loaded, act);
        // everyone starts with their first choice already loaded: the first load is not a switch
        if (f === 0) loaded = a;
        reward += w.expected(c, loaded, a);
        rate += w.r[a][c];
        if (a !== loaded) switches++;
        loaded = a;
        c = w.step(c, water);
      }
    }
    const n = surveys * frames;
    return { name: e.name, kind: e.kind, reward: reward / n, switches: switches / surveys, detectionRate: rate / n };
  });
}

/** The deployable artefact: what a Raspberry Pi needs to run the switch, nothing else. */
export function exportPolicy(learner: SwitchLearner) {
  const w = learner.world;
  return {
    schema: "gantrylab.switch-policy/1",
    models: w.models.map((m) => ({ id: m.id, name: m.name, source: m.source, latency_ms: m.latencyMs })),
    trained_on: w.models[0].source === "simulated" ? "SIMULATED roster - demonstration only, do not deploy" : "measured benchmark runs",
    buckets: { turbidity: TURBIDITY, turbidity_edges: [0.1, 0.3, 0.6], lighting: LIGHTING, lighting_edges: [0.3, 0.6] },
    config: w.cfg,
    frames: learner.frame,
    // policy[turbidity][lighting][loaded model index] = model index to run
    policy: TURBIDITY.map((_, t) => LIGHTING.map((_, l) => w.models.map((_, m) => learner.policy(t * L + l, m, () => 0)))),
  };
}
