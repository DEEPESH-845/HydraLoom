import type { SceneId } from "./store";
import type { SimEngine } from "./engine";

/**
 * Autonomous demo director. Called every frame with the demo clock.
 * Phases advance on real engine state (detections, target chosen, episode done),
 * with minimum durations so the narration is readable. Roughly 70 seconds.
 */

export type DemoPhaseId =
  | "OVERVIEW"
  | "SCAN"
  | "DETECT"
  | "COORDINATES"
  | "POLICY"
  | "MOVE"
  | "TRACKED"
  | "RESULT";

export interface DemoPhase {
  id: DemoPhaseId;
  title: string;
  caption: string;
  scene: SceneId;
  minSeconds: number;
  /**
   * Wall-clock fallback for phases gated on engine state. If the gate never opens (engine stopped
   * by the user, a scenario that detects nothing, an episode capped at 40 steps) the phase still
   * ends here, so RESULT is reached within 10 + 30 + 90 + 4 + 20 + 20 + 90 = 264 s of any demo start.
   * Bounds sit above the slowest legitimate run (gantrySpeed 0.2: DETECT 75 s) so they never cut a real scan.
   */
  maxSeconds?: number;
}

export const DEMO_PHASES: DemoPhase[] = [
  { id: "OVERVIEW", title: "System overview", caption: "An aquarium, an XY gantry, a downward camera, and printed test objects on sand.", scene: 1, minSeconds: 10 },
  { id: "SCAN", title: "Gantry scans", caption: "The carriage drives home, then visits six waypoints. The camera footprint sweeps the floor.", scene: 4, minSeconds: 8, maxSeconds: 30 },
  { id: "DETECT", title: "Camera detects", caption: "Each frame is classified. Confidence depends on distance, centring, turbidity and light.", scene: 3, minSeconds: 10, maxSeconds: 90 },
  { id: "COORDINATES", title: "Coordinates extracted", caption: "The best detection becomes the target: its box centre is back-projected onto the floor as a gantry coordinate.", scene: 4, minSeconds: 4 },
  { id: "POLICY", title: "Controller selects action", caption: "State in, action out: MOVE_X+, MOVE_X-, MOVE_Y+, MOVE_Y-, or HOLD. Reward for closing distance.", scene: 5, minSeconds: 5, maxSeconds: 20 },
  { id: "MOVE", title: "Gantry moves", caption: "The Arduino steps the motors. The carriage stays on its rails, accelerates, decelerates.", scene: 4, minSeconds: 6, maxSeconds: 20 },
  { id: "TRACKED", title: "Target tracked", caption: "The object is centred in the feed. Confidence rises. The controller holds.", scene: 3, minSeconds: 6, maxSeconds: 90 },
  { id: "RESULT", title: "Test result", caption: "Same seed, same scenario, same result. Repeat it as many times as you need.", scene: 7, minSeconds: 12 },
];

export interface DemoDirectorState {
  phaseIndex: number;
  phaseStart: number;
  testStarted: boolean;
}

export function createDemoDirector(): DemoDirectorState {
  return { phaseIndex: 0, phaseStart: 0, testStarted: false };
}

/** Advance the director. Returns the phase index to display. */
export function stepDemo(d: DemoDirectorState, t: number, engine: SimEngine): number {
  const phase = DEMO_PHASES[d.phaseIndex];
  const elapsed = t - d.phaseStart;
  const next = () => {
    d.phaseIndex = Math.min(d.phaseIndex + 1, DEMO_PHASES.length - 1);
    d.phaseStart = t;
  };

  if (phase.maxSeconds !== undefined && elapsed >= phase.maxSeconds) {
    next();
    return d.phaseIndex;
  }

  const rl = engine.rl;
  switch (phase.id) {
    case "OVERVIEW":
      if (elapsed >= phase.minSeconds) {
        engine.runTest();
        d.testStarted = true;
        next();
      }
      break;
    case "SCAN":
      if (elapsed >= phase.minSeconds && engine.detections.length > 0) next();
      break;
    case "DETECT":
      // Hold the feed until the scan is over and a target has been chosen.
      if (elapsed >= phase.minSeconds && engine.phase !== "SCANNING" && engine.phase !== "DETECTING") next();
      break;
    case "COORDINATES":
      if (elapsed >= phase.minSeconds || engine.phase === "COMPLETE") next();
      break;
    case "POLICY":
      if ((elapsed >= phase.minSeconds && rl.step >= 2) || rl.done) next();
      break;
    case "MOVE":
      if ((elapsed >= phase.minSeconds && rl.step >= 5) || rl.done) next();
      break;
    case "TRACKED":
      if (elapsed >= phase.minSeconds && engine.phase === "COMPLETE") next();
      break;
    case "RESULT":
      break;
  }
  return d.phaseIndex;
}
