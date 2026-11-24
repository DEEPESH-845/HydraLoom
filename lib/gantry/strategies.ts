// Inspection strategies for the gantry test runner: where the camera goes next during the SCAN phase.
// Every strategy here is a hand-written heuristic. None is a trained policy; a trained policy would implement the same
// ScanPlanner interface on the same observation (docs/ARCHITECTURE.md section 6).
//
// The test runner (lib/sim/engine.ts) asks the planner for the next viewpoint each time the carriage has arrived and
// dwelt; null ends the scan. Planners see only what the rig could know: the carriage position, the detections reported
// so far (with their ESTIMATED positions, never ground truth) and which floor cells the camera has imaged.

import { CAMERA, DETECTION, GANTRY, TEST, clamp } from "../sim/constants";
import type { Detection } from "../sim/types";

export type StrategyId = "serpentine" | "coverage" | "detection-driven" | "uncertainty" | "waypoints";

export interface StrategyInfo {
  id: StrategyId;
  name: string;
  summary: string;
  kind: "fixed" | "reactive" | "active-perception";
}

export const STRATEGIES: Record<StrategyId, StrategyInfo> = {
  serpentine: { id: "serpentine", name: "Serpentine (baseline)", summary: "Six fixed waypoints in two rows: the original test plan.", kind: "fixed" },
  coverage: { id: "coverage", name: "Coverage scan", summary: "Boustrophedon spaced from the detection-grade centre of the camera footprint, so every floor cell is imaged.", kind: "fixed" },
  "detection-driven": { id: "detection-driven", name: "Detection-driven", summary: "Serpentine, plus a re-centring visit to every detection reported below the classify threshold.", kind: "reactive" },
  uncertainty: { id: "uncertainty", name: "Uncertainty-driven", summary: "Greedy next-best-view: unimaged cells and low-confidence detections, traded against travel time.", kind: "active-perception" },
  waypoints: { id: "waypoints", name: "User waypoints", summary: "Visits a user-supplied list of gantry positions in order.", kind: "fixed" },
};

export const STRATEGY_IDS = Object.keys(STRATEGIES) as StrategyId[];
export const isStrategyId = (v: unknown): v is StrategyId => typeof v === "string" && (STRATEGY_IDS as string[]).includes(v);

export interface PlannerObservation {
  x: number;
  y: number;
  /** best detection per object so far, from the detector (estimated positions) */
  seen: ReadonlyMap<string, Detection>;
  /** floor cells imaged in the detection-grade frame centre, index c * rows + r of TEST.coverageGrid */
  covered: ReadonlySet<number>;
  /** seconds since the scan began */
  time: number;
}

export interface Viewpoint {
  x: number;
  y: number;
  /** why the planner chose it, for the event log */
  reason: string;
}

export interface ScanPlanner {
  readonly id: StrategyId;
  /** total number of viewpoints when the plan is fixed, else null */
  readonly total: number | null;
  next(obs: PlannerObservation): Viewpoint | null;
}

/** Half extents of the detection-grade frame centre on the floor, cm (the coverage rule of the engine). */
export function gradeFootprint(): { halfW: number; halfH: number } {
  const tanH = Math.tan((CAMERA.hfovDeg * Math.PI) / 360);
  const rMax = Math.sqrt((1 - TEST.coverageCenteringMin) / DETECTION.centeringWeight);
  const halfW = CAMERA.lensHeight * tanH * rMax * 100;
  return { halfW, halfH: halfW / CAMERA.aspect };
}

/** Cells whose centre lies in the grade footprint of a camera at (x, y). Mirrors SimEngine.recordCoverage. */
export function cellsSeenFrom(x: number, y: number): number[] {
  const [cols, rows] = TEST.coverageGrid;
  const { halfW, halfH } = gradeFootprint();
  const out: number[] = [];
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const cx = ((c + 0.5) / cols) * GANTRY.travelX;
      const cy = ((r + 0.5) / rows) * GANTRY.travelY;
      if (Math.abs(cx - x) <= halfW && Math.abs(cy - y) <= halfH) out.push(c * rows + r);
    }
  return out;
}

class ListPlanner implements ScanPlanner {
  private i = 0;
  readonly total: number;
  constructor(
    readonly id: StrategyId,
    private readonly pts: readonly (readonly [number, number])[],
    private readonly reason: string,
  ) {
    this.total = pts.length;
  }
  next(): Viewpoint | null {
    if (this.i >= this.pts.length) return null;
    const [x, y] = this.pts[this.i++];
    return { x, y, reason: this.reason };
  }
}

/** Rows and columns spaced so the grade footprints tile the whole travel area. */
export function coveragePlan(): [number, number][] {
  const { halfW, halfH } = gradeFootprint();
  const nx = Math.ceil(GANTRY.travelX / (2 * halfW));
  const ny = Math.ceil(GANTRY.travelY / (2 * halfH));
  const xs = Array.from({ length: nx }, (_, i) => clamp(((i + 0.5) * GANTRY.travelX) / nx, 0, GANTRY.travelX));
  const ys = Array.from({ length: ny }, (_, j) => clamp(((j + 0.5) * GANTRY.travelY) / ny, 0, GANTRY.travelY));
  const out: [number, number][] = [];
  ys.forEach((y, j) => (j % 2 === 0 ? xs : [...xs].reverse()).forEach((x) => out.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10])));
  return out;
}

/** Serpentine, plus one re-centring visit to each object first reported below the classify threshold. */
class DetectionDrivenPlanner implements ScanPlanner {
  readonly id = "detection-driven" as const;
  readonly total = null;
  private base = 0;
  private revisited = new Set<string>();
  next(obs: PlannerObservation): Viewpoint | null {
    // the weakest unconfirmed detection that is not already centred gets a visit before the plan continues
    let pick: Detection | null = null;
    for (const d of obs.seen.values()) {
      if (this.revisited.has(d.objectId)) continue;
      if (d.confidence >= DETECTION.classifyThreshold + 0.05) continue;
      if (Math.hypot(d.estX - obs.x, d.estY - obs.y) < 3) continue;
      if (!pick || d.confidence < pick.confidence) pick = d;
    }
    if (pick) {
      this.revisited.add(pick.objectId);
      return { x: pick.estX, y: pick.estY, reason: `re-centre ${pick.objectId} (${(pick.confidence * 100).toFixed(0)}%)` };
    }
    if (this.base >= TEST.scanWaypoints.length) return null;
    const [x, y] = TEST.scanWaypoints[this.base++];
    return { x, y, reason: "plan" };
  }
}

/**
 * Greedy next-best-view. Gain of a candidate viewpoint = unimaged grade cells it would image, plus, for every
 * detection whose estimate lies in its grade footprint, how far that detection is below 0.8 confidence (centring
 * raises confidence through the geometry term). Cost = travel time at full speed. Stops when nothing is left to gain
 * or the viewpoint budget is spent.
 */
class UncertaintyPlanner implements ScanPlanner {
  readonly id = "uncertainty" as const;
  readonly total = null;
  private count = 0;
  private visitedObj = new Set<string>();
  next(obs: PlannerObservation): Viewpoint | null {
    if (this.count >= 14) return null;
    const { halfW, halfH } = gradeFootprint();
    let best: Viewpoint | null = null;
    let bestScore = 0;
    for (let x = 5; x <= GANTRY.travelX - 5 + 1e-9; x += 5)
      for (let y = 5; y <= GANTRY.travelY - 5 + 1e-9; y += 5) {
        let gain = 0;
        for (const c of cellsSeenFrom(x, y)) if (!obs.covered.has(c)) gain += 1;
        let why = gain > 0 ? `${gain} new cells` : "";
        for (const d of obs.seen.values()) {
          if (this.visitedObj.has(d.objectId)) continue;
          if (Math.abs(d.estX - x) <= halfW && Math.abs(d.estY - y) <= halfH && d.confidence < 0.8) {
            const g = (0.8 - d.confidence) * 25;
            gain += g;
            why = `${why ? why + ", " : ""}refine ${d.objectId}`;
          }
        }
        const travel = Math.hypot(x - obs.x, y - obs.y) / GANTRY.maxSpeed; // s at full speed
        const score = gain / (1 + 0.35 * travel);
        if (score > bestScore + 1e-9) {
          bestScore = score;
          best = { x, y, reason: why };
        }
      }
    if (!best || bestScore < 0.5) return null;
    this.count++;
    for (const d of obs.seen.values()) if (Math.abs(d.estX - best.x) <= halfW && Math.abs(d.estY - best.y) <= halfH) this.visitedObj.add(d.objectId);
    return best;
  }
}

/**
 * The viewpoints a strategy will visit, known before the scan starts, for display. Detection-driven adds re-centring
 * visits to its serpentine base as detections arrive; uncertainty-driven plans every step live, so it has none.
 */
export function plannedViewpoints(id: StrategyId, waypoints?: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  switch (id) {
    case "coverage":
      return coveragePlan();
    case "uncertainty":
      return [];
    case "waypoints":
      return (waypoints?.length ? waypoints : TEST.scanWaypoints).map(([x, y]) => [clamp(x, 0, GANTRY.travelX), clamp(y, 0, GANTRY.travelY)] as const);
    case "serpentine":
    case "detection-driven":
    default:
      return [...TEST.scanWaypoints];
  }
}

export function createPlanner(id: StrategyId, waypoints?: readonly (readonly [number, number])[]): ScanPlanner {
  switch (id) {
    case "coverage":
      return new ListPlanner("coverage", coveragePlan(), "coverage");
    case "detection-driven":
      return new DetectionDrivenPlanner();
    case "uncertainty":
      return new UncertaintyPlanner();
    case "waypoints":
      return new ListPlanner("waypoints", (waypoints?.length ? waypoints : TEST.scanWaypoints).map(([x, y]) => [clamp(x, 0, GANTRY.travelX), clamp(y, 0, GANTRY.travelY)] as const), "user");
    case "serpentine":
    default:
      return new ListPlanner("serpentine", TEST.scanWaypoints, "plan");
  }
}
