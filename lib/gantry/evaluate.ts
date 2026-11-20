// Repeatable comparison of inspection strategies on one scenario. Headless: each strategy runs in a fresh SimEngine
// with an identical copy of the scenario and seed, so differences come only from where the camera was sent.

import { SimEngine } from "../sim/engine";
import type { Scenario, TestResult } from "../sim/types";
import { STRATEGY_IDS, type StrategyId } from "./strategies";

export interface StrategyRow {
  strategy: StrategyId;
  result: TestResult;
  /** objects detected over objects in the scene */
  acquisitionRate: number;
  /** covered fraction per metre of carriage travel */
  efficiency: number;
}

/** Runs one strategy to completion on a copy of the scenario. */
export function evaluateStrategy(scenario: Scenario, strategy: StrategyId): StrategyRow {
  const e = new SimEngine();
  const { objects, ...rest } = scenario;
  e.setScenario({ ...rest, strategy });
  for (const o of objects) e.moveObject(o.id, o.x, o.y);
  e.runTest();
  for (let i = 0; i < 120 * 900 && e.phase !== "COMPLETE"; i++) e.tick(1 / 120);
  const r = e.result!;
  return {
    strategy,
    result: r,
    acquisitionRate: r.objectsDetected / Math.max(1, objects.length),
    efficiency: r.pathCm > 0 ? r.coverage / (r.pathCm / 100) : 0,
  };
}

/** Runs every strategy, yielding to the event loop between them so a browser stays responsive. */
export async function compareStrategies(scenario: Scenario, ids: StrategyId[] = STRATEGY_IDS.filter((s) => s !== "waypoints" || scenario.waypoints.length > 0), onRow?: (row: StrategyRow) => void): Promise<StrategyRow[]> {
  const rows: StrategyRow[] = [];
  for (const id of ids) {
    await new Promise((r) => setTimeout(r, 0));
    const row = evaluateStrategy(scenario, id);
    rows.push(row);
    onRow?.(row);
  }
  return rows;
}
