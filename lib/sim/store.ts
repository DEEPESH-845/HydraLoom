import { create } from "zustand";
import { SimEngine } from "./engine";
import type { Detection, EngineMode, RLState, RunEvent, RunPhase, Scenario, Telemetry, TestResult } from "./types";

export type SceneId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type CameraPreset = "A" | "B" | "C" | "D" | "E";

/** Component ids for scene 02 highlighting. Must match the ids used by the 3D components. */
export type ComponentId = "gantry" | "camera" | "aquarium" | "raspberry-pi" | "arduino" | "test-objects";

/** DOM id of the camera feed container. The 3D feed renderer measures this element. */
export const FEED_ELEMENT_ID = "gantry-camera-feed";

// Scenario edits object XY, so it gets the top-down map like the gantry scenes.
export const SCENE_CAMERA: Record<SceneId, CameraPreset> = { 1: "A", 2: "A", 3: "D", 4: "B", 5: "B", 6: "B", 7: "A" };

export interface DemoState {
  active: boolean;
  paused: boolean;
  /** seconds into the script */
  t: number;
  /** index into DEMO_PHASES */
  phase: number;
  /** increments on every start so the driver restarts its director even mid-demo */
  run: number;
}

/** Snapshot of the engine published to React at ~20 Hz. Hot 3D reads go through `engine` directly. */
export interface SimSnapshot {
  telemetry: Telemetry;
  detections: Detection[];
  rl: RLState;
  mode: EngineMode;
  phase: RunPhase;
  result: TestResult | null;
  previousResult: TestResult | null;
  events: RunEvent[];
  scenario: Scenario;
}

interface SimStore extends SimSnapshot {
  engine: SimEngine;
  scene: SceneId;
  cameraPreset: CameraPreset;
  highlight: ComponentId | null;
  /** the component the user clicked to keep highlighted; hovering elsewhere shows another, leaving returns to this one */
  pinnedHighlight: ComponentId | null;
  selectedObjectId: string | null;
  demo: DemoState;
  /** set by the UI when the user wants to see the "simulation to field" closing moment */
  showVision: boolean;
  /** false while the 3D site is being swapped for another environment; the UI veils the view meanwhile */
  siteReady: boolean;
  /** free-explore mode: the scene panels step aside so the whole canvas is the machine */
  exploring: boolean;
  /** bumps on every "recenter view" request so the camera rig refits the current preset even after the user orbited */
  viewEpoch: number;

  publish: () => void;
  setScene: (scene: SceneId) => void;
  setCameraPreset: (p: CameraPreset) => void;
  setHighlight: (id: ComponentId | null) => void;
  /** click: pin this component's highlight (or unpin with null) */
  pinHighlight: (id: ComponentId | null) => void;
  /** pointer or focus left a hover target: back to the pinned component, or none */
  releaseHighlight: () => void;
  selectObject: (id: string | null) => void;
  moveGantryTo: (x: number, y: number) => void;
  trackObject: (id: string) => void;
  startEpisode: (id: string) => void;
  runTest: () => void;
  replayTest: () => void;
  stop: () => void;
  reset: () => void;
  setScenario: (patch: Partial<Omit<Scenario, "objects">>) => void;
  moveObject: (id: string, x: number, y: number) => void;
  startDemo: () => void;
  pauseDemo: (paused: boolean) => void;
  exitDemo: () => void;
  setDemoTime: (t: number) => void;
  setDemoPhase: (phase: number) => void;
  setShowVision: (v: boolean) => void;
  setExploring: (v: boolean) => void;
  setSiteReady: (v: boolean) => void;
  recenterView: () => void;
}

function snapshot(engine: SimEngine): SimSnapshot {
  return {
    telemetry: engine.telemetry(),
    detections: engine.detections,
    rl: { ...engine.rl },
    mode: engine.mode,
    phase: engine.phase,
    result: engine.result,
    previousResult: engine.previousResult,
    events: engine.events,
    scenario: engine.scenario,
  };
}

export const useSimStore = create<SimStore>((set, get) => {
  const engine = new SimEngine();
  const publish = () => set(snapshot(engine));
  return {
    engine,
    ...snapshot(engine),
    scene: 1,
    cameraPreset: "A",
    highlight: null,
    pinnedHighlight: null,
    selectedObjectId: null,
    demo: { active: false, paused: false, t: 0, phase: 0, run: 0 },
    showVision: false,
    siteReady: true,
    exploring: false,
    viewEpoch: 0,

    publish,
    setScene: (scene) => set({ scene, cameraPreset: SCENE_CAMERA[scene], highlight: null, pinnedHighlight: null }),
    setCameraPreset: (cameraPreset) => set({ cameraPreset }),
    setHighlight: (highlight) => set({ highlight }),
    pinHighlight: (pinnedHighlight) => set({ pinnedHighlight, highlight: pinnedHighlight }),
    releaseHighlight: () => set({ highlight: get().pinnedHighlight }),
    selectObject: (selectedObjectId) => set({ selectedObjectId }),
    moveGantryTo: (x, y) => {
      engine.moveTo(x, y);
      publish();
    },
    trackObject: (id) => {
      engine.track(id);
      set({ selectedObjectId: id });
      publish();
    },
    startEpisode: (id) => {
      engine.startEpisode(id);
      set({ selectedObjectId: id });
      publish();
    },
    runTest: () => {
      engine.runTest();
      set({ selectedObjectId: null });
      publish();
    },
    replayTest: () => {
      // Deterministic re-run with the same seed. Same inputs, same result.
      engine.runTest();
      set({ selectedObjectId: null, scene: 4, cameraPreset: SCENE_CAMERA[4] });
      publish();
    },
    stop: () => {
      engine.stopAuto();
      publish();
    },
    // Reset restores the lab (engine defaults, PARK, no history) and clears every UI selection.
    // The chosen environment is context, like the scene: it stays, with that environment's default water and light.
    // scene and cameraPreset stay: the rail is navigation, not lab state, and the user pressed RESET from a card they expect to keep.
    // demo.run is a restart counter for the driver and is deliberately preserved.
    reset: () => {
      const environment = engine.scenario.environment;
      engine.reset();
      if (environment !== engine.scenario.environment) engine.setScenario({ environment });
      set({ selectedObjectId: null, highlight: null, pinnedHighlight: null, showVision: false, demo: { active: false, paused: false, t: 0, phase: 0, run: get().demo.run } });
      publish();
    },
    setScenario: (patch) => {
      engine.setScenario(patch);
      publish();
    },
    moveObject: (id, x, y) => {
      engine.moveObject(id, x, y);
      publish();
    },
    startDemo: () => {
      engine.reset();
      set({ demo: { active: true, paused: false, t: 0, phase: 0, run: get().demo.run + 1 }, scene: 1, cameraPreset: "A", selectedObjectId: null, showVision: false, exploring: false });
      publish();
    },
    pauseDemo: (paused) => set({ demo: { ...get().demo, paused } }),
    exitDemo: () => {
      engine.stopAuto();
      set({ demo: { active: false, paused: false, t: 0, phase: 0, run: get().demo.run } });
      publish();
    },
    setDemoTime: (t) => set({ demo: { ...get().demo, t } }),
    setDemoPhase: (phase) => set({ demo: { ...get().demo, phase } }),
    setShowVision: (showVision) => set({ showVision }),
    // The demo directs the camera and narrates through the card, so it cannot run with the panels hidden.
    // Leaving explore puts the panels back, so the view returns to the scene's framing around them.
    setSiteReady: (siteReady) => set({ siteReady }),
    setExploring: (exploring) => {
      const next = exploring && !get().demo.active;
      if (next === get().exploring) return;
      set(next ? { exploring: true } : { exploring: false, viewEpoch: get().viewEpoch + 1 });
    },
    recenterView: () => set({ viewEpoch: get().viewEpoch + 1 }),
  };
});
