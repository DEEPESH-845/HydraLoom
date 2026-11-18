import { ENVIRONMENTS, isEnvironmentId } from "./environments";
import { CAMERA, DETECTION, GANTRY, RL, TEST, clamp } from "./constants";
import { runDetection } from "./detection";
import { createGantry, gantryAtTarget, setGantryTarget, stepGantry } from "./gantry";
import { applyAction, decide, onTarget, reward } from "./policy";
import { mulberry32 } from "./rng";
import { defaultScenario } from "./scenario";
import type {
  Action,
  Detection,
  EngineMode,
  GantryState,
  RLObservation,
  RLState,
  RunEvent,
  RunPhase,
  Scenario,
  Telemetry,
  TestResult,
} from "./types";

const FIXED_DT = 1 / 120;
const finite = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? (v as number) : fallback);
const OBSERVE_DWELL = 0.3;
const DECIDE_DWELL = 0.3;

/** Idle controller state. Position fields mirror the gantry, the single source of truth; target stays 0 until an episode names one. */
function freshRL(g: GantryState): RLState {
  return {
    active: false,
    done: false,
    episode: 0,
    step: 0,
    targetId: null,
    observation: { x: g.x.pos, y: g.y.pos, targetX: 0, targetY: 0, confidence: 0, prevAction: "HOLD" },
    action: "HOLD",
    reward: 0,
    episodeReward: 0,
    policyConfidence: 0,
    exploring: false,
    nextX: g.x.pos,
    nextY: g.y.pos,
    holdCount: 0,
    phase: "OBSERVE",
  };
}

/**
 * The whole simulation in one deterministic object.
 * tick(dt) advances gantry motion, detection, the control loop and the test runner.
 * docs/BLUEPRINT.md section 4.
 */
export class SimEngine {
  scenario: Scenario = defaultScenario();
  gantry: GantryState = createGantry();
  detections: Detection[] = [];
  rl: RLState = freshRL(this.gantry);
  mode: EngineMode = "IDLE";
  phase: RunPhase = "IDLE";
  time = 0;
  frame = 0;
  events: RunEvent[] = [];
  result: TestResult | null = null;
  /** the run before this one, so a changed scenario can be compared */
  previousResult: TestResult | null = null;
  /** objects in the camera frame regardless of threshold */
  inFrame = 0;
  /** counts manual episodes between resets so exploration visibly decays; restarts on every test run */
  private episodeCounter = 0;
  private rand = mulberry32(TEST.seed);
  private accumulator = 0;
  /** gantry position at the start of the current substep, for render interpolation */
  private prevPose = { x: 0, y: 0 };
  private readonly pose = { x: 0, y: 0 };
  private detectAccumulator = 0;
  private detectionMap = new Map<string, Detection>();
  private trackTargetId: string | null = null;
  private rlPhaseTimer = 0;
  // test runner
  private waypointIndex = 0;
  private dwell = 0;
  private seen = new Map<string, Detection>();
  private covered = new Set<number>();
  private falsePositiveIds = new Set<string>();

  // ---------- public commands ----------

  /** Full reset: default scenario, home position, no history. */
  reset(): void {
    this.scenario = defaultScenario();
    this.gantry = createGantry();
    this.previousResult = null;
    this.result = null;
    this.resetRun();
  }

  /** Clears run state but keeps the user's scenario so a test runs with their settings. */
  private resetRun(): void {
    // Replay must be a pure function of scenario + seed, so the episode index restarts too.
    this.episodeCounter = 0;
    this.detections = [];
    this.detectionMap.clear();
    this.rl = freshRL(this.gantry);
    this.mode = "IDLE";
    this.phase = "IDLE";
    this.time = 0;
    this.frame = 0;
    this.events = [];
    this.rand = mulberry32(this.scenario.seed);
    this.detectAccumulator = 0;
    this.trackTargetId = null;
    this.covered.clear();
    this.seen.clear();
    this.falsePositiveIds.clear();
  }

  /** Non-finite fields are ignored, not collapsed to a bound: a bad input never darkens the tank. */
  setScenario(patch: Partial<Omit<Scenario, "objects">>): void {
    const s = this.scenario;
    // A new environment brings its own typical water and light unless the patch sets them too.
    const environment = isEnvironmentId(patch.environment) ? patch.environment : s.environment;
    const base = environment !== s.environment ? { ...s, ...ENVIRONMENTS[environment].defaults } : s;
    this.scenario = {
      ...s,
      environment,
      turbidity: clamp(finite(patch.turbidity, base.turbidity), 0, 1),
      lighting: clamp(finite(patch.lighting, base.lighting), 0, 1),
      threshold: clamp(finite(patch.threshold, s.threshold), 0.3, 0.95),
      gantrySpeed: clamp(finite(patch.gantrySpeed, s.gantrySpeed), 0.2, 1),
      seed: finite(patch.seed, s.seed) >>> 0,
    };
  }

  moveObject(id: string, x: number, y: number): void {
    const o = this.scenario.objects.find((obj) => obj.id === id);
    if (!o) return;
    o.x = clamp(finite(x, o.x), 3, GANTRY.travelX - 3);
    o.y = clamp(finite(y, o.y), 3, GANTRY.travelY - 3);
  }

  moveTo(x: number, y: number): void {
    this.stopAuto();
    this.mode = "MANUAL";
    setGantryTarget(this.gantry, x, y);
  }

  track(objectId: string): void {
    const o = this.scenario.objects.find((obj) => obj.id === objectId);
    if (!o) return;
    this.stopAuto();
    this.mode = "TRACK";
    this.trackTargetId = objectId;
    this.log("TARGET", `TRACK ${objectId}: coarse position from overhead camera (${o.x.toFixed(0)}, ${o.y.toFixed(0)})`);
    setGantryTarget(this.gantry, o.x, o.y);
  }

  startEpisode(objectId: string): void {
    if (!this.scenario.objects.some((obj) => obj.id === objectId)) return;
    this.stopAuto();
    this.mode = "EPISODE";
    this.beginEpisode(objectId);
  }

  /**
   * Starts a test. The carriage first drives home physically (HOMING); the clock,
   * seed and log restart on arrival so the scan is always the same pure function
   * of scenario + seed regardless of where the carriage was.
   */
  runTest(): void {
    this.resetRun();
    this.mode = "TEST";
    this.phase = "HOMING";
    this.waypointIndex = 0;
    setGantryTarget(this.gantry, 0, 0);
  }

  private beginScan(): void {
    // Anything observed while driving home is not part of the test. The previous
    // result survives until here so an aborted homing does not lose it.
    this.resetRun();
    if (this.result) this.previousResult = this.result;
    this.result = null;
    this.mode = "TEST";
    this.phase = "SCANNING";
    this.log("PHASE", `TEST START seed ${this.scenario.seed}`);
    this.gotoWaypoint();
  }

  stopAuto(): void {
    this.mode = "IDLE";
    this.phase = "IDLE";
    this.rl.active = false;
    this.trackTargetId = null;
    this.gantry.x.target = this.gantry.x.pos;
    this.gantry.y.target = this.gantry.y.pos;
    this.syncIdleRL();
  }

  /**
   * With no episode running the controller readout mirrors the gantry (STATE and NEXT STATE
   * equal the carriage position) so the card never shows 0,0 beside a carriage at PARK.
   * The observation object is replaced, never mutated, so published snapshots stay frozen.
   */
  private syncIdleRL(): void {
    const rl = this.rl;
    if (rl.active) return;
    const x = this.gantry.x.pos;
    const y = this.gantry.y.pos;
    if (rl.observation.x === x && rl.observation.y === y && rl.nextX === x && rl.nextY === y) return;
    rl.observation = { ...rl.observation, x, y };
    rl.nextX = x;
    rl.nextY = y;
  }

  // ---------- main loop ----------

  /**
   * Gantry position to draw this frame: the last two substeps blended by the time already accumulated toward the
   * next one. The simulation runs at a fixed 120 Hz while displays run at 60, 90, 120 or 144 Hz with jittering
   * frame times; drawing the raw substep position makes the carriage judder whenever a frame spans 0, 1 or 3
   * substeps instead of 2. A jump larger than any real substep (a reset) is drawn as it is, never smeared.
   * Read-only for the renderer; the returned object is reused.
   */
  renderPose(): { x: number; y: number } {
    const { x, y } = this.gantry;
    const a = Math.min(1, Math.max(0, this.accumulator / FIXED_DT));
    const jump = Math.abs(x.pos - this.prevPose.x) + Math.abs(y.pos - this.prevPose.y) > 1;
    this.pose.x = jump ? x.pos : this.prevPose.x + (x.pos - this.prevPose.x) * a;
    this.pose.y = jump ? y.pos : this.prevPose.y + (y.pos - this.prevPose.y) * a;
    return this.pose;
  }

  tick(dt: number): void {
    if (!(dt > 0)) return; // NaN or negative would freeze the accumulator for good
    this.accumulator += Math.min(dt, 0.25);
    while (this.accumulator >= FIXED_DT) {
      this.substep(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
  }

  private substep(dt: number): void {
    this.prevPose.x = this.gantry.x.pos;
    this.prevPose.y = this.gantry.y.pos;
    this.time += dt;
    this.frame = Math.floor(this.time * CAMERA.fps);
    stepGantry(this.gantry, dt, this.scenario.gantrySpeed);

    this.detectAccumulator += dt;
    if (this.detectAccumulator >= 1 / DETECTION.hz) {
      const step = this.detectAccumulator;
      this.detectAccumulator = 0;
      const pass = runDetection({
        gantryX: this.gantry.x.pos,
        gantryY: this.gantry.y.pos,
        scenario: this.scenario,
        time: this.time,
        previous: this.detectionMap,
        dt: step,
      });
      this.detections = pass.detections;
      this.inFrame = pass.inFrame;
      this.detectionMap = new Map(this.detections.map((d) => [d.objectId, d]));
      if (this.mode === "TEST" && this.phase !== "HOMING") this.recordCoverage();
    }

    switch (this.mode) {
      case "TRACK":
        this.tickTrack();
        break;
      case "EPISODE":
        this.tickEpisode(dt);
        if (this.rl.done) this.mode = "IDLE";
        break;
      case "TEST":
        this.tickTest(dt);
        break;
      default:
        break;
    }
    this.syncIdleRL();
  }

  // ---------- track ----------

  private tickTrack(): void {
    if (!this.trackTargetId) return;
    const d = this.detectionMap.get(this.trackTargetId);
    // Refine the coarse target with the vision estimate once the object is in the feed.
    if (d && d.state === "LOCKED") setGantryTarget(this.gantry, d.estX, d.estY);
  }

  // ---------- RL episode ----------

  private targetFor(objectId: string): [number, number] {
    const d = this.detectionMap.get(objectId);
    if (d) return [d.estX, d.estY];
    const o = this.scenario.objects.find((obj) => obj.id === objectId)!;
    return [o.x, o.y];
  }

  private beginEpisode(objectId: string): void {
    this.episodeCounter += 1;
    const [tx, ty] = this.targetFor(objectId);
    const d = this.detectionMap.get(objectId);
    this.rl = {
      ...freshRL(this.gantry),
      active: true,
      episode: this.episodeCounter,
      targetId: objectId,
      observation: {
        x: this.gantry.x.pos,
        y: this.gantry.y.pos,
        targetX: tx,
        targetY: ty,
        confidence: d?.confidence ?? 0,
        prevAction: "HOLD",
      },
      nextX: this.gantry.x.pos,
      nextY: this.gantry.y.pos,
      phase: "OBSERVE",
    };
    this.rlPhaseTimer = 0;
    this.log("RL", `EPISODE ${this.episodeCounter} target ${objectId} (${tx.toFixed(1)}, ${ty.toFixed(1)})`);
  }

  private tickEpisode(dt: number): void {
    const rl = this.rl;
    if (!rl.active || rl.done || !rl.targetId) return;
    this.rlPhaseTimer += dt;

    if (rl.phase === "OBSERVE") {
      if (this.rlPhaseTimer < OBSERVE_DWELL) return;
      const [tx, ty] = this.targetFor(rl.targetId);
      const d = this.detectionMap.get(rl.targetId);
      rl.observation = {
        x: this.gantry.x.pos,
        y: this.gantry.y.pos,
        targetX: tx,
        targetY: ty,
        confidence: d?.confidence ?? 0,
        prevAction: rl.action,
      };
      rl.phase = "DECIDE";
      this.rlPhaseTimer = 0;
      return;
    }

    if (rl.phase === "DECIDE") {
      if (this.rlPhaseTimer < DECIDE_DWELL) return;
      const decision = decide(rl.observation, rl.episode, this.rand);
      const [nx, ny] = applyAction(rl.observation, decision.action);
      rl.action = decision.action;
      rl.policyConfidence = decision.policyConfidence;
      rl.exploring = decision.exploring;
      rl.nextX = nx;
      rl.nextY = ny;
      rl.step += 1;
      setGantryTarget(this.gantry, nx, ny);
      rl.phase = "MOVE";
      this.rlPhaseTimer = 0;
      return;
    }

    // MOVE: wait for the gantry to physically arrive, then score the transition.
    if (!gantryAtTarget(this.gantry)) return;
    const d = this.detectionMap.get(rl.targetId);
    const [tx, ty] = this.targetFor(rl.targetId);
    const next: RLObservation = {
      x: this.gantry.x.pos,
      y: this.gantry.y.pos,
      targetX: tx,
      targetY: ty,
      confidence: d?.confidence ?? 0,
      prevAction: rl.action,
    };
    rl.reward = reward(rl.observation, next, rl.action);
    rl.episodeReward = Math.round((rl.episodeReward + rl.reward) * 100) / 100;
    rl.holdCount = rl.action === "HOLD" && onTarget(next) ? rl.holdCount + 1 : 0;
    this.log(
      "RL",
      `step ${rl.step} ${rl.action}${rl.exploring ? " (explore)" : ""} r=${rl.reward >= 0 ? "+" : ""}${rl.reward.toFixed(2)} pos=(${next.x.toFixed(1)}, ${next.y.toFixed(1)})`,
    );
    if (rl.holdCount >= RL.holdToFinish || rl.step >= RL.maxSteps) {
      rl.done = true;
      rl.active = false;
      this.log("RL", `EPISODE ${rl.episode} done, reward ${rl.episodeReward >= 0 ? "+" : ""}${rl.episodeReward.toFixed(2)}`);
      return;
    }
    rl.phase = "OBSERVE";
    this.rlPhaseTimer = 0;
  }

  // ---------- test runner ----------

  private gotoWaypoint(): void {
    const [x, y] = TEST.scanWaypoints[this.waypointIndex];
    setGantryTarget(this.gantry, x, y);
    this.log("WAYPOINT", `scan ${this.waypointIndex + 1}/${TEST.scanWaypoints.length} -> (${x}, ${y})`);
  }

  private recordCoverage(): void {
    // A floor cell counts as covered when it sits inside the well-centred part of the frustum.
    const [cols, rows] = TEST.coverageGrid;
    const tanH = Math.tan((CAMERA.hfovDeg * Math.PI) / 360);
    const rMax = Math.sqrt((1 - TEST.coverageCenteringMin) / DETECTION.centeringWeight);
    const halfW = CAMERA.lensHeight * tanH * rMax * 100;
    const halfH = halfW / CAMERA.aspect;
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        const cx = ((c + 0.5) / cols) * GANTRY.travelX;
        const cy = ((r + 0.5) / rows) * GANTRY.travelY;
        if (Math.abs(cx - this.gantry.x.pos) <= halfW && Math.abs(cy - this.gantry.y.pos) <= halfH)
          this.covered.add(c * rows + r);
      }
  }

  private tickTest(dt: number): void {
    if (this.phase === "HOMING") {
      if (gantryAtTarget(this.gantry)) this.beginScan();
      return;
    }

    if (this.phase === "SCANNING") {
      if (!gantryAtTarget(this.gantry)) return;
      this.phase = "DETECTING";
      this.dwell = 0;
      return;
    }

    if (this.phase === "DETECTING") {
      this.dwell += dt;
      for (const d of this.detections) {
        const prev = this.seen.get(d.objectId);
        if (!prev || d.confidence > prev.confidence) this.seen.set(d.objectId, d);
        if (!d.correct && d.class !== "UNKNOWN") this.falsePositiveIds.add(d.objectId);
        if (!prev || (d.confidence > prev.confidence && d.class !== prev.class))
          this.log("DETECT", `${d.class} ${(d.confidence * 100).toFixed(1)}% at (${d.estX.toFixed(1)}, ${d.estY.toFixed(1)})`);
      }
      if (this.dwell < TEST.dwellSeconds) return;
      this.waypointIndex += 1;
      if (this.waypointIndex < TEST.scanWaypoints.length) {
        this.phase = "SCANNING";
        this.gotoWaypoint();
        return;
      }
      // Scan complete: choose the best correct-class detection as the tracking target.
      let best: Detection | null = null;
      for (const d of this.seen.values()) if (d.correct && (!best || d.confidence > best.confidence)) best = d;
      if (!best) {
        this.finishTest(null);
        return;
      }
      this.phase = "TRACKING";
      this.log("TARGET", `best target ${best.objectId} ${best.class} ${(best.confidence * 100).toFixed(1)}%`);
      this.beginEpisode(best.objectId);
      return;
    }

    if (this.phase === "TRACKING") {
      this.tickEpisode(dt);
      if (this.rl.done) this.finishTest(this.rl.targetId);
    }
  }

  private finishTest(targetId: string | null): void {
    const seen = [...this.seen.values()];
    const [cols, rows] = TEST.coverageGrid;
    const avg = seen.length ? seen.reduce((s, d) => s + d.confidence, 0) / seen.length : 0;
    this.result = {
      objectsDetected: seen.length,
      successfulDetections: seen.filter((d) => d.correct).length,
      falsePositives: this.falsePositiveIds.size,
      avgConfidence: avg,
      coverage: this.covered.size / (cols * rows),
      episodeReward: this.rl.episodeReward,
      durationS: this.time, // the clock restarts when the scan begins
      targetId,
      environment: this.scenario.environment,
      turbidity: this.scenario.turbidity,
      lighting: this.scenario.lighting,
      threshold: this.scenario.threshold,
    };
    this.phase = "COMPLETE";
    this.mode = "IDLE";
    this.log("RESULT", `TEST COMPLETE ${seen.length} detected, ${this.falsePositiveIds.size} false positive, coverage ${(this.result.coverage * 100).toFixed(0)}%`);
  }

  // ---------- telemetry ----------

  private log(kind: RunEvent["kind"], text: string): void {
    // New array each time so store subscribers see appends.
    this.events = [...this.events.slice(-199), { t: this.time, kind, text }];
  }

  telemetry(): Telemetry {
    const best = this.detections.reduce((m, d) => Math.max(m, d.confidence), 0);
    return {
      gantry: {
        x: this.gantry.x.pos,
        y: this.gantry.y.pos,
        vx: this.gantry.x.vel,
        vy: this.gantry.y.vel,
        moving: this.gantry.moving,
        atHome: !this.gantry.moving && this.gantry.x.pos === 0 && this.gantry.y.pos === 0,
      },
      camera: { fps: CAMERA.fps, resolution: CAMERA.resolution, frame: this.frame },
      vision: { count: this.detections.length, inFrame: this.inFrame, bestConfidence: best, hz: DETECTION.hz },
      system: { arduino: "SIMULATED", raspberryPi: "SIMULATED", camera: "SIMULATED", source: "SIMULATED" },
      time: this.time,
    };
  }

  lastAction(): Action {
    return this.rl.action;
  }
}
