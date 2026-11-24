import { create } from "zustand";
import type { PilotMode, Stick } from "../physics/autopilot";
import type { CurrentConfig } from "../physics/current";
import type { MissionId } from "../missions";
import { compatibility, isPlatformId, type PlatformId } from "../platforms";
import { ENVIRONMENT_LIBRARY, isFieldEnvironmentId } from "../world/environments";
import type { FieldEnvironmentId } from "../world/schema";
import { FieldEngine, type FieldConditions, type FieldEvent, type FieldTelemetry, type MissionPhase, type MissionResult } from "./engine";
import type { FieldDetection } from "./detection";

/** Workspaces of the platform shell. 04 and 06 are their own routes (/models, /reports). */
export type WorkspaceId = "environment" | "platform" | "simulation" | "analysis";

export type ViewMode = "overview" | "follow" | "pilot" | "free";

/** Snapshot of the engine published to React at about 15 Hz. Hot 3D reads go through `engine` directly. */
export interface FieldSnapshot {
  envId: FieldEnvironmentId;
  platformId: PlatformId;
  mission: MissionId;
  conditions: FieldConditions;
  telemetry: FieldTelemetry;
  detections: FieldDetection[];
  events: FieldEvent[];
  phase: MissionPhase;
  result: MissionResult | null;
  previousResult: MissionResult | null;
  paused: boolean;
  timeScale: number;
}

interface FieldStore extends FieldSnapshot {
  engine: FieldEngine;
  workspace: WorkspaceId;
  view: ViewMode;
  /** free exploration: the panels step aside so the whole window is the site */
  exploring: boolean;
  /** bumps on every recenter request so the camera rig refits the overview even when the view is already overview */
  viewEpoch: number;
  /** false while the 3D world is being swapped; the UI veils the view meanwhile */
  worldReady: boolean;
  /** main view water is thinned for the overview; the vehicle camera always sees true water */
  overviewThinning: boolean;
  showFlow: boolean;
  selectedTargetId: string | null;
  publish: () => void;
  setWorkspace: (w: WorkspaceId) => void;
  setView: (v: ViewMode) => void;
  setExploring: (v: boolean) => void;
  /** back to the whole-site overview, refitted to the current layout */
  recenter: () => void;
  selectEnvironment: (id: FieldEnvironmentId) => void;
  selectPlatform: (id: PlatformId) => void;
  setMission: (id: MissionId) => void;
  setConditions: (patch: Partial<Omit<FieldConditions, "current">> & { current?: Partial<CurrentConfig> }) => void;
  setPilotMode: (m: PilotMode) => void;
  setStick: (s: Partial<Stick>) => void;
  aimStation: (pan: number, tilt: number) => void;
  startMission: () => void;
  abortMission: () => void;
  reset: () => void;
  setPaused: (p: boolean) => void;
  setTimeScale: (s: number) => void;
  setWorldReady: (v: boolean) => void;
  setOverviewThinning: (v: boolean) => void;
  setShowFlow: (v: boolean) => void;
  selectTarget: (id: string | null) => void;
}

const STORAGE_KEY = "gantrylab.field.selection.v1";

function snapshot(e: FieldEngine): FieldSnapshot {
  return {
    envId: e.env.id as FieldEnvironmentId,
    platformId: e.platform.id,
    mission: e.mission,
    conditions: { ...e.conditions, current: { ...e.conditions.current } },
    telemetry: e.telemetry(),
    detections: e.detections,
    events: e.events,
    phase: e.phase,
    result: e.result,
    previousResult: e.previousResult,
    paused: e.paused,
    timeScale: e.timeScale,
  };
}

/** Last selection, so the context survives a trip to /models, /reports or /lab. Never throws. */
function loadSelection(): { env: FieldEnvironmentId; platform: PlatformId } {
  try {
    if (typeof window === "undefined") return { env: "harbor", platform: "rov" };
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as { env?: unknown; platform?: unknown }) : {};
    const env = isFieldEnvironmentId(v.env) ? v.env : "harbor";
    const platform = isPlatformId(v.platform) && compatibility(ENVIRONMENT_LIBRARY[env], v.platform).ok ? v.platform : (ENVIRONMENT_LIBRARY[env].platforms[0] as PlatformId);
    return { env, platform };
  } catch {
    return { env: "harbor", platform: "rov" };
  }
}

function saveSelection(env: FieldEnvironmentId, platform: PlatformId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ env, platform }));
  } catch {
    // storage unavailable (private mode, blocked): the selection simply is not remembered
  }
}

export const useFieldStore = create<FieldStore>((set, get) => {
  const sel = loadSelection();
  const engine = new FieldEngine(sel.env, sel.platform);
  const publish = () => set(snapshot(engine));
  return {
    engine,
    ...snapshot(engine),
    workspace: "environment",
    view: "overview",
    exploring: false,
    viewEpoch: 0,
    worldReady: true,
    overviewThinning: true,
    showFlow: true,
    selectedTargetId: null,
    publish,
    setWorkspace: (workspace) => set({ workspace }),
    setView: (view) => set({ view }),
    setExploring: (exploring) => {
      if (exploring !== get().exploring) set({ exploring });
    },
    recenter: () => set({ view: "overview", viewEpoch: get().viewEpoch + 1 }),
    selectEnvironment: (id) => {
      if (!isFieldEnvironmentId(id) || id === engine.env.id) return;
      engine.configure(id, get().platformId);
      saveSelection(id, engine.platform.id);
      // a free camera was placed for the old site (the deep sea lies 1.5 km lower): the new site opens on its overview
      set({ selectedTargetId: null, ...(get().view === "free" ? { view: "overview" as const } : {}) });
      publish();
    },
    selectPlatform: (id) => {
      if (!isPlatformId(id) || id === engine.platform.id) return;
      if (!compatibility(engine.env, id).ok) return;
      engine.configure(engine.env.id as FieldEnvironmentId, id);
      saveSelection(engine.env.id as FieldEnvironmentId, id);
      publish();
    },
    setMission: (id) => {
      engine.setMission(id);
      publish();
    },
    setConditions: (patch) => {
      engine.setConditions(patch);
      publish();
    },
    setPilotMode: (m) => {
      engine.setPilotMode(m);
      publish();
    },
    setStick: (s) => engine.setStick(s),
    aimStation: (pan, tilt) => {
      engine.aimStation(pan, tilt);
      publish();
    },
    startMission: () => {
      engine.startMission();
      publish();
    },
    abortMission: () => {
      engine.abortMission();
      publish();
    },
    reset: () => {
      engine.reset();
      set({ selectedTargetId: null });
      publish();
    },
    setPaused: (p) => {
      engine.paused = p;
      publish();
    },
    setTimeScale: (s) => {
      engine.timeScale = [0.25, 0.5, 1, 2, 4, 8].includes(s) ? s : 1;
      publish();
    },
    setWorldReady: (worldReady) => set({ worldReady }),
    setOverviewThinning: (overviewThinning) => set({ overviewThinning }),
    setShowFlow: (showFlow) => set({ showFlow }),
    selectTarget: (selectedTargetId) => set({ selectedTargetId }),
  };
});
