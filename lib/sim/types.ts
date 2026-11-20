import type { EnvironmentId } from "./environments";
import type { StrategyId } from "../gantry/strategies";
export type ObjectType = "SHIPWRECK" | "MINE" | "DEBRIS";
export type DetectedClass = ObjectType | "UNKNOWN";

export interface TestObject {
  id: string;
  type: ObjectType;
  label: string;
  /** gantry cm */
  x: number;
  y: number;
  /** world metres, centre height above sand */
  z: number;
  /** world metres, half extents along world X, Y(up), Z */
  halfExtents: [number, number, number];
  /** yaw degrees around world Y */
  rotation: number;
  /** 0..1 base detectability of the printed model */
  detectability: number;
  /** 0..1 fraction buried in sand */
  burial: number;
  /** Deterministic false-positive path: reported class at low confidence */
  confusableAs?: DetectedClass;
}

export type DetectionState = "SCAN" | "DETECTED" | "LOCKED";

export interface Detection {
  objectId: string;
  trueType: ObjectType;
  class: DetectedClass;
  confidence: number;
  correct: boolean;
  /** normalised feed coords from top-left: u, v, w, h in 0..1 */
  bbox: [number, number, number, number];
  /** estimated gantry cm of the object, from the feed centre */
  estX: number;
  estY: number;
  /** metres from lens to object centre */
  distance: number;
  state: DetectionState;
  /** seconds continuously detected */
  age: number;
  timestamp: number;
}

export type Action = "MOVE_X+" | "MOVE_X-" | "MOVE_Y+" | "MOVE_Y-" | "HOLD";
export const ACTIONS: Action[] = ["MOVE_X+", "MOVE_X-", "MOVE_Y+", "MOVE_Y-", "HOLD"];

export interface AxisState {
  pos: number;
  vel: number;
  target: number;
}

export interface GantryState {
  x: AxisState;
  y: AxisState;
  moving: boolean;
}

export interface RLObservation {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  confidence: number;
  prevAction: Action;
}

export interface RLState {
  active: boolean;
  done: boolean;
  episode: number;
  step: number;
  targetId: string | null;
  observation: RLObservation;
  action: Action;
  reward: number;
  episodeReward: number;
  /** softmax of action scores for the chosen action */
  policyConfidence: number;
  exploring: boolean;
  /** last chosen next state, for the STATE -> ACTION -> NEXT STATE readout */
  nextX: number;
  nextY: number;
  holdCount: number;
  /** seconds since the last step, for the OBSERVE -> DECIDE -> MOVE phase readout */
  phase: "OBSERVE" | "DECIDE" | "MOVE";
}

export interface Scenario {
  objects: TestObject[];
  /** which water the rig stands in: lib/sim/environments.ts */
  environment: EnvironmentId;
  /** 0..1 */
  turbidity: number;
  /** 0..1 */
  lighting: number;
  /** 0..1 */
  threshold: number;
  /** 0.2..1 fraction of max gantry speed */
  gantrySpeed: number;
  seed: number;
  /** how the SCAN phase picks viewpoints: lib/gantry/strategies.ts; serpentine is the original plan */
  strategy: StrategyId;
  /** user waypoints for the "waypoints" strategy, gantry cm */
  waypoints: [number, number][];
}

export type RunPhase = "IDLE" | "HOMING" | "SCANNING" | "DETECTING" | "TRACKING" | "COMPLETE";

export interface TestResult {
  objectsDetected: number;
  successfulDetections: number;
  falsePositives: number;
  avgConfidence: number;
  coverage: number;
  episodeReward: number;
  durationS: number;
  targetId: string | null;
  /** scenario parameters the run used */
  environment: EnvironmentId;
  turbidity: number;
  lighting: number;
  threshold: number;
  /** inspection strategy and its movement statistics */
  strategy: StrategyId;
  viewpoints: number;
  /** carriage travel during the scan and tracking, cm */
  pathCm: number;
  /** ids of objects never detected */
  missed: string[];
  /** mean confidence gained by re-centring visits (detection-driven), null when none were made */
  repositionGain: number | null;
}

export interface RunEvent {
  t: number;
  kind: "PHASE" | "WAYPOINT" | "DETECT" | "TARGET" | "RL" | "RESULT";
  text: string;
}

export type EngineMode = "IDLE" | "MANUAL" | "TRACK" | "EPISODE" | "TEST";

export interface Telemetry {
  gantry: { x: number; y: number; vx: number; vy: number; moving: boolean; atHome: boolean };
  camera: { fps: number; resolution: string; frame: number };
  vision: { count: number; inFrame: number; bestConfidence: number; hz: number };
  system: { arduino: string; raspberryPi: string; camera: string; source: "SIMULATED" };
  time: number;
}
