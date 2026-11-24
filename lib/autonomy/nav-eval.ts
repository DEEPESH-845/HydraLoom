// Held-out evaluation of scan strategies in the real SimEngine (full motion, dwell, 10 Hz detector).

import { SimEngine } from "../sim/engine";
import type { EnvironmentId } from "../sim/environments";
import type { StrategyId } from "../gantry/strategies";
import { TIME_COST, randomScenario } from "./nav";

/** Layout seeds: training, validation (choices) and test (reported numbers) never overlap. */
export const VALIDATION_BASE = 5_000_000;
export const TEST_BASE = 9_000_000;

export interface NavScore {
  runs: number;
  found: number;
  correct: number;
  falsePositives: number;
  scanS: number;
  score: number;
}

/** Mean scores over `n` layouts starting at `base`, overall and per environment. */
export function scoreStrategy(strategy: StrategyId, base: number, n: number): Record<"all" | EnvironmentId, NavScore> {
  const acc = {} as Record<string, NavScore>;
  for (let i = 0; i < n; i++) {
    const s = randomScenario(base + i);
    const e = new SimEngine();
    const { objects, ...rest } = s;
    e.setScenario({ ...rest, strategy });
    e.scenario.objects = objects.map((o) => ({ ...o }));
    e.runTest();
    let scanS = 0;
    for (let k = 0; k < 120 * 600 && e.phase !== "COMPLETE" && e.phase !== "TRACKING"; k++) {
      e.tick(1 / 120);
      if (e.phase === "SCANNING" || e.phase === "DETECTING") scanS = e.time;
    }
    // the tracking episode after the scan is the same controller for every strategy: skip to the result
    for (let k = 0; k < 120 * 600 && e.phase !== "COMPLETE"; k++) e.tick(1 / 120);
    const r = e.result!;
    const score = 0.5 * r.objectsDetected + r.successfulDetections - 0.5 * r.falsePositives - TIME_COST * scanS;
    for (const key of ["all", s.environment]) {
      const a = (acc[key] ??= { runs: 0, found: 0, correct: 0, falsePositives: 0, scanS: 0, score: 0 });
      a.runs++;
      a.found += r.objectsDetected;
      a.correct += r.successfulDetections;
      a.falsePositives += r.falsePositives;
      a.scanS += scanS;
      a.score += score;
    }
  }
  for (const a of Object.values(acc)) for (const k of ["found", "correct", "falsePositives", "scanS", "score"] as const) a[k] /= a.runs;
  return acc as Record<"all" | EnvironmentId, NavScore>;
}
