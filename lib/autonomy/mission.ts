// The joint demonstration: one gantry survey through changing water, with learned navigation choosing where the camera
// looks and learned switching choosing which model looks. Simulated and seeded. Geometry comes from the lab's detector
// (view angle, burial, frame), the water and light from the selected model's benchmark cell, so a model is exactly as
// good here as its benchmark says. docs/AUTONOMY.md section 4.

import { DETECTION } from "../sim/constants";
import { runDetection } from "../sim/detection";
import { mulberry32 } from "../sim/rng";
import { defaultScenario } from "../sim/scenario";
import type { Detection, Scenario } from "../sim/types";
import { LIGHTING, TURBIDITY, lightingBucket, turbidityBucket } from "../bench/profile";
import { NavState, randomScenario } from "./nav";
import { NAV_WEIGHTS } from "./nav-weights";
import { Debounce, L, type Policy, type SwitchWorld } from "./switching";

export interface Leg {
  name: string;
  turbidity: number;
  lighting: number;
}

/** Waters a survey meets in sequence. */
export const LEGS: Leg[] = [
  { name: "Clear, bright", turbidity: 0.05, lighting: 0.85 },
  { name: "Silt plume", turbidity: 0.65, lighting: 0.8 },
  { name: "Dusk", turbidity: 0.15, lighting: 0.22 },
  { name: "Silt at dusk", turbidity: 0.65, lighting: 0.4 },
];

export interface MissionStep {
  leg: number;
  t: number;
  x: number;
  y: number;
  reason: string;
  turbidity: string;
  lighting: string;
  model: number;
  switched: boolean;
  /** detections at this viewpoint */
  seen: { id: string; cls: string; conf: number; x: number; y: number; fresh: boolean }[];
  falseAlarms: number;
  foundInLeg: number;
}

export interface MissionRun {
  name: string;
  steps: MissionStep[];
  found: number;
  possible: number;
  falseAlarms: number;
  switches: number;
  timeS: number;
  scenarios: Scenario[];
}

/** Share of a perfect view the gantry pose gives each object: the lab detector in clear, bright water. */
function views(scenario: Scenario, x: number, y: number, time: number): Detection[] {
  return runDetection({ gantryX: x, gantryY: y, scenario: { ...scenario, environment: "tank", turbidity: 0, lighting: 1, threshold: 0.3 }, time, previous: new Map(), dt: 0.1 }).detections;
}

const VIEW_FULL = 0.8;

export function runMission(name: string, world: SwitchWorld, policy: Policy, seed: number, startModel = 0): MissionRun {
  const steps: MissionStep[] = [];
  const scenarios: Scenario[] = [];
  let found = 0;
  let falseAlarms = 0;
  let switches = 0;
  let time = 0;
  let loaded = startModel;
  let x = 0;
  let y = 0;
  LEGS.forEach((leg, li) => {
    const layout = randomScenario(seed * 131 + li);
    const scenario: Scenario = { ...defaultScenario(), objects: layout.objects, seed: layout.seed, environment: "tank", turbidity: leg.turbidity, lighting: leg.lighting };
    scenarios.push(scenario);
    const noise = mulberry32(seed * 977 + li);
    // the same dice for every policy, so differences come from the choices. An object's difficulty is one draw per leg:
    // looking again only helps through a better view or a better model, never through luck.
    const dice = mulberry32(seed * 7919 + li);
    const difficulty = new Map(scenario.objects.map((o) => [o.id, dice()]));
    // the models read through murkier water than the lab's analytic detector, so the planner's water is capped at the
    // edge of that detector's envelope: it plans closer views there instead of refusing to scan
    const state = new NavState({ ...scenario, turbidity: Math.min(leg.turbidity, 0.42), lighting: Math.max(leg.lighting, 0.4), threshold: 0.35 });
    const seen = new Map<string, Detection>();
    let sensor: Debounce | null = null;
    const ctx = turbidityBucket(leg.turbidity) * L + lightingBucket(leg.lighting);
    for (;;) {
      const { action } = state.plan(NAV_WEIGHTS, x, y, seen);
      if (!action) break;
      state.visit(action);
      x = action.x;
      y = action.y;
      time += action.timeS;
      // three readings during the dwell, debounced
      sensor ??= new Debounce(world.sense(ctx, noise));
      for (let k = 0; k < 3; k++) sensor.read(world.sense(ctx, noise));
      const model = policy(sensor.value, loaded, noise);
      const switched = model !== loaded;
      if (switched) switches++;
      loaded = model;
      const got = new Map<string, MissionStep["seen"][number]>();
      let fa = 0;
      for (const v of views(scenario, x, y, time)) {
        const p = world.r[model][ctx] * Math.min(1, v.confidence / VIEW_FULL);
        if (dice() < Math.min(1, world.fp[model][ctx])) fa++;
        if (difficulty.get(v.objectId)! >= p) continue;
        const conf = Math.min(0.98, 0.35 + 0.6 * p);
        const fresh = !seen.has(v.objectId);
        const correct = conf >= DETECTION.classifyThreshold;
        const d: Detection = { ...v, confidence: conf, class: correct ? v.trueType : "UNKNOWN", correct };
        if (fresh || conf > seen.get(v.objectId)!.confidence) seen.set(v.objectId, d);
        got.set(v.objectId, { id: v.objectId, cls: d.class, conf, x: v.estX, y: v.estY, fresh });
      }
      falseAlarms += fa;
      steps.push({ leg: li, t: time, x, y, reason: action.reason, turbidity: TURBIDITY[turbidityBucket(leg.turbidity)], lighting: LIGHTING[lightingBucket(leg.lighting)], model, switched, seen: [...got.values()], falseAlarms: fa, foundInLeg: seen.size });
    }
    found += seen.size;
  });
  return { name, steps, found, possible: scenarios.reduce((s, sc) => s + sc.objects.length, 0), falseAlarms, switches, timeS: time, scenarios };
}

export interface MissionScore {
  name: string;
  found: number;
  possible: number;
  falseAlarms: number;
  timeS: number;
  switches: number;
}

/** Mean over `n` seeded missions: learned switching against each model flown alone, learned navigation in both. */
export function scoreMissions(world: SwitchWorld, learned: Policy, n = 12, base = 4000): MissionScore[] {
  const entries: { name: string; policy: Policy; start: number }[] = [{ name: "Learned switching", policy: learned, start: 0 }, ...world.models.map((m, i) => ({ name: `Always ${m.name}`, policy: (() => i) as Policy, start: i }))];
  return entries.map((e) => {
    const s = { name: e.name, found: 0, possible: 0, falseAlarms: 0, timeS: 0, switches: 0 };
    for (let k = 0; k < n; k++) {
      const r = runMission(e.name, world, e.policy, base + k, e.start);
      s.found += r.found / n;
      s.possible += r.possible / n;
      s.falseAlarms += r.falseAlarms / n;
      s.timeS += r.timeS / n;
      s.switches += r.switches / n;
    }
    return s;
  });
}
