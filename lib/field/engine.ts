// Field simulation engine: one environment, one platform, one mission, the water and its current.
// Pure TypeScript, no React or Three, fixed 120 Hz step, seeded: identical configuration and seed give identical
// results in Node and the browser (lib/field/field.test.ts asserts it). docs/ARCHITECTURE.md section 4.

import { AuvPilot, RovPilot, type PilotMode, type PilotTarget, type Stick, type Waypoint } from "../physics/autopilot";
import { CurrentField, DEFAULT_CURRENT, sanitizeCurrent, type CurrentConfig } from "../physics/current";
import { headingToYaw, len, qFromEuler, qNormalize, qRotate, qToEuler, sub, yawToHeading, type Quat, type Vec3 } from "../physics/math";
import { kinematicViscosity, pressureAt, waterDensity, type WaterState } from "../physics/seawater";
import { ballastFor, createVehicleState, netWeight, stepVehicle, worldVelocity, type Collider, type VehicleParams, type VehicleState } from "../physics/vehicle";
import { visibilityRange, waterOptics } from "../optics/water";
import { MISSIONS, missionRoute, type MissionId } from "../missions";
import { PLATFORMS, compatibility, type PlatformDefinition, type PlatformId } from "../platforms";
import { ENVIRONMENT_LIBRARY, isFieldEnvironmentId, ntuAt } from "../world/environments";
import type { EnvironmentDefinition, FieldEnvironmentId } from "../world/schema";
import { terrainHeight } from "../world/terrain";
import { mountPose, type CameraPose } from "./camera";
import { lampReferenceM, pathOptics, runFieldDetection, type FieldDetection, type TargetInstance } from "./detection";

export const FIELD_DT = 1 / 120;
const DETECT_HZ = 10;

export type BallastMode = "auto" | "sea" | "fresh";

export interface FieldConditions {
  /** 0..1, NTU = lo + (hi - lo) t^2 in the environment's range */
  turbidity: number;
  /** daylight (surface environments) or lamp power (lamp environments), 0..1 */
  lighting: number;
  /** vehicle lamp power in surface environments, 0..1 */
  lamps: number;
  current: CurrentConfig;
  /** detection threshold, 0.3..0.95 */
  threshold: number;
  /** cruise speed through the water, m/s */
  speedMps: number;
  /** survey altitude above the seabed, m */
  altitudeM: number;
  /** "auto" re-ballasts the vehicle for the environment's water, as an operator would */
  ballast: BallastMode;
  seed: number;
}

export type MissionPhase = "IDLE" | "RUNNING" | "COMPLETE";

export interface MissionResult {
  mission: MissionId;
  environment: FieldEnvironmentId;
  platform: PlatformId;
  durationS: number;
  distanceM: number;
  /** mechanical energy delivered by the thrusters, J (sum of thrust . velocity through water) */
  energyJ: number;
  crossTrackRmsM: number;
  coverage: number;
  targetsTotal: number;
  targetsFound: number;
  correctClass: number;
  falsePositives: number;
  meanConfidence: number;
  /** mean range at which each found target was first detected, m */
  firstDetectionRangeM: number;
  contacts: number;
  conditions: { turbidity: number; ntu: number; lighting: number; lamps: number; currentSpeedMps: number; currentHeadingDeg: number; seed: number };
  /** this is a simulation: the analytical detector, not a neural network */
  detector: "ANALYTICAL";
}

export interface FieldEvent {
  t: number;
  kind: "MISSION" | "WAYPOINT" | "DETECT" | "CONTACT" | "CONFIG";
  text: string;
}

export interface FieldTelemetry {
  time: number;
  position: Vec3;
  depthM: number;
  altitudeM: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** over ground and through the water, m/s */
  speedOverGround: number;
  speedThroughWater: number;
  /** water velocity at the vehicle, world m/s, plus speed and the direction it flows toward */
  current: Vec3;
  currentSpeed: number;
  currentHeadingDeg: number;
  /** thrust as a fraction of the maximum along each body axis */
  thrustFraction: Vec3;
  netBuoyancyN: number;
  densityKgM3: number;
  pressureKPa: number;
  temperatureC: number;
  reynolds: number;
  ntu: number;
  visibilityM: number;
  contact: boolean;
  pilot: { mode: PilotMode; waypoint: number; waypoints: number; distanceM: number; crossTrackM: number };
}

const clampf = (v: number, lo: number, hi: number, fallback: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const waterOpticsAt = (env: EnvironmentDefinition, turbidity: number) => waterOptics({ ...env.water.optics, ntu: ntuAt(env, turbidity) });
const NO_STICK: Stick = { surge: 0, sway: 0, heave: 0, yaw: 0 };

/**
 * Default conditions for an environment and platform. The survey altitude follows the water: a pilot flies at
 * about 60 percent of the visibility range (green channel, 2 percent contrast), within the platform's limits.
 */
export function defaultConditions(env: EnvironmentDefinition, platform: PlatformId): FieldConditions {
  const vis = visibilityRange(waterOpticsAt(env, env.defaults.turbidity).c[1]);
  // lamp-lit water: the lamps, not the water, limit the range, so stay within about 1.5 lamp reference distances
  const [lo, hi] = platform === "auv" ? [2, env.light.source === "lamp" ? 4 : 6] : [0.8, env.light.source === "lamp" ? 2.5 : 3];
  return {
    turbidity: env.defaults.turbidity,
    lighting: env.defaults.lighting,
    // below about 30 m daylight is too weak for the camera, so an operator runs the lamps hard
    lamps: env.light.source === "lamp" ? env.defaults.lighting : env.operatingDepthM > 30 ? 0.9 : 0.5,
    current: sanitizeCurrent({ ...DEFAULT_CURRENT, ...env.current, roughnessM: env.seabed.hydraulicRoughnessM }),
    threshold: 0.5,
    speedMps: platform === "auv" ? 1.5 : 0.5,
    altitudeM: Math.round(Math.min(hi, Math.max(lo, 0.6 * vis)) * 10) / 10,
    ballast: "auto",
    seed: 1337,
  };
}

export class FieldEngine {
  env: EnvironmentDefinition = ENVIRONMENT_LIBRARY.harbor;
  platform: PlatformDefinition = PLATFORMS.rov;
  mission: MissionId = "detection";
  conditions: FieldConditions = defaultConditions(this.env, "rov");
  params: VehicleParams | null = null;
  vehicle: VehicleState | null = null;
  /** station platform: fixed pose plus pan and tilt, degrees */
  station = { position: [0, 0, 0] as Vec3, headingDeg: 90, panDeg: 0, tiltDeg: 0 };
  pilotTarget: PilotTarget = { mode: "HOLD", stick: { ...NO_STICK }, hold: { x: 0, y: 0, z: 0 }, route: [], speed: 0.5, depthHold: true };
  targets: TargetInstance[] = [];
  detections: FieldDetection[] = [];
  events: FieldEvent[] = [];
  phase: MissionPhase = "IDLE";
  result: MissionResult | null = null;
  previousResult: MissionResult | null = null;
  time = 0;
  paused = false;
  timeScale = 1;
  current!: CurrentField;
  /** current sampled at the vehicle (or station) last step, world m/s */
  localCurrent: Vec3 = [0, 0, 0];

  private rovPilot = new RovPilot();
  private auvPilot = new AuvPilot();
  private accumulator = 0;
  private detectAcc = 0;
  private detectTick = 0;
  private detectionMap = new Map<string, FieldDetection>();
  private targetVel = new Map<string, Vec3>();
  private floating = new Set<string>();
  private prevPos: Vec3 = [0, 0, 0];
  private prevAtt: Quat = [0, 0, 0, 1];
  private readonly drawPose = { position: [0, 0, 0] as Vec3, attitude: [0, 0, 0, 1] as Quat };
  // mission bookkeeping
  private missionStart = 0;
  private distance = 0;
  private energy = 0;
  private xtSq = 0;
  private xtN = 0;
  private covered = new Set<number>();
  private seen = new Map<string, { best: FieldDetection; firstRange: number }>();
  private fpIds = new Set<string>();
  private contacts = 0;
  private wasContact = false;
  private lastWaypoint = 0;
  private bed = (x: number, z: number) => terrainHeight(this.env.geometry.terrain, x, z);
  private collider: Collider = { bed: this.bed, cylinders: [] };

  constructor(envId: FieldEnvironmentId = "harbor", platform: PlatformId = "rov") {
    this.configure(envId, platform);
  }

  // ---------- configuration ----------

  /**
   * Selects an environment and platform. An incompatible platform falls back to the environment's first platform.
   * Resets the vehicle, targets, mission and conditions to the environment's defaults.
   */
  configure(envId: FieldEnvironmentId, platformId: PlatformId): void {
    if (!isFieldEnvironmentId(envId)) return;
    const env = ENVIRONMENT_LIBRARY[envId];
    const pid = compatibility(env, platformId).ok ? platformId : (env.platforms[0] as PlatformId);
    this.env = env;
    this.platform = PLATFORMS[pid];
    this.bed = (x, z) => terrainHeight(env.geometry.terrain, x, z);
    this.collider = { bed: this.bed, cylinders: this.solids() };
    this.conditions = defaultConditions(env, pid);
    if (!env.missions.includes(this.mission) || !MISSIONS[this.mission as MissionId]?.platforms.includes(pid)) {
      this.mission = (env.missions.find((m) => MISSIONS[m as MissionId]?.platforms.includes(pid)) as MissionId) ?? "detection";
    }
    this.result = null;
    this.previousResult = null;
    this.events = [];
    this.reset();
    this.log("CONFIG", `${env.name} / ${this.platform.name}`);
  }

  /** Vertical cylinders that block vehicles and shape the current. */
  solids(): { x: number; z: number; radius: number }[] {
    const out: { x: number; z: number; radius: number }[] = [];
    for (const a of this.env.assets) if (a.solidRadius && a.at) for (const [x, z, , s] of a.at) out.push({ x, z, radius: a.solidRadius * s });
    return out;
  }

  private rebuildCurrent(): void {
    this.current = new CurrentField({ ...this.conditions.current, obstacles: this.collider.cylinders, seed: this.conditions.seed }, this.bed);
  }

  /** Puts the vehicle back at the start, the targets at their ground-truth positions, and clears the run. */
  reset(): void {
    this.time = 0;
    this.accumulator = 0;
    this.detectAcc = 0;
    this.detectTick = 0;
    this.detections = [];
    this.detectionMap.clear();
    this.phase = "IDLE";
    this.rovPilot.reset();
    this.auvPilot.reset();
    this.rebuildCurrent();
    this.targets = this.env.targets.map((t) => ({
      id: t.id,
      class: t.class,
      position: [t.x, this.bed(t.x, t.z) + t.lift, t.z] as Vec3,
      yawDeg: t.yawDeg,
      halfExtents: [...t.halfExtents] as [number, number, number],
      detectability: t.detectability,
      burial: t.burial,
    }));
    this.floating = new Set(this.env.targets.filter((t) => t.floating).map((t) => t.id));
    this.targetVel.clear();
    const [ex] = this.env.geometry.extentM;
    const startX = -ex * (this.platform.id === "auv" ? 0.42 : 0.3);
    const startZ = 0;
    const bedY = this.bed(startX, startZ);
    const surfaceDepth = -this.env.operatingDepthM;
    const y = Math.min(-0.6, Math.max(bedY + this.conditions.altitudeM, surfaceDepth));
    if (this.platform.vehicle) {
      const rho = this.waterDensityAt([startX, y, startZ]);
      const base = this.platform.vehicle;
      const ballastRho = this.conditions.ballast === "auto" ? rho : this.conditions.ballast === "fresh" ? 999 : 1025;
      this.params = ballastFor(base, ballastRho);
      this.vehicle = createVehicleState([startX, y, startZ], qFromEuler(headingToYaw(90), 0, 0));
      if (this.platform.id === "auv") this.vehicle.velocity = [this.conditions.speedMps, 0, 0];
      this.pilotTarget = { mode: "HOLD", stick: { ...NO_STICK }, hold: { x: startX, y, z: startZ, headingDeg: 90 }, route: [], speed: this.conditions.speedMps, depthHold: true };
    } else {
      this.params = null;
      this.vehicle = null;
      // station: on the seabed a few metres from the first target, looking at it
      // stands off the target's near end by a distance the water allows
      const t0 = this.env.targets[0];
      const standoff = Math.min(3.2, Math.max(1.2, 0.6 * this.visibility()));
      const sx = t0 ? t0.x - Math.max(...t0.halfExtents) - standoff : 0;
      const sz = t0 ? t0.z + 0.4 : 0;
      this.station = { position: [sx, this.bed(sx, sz), sz], headingDeg: 90, panDeg: 0, tiltDeg: 0 };
    }
    const p = this.bodyPosition();
    this.prevPos = [...p];
    this.prevAtt = [...this.bodyAttitude()];
    this.resetMissionStats();
  }

  /** Changes conditions. Non-finite values are ignored; everything is clamped to physical limits. */
  setConditions(patch: Partial<Omit<FieldConditions, "current">> & { current?: Partial<CurrentConfig> }): void {
    const c = this.conditions;
    const ballastChanged = patch.ballast !== undefined && patch.ballast !== c.ballast;
    this.conditions = {
      ...c,
      turbidity: clampf(patch.turbidity ?? c.turbidity, 0, 1, c.turbidity),
      lighting: clampf(patch.lighting ?? c.lighting, 0, 1, c.lighting),
      lamps: clampf(patch.lamps ?? c.lamps, 0, 1, c.lamps),
      threshold: clampf(patch.threshold ?? c.threshold, 0.3, 0.95, c.threshold),
      speedMps: clampf(patch.speedMps ?? c.speedMps, 0.1, this.platform.id === "auv" ? 2.2 : 1.0, c.speedMps),
      altitudeM: clampf(patch.altitudeM ?? c.altitudeM, 0.5, 20, c.altitudeM),
      ballast: patch.ballast === "sea" || patch.ballast === "fresh" || patch.ballast === "auto" ? patch.ballast : c.ballast,
      seed: Number.isFinite(patch.seed) ? (patch.seed as number) >>> 0 : c.seed,
      current: patch.current ? sanitizeCurrent(patch.current, c.current) : c.current,
    };
    this.pilotTarget.speed = this.conditions.speedMps;
    if (patch.current || patch.seed !== undefined) this.rebuildCurrent();
    if (ballastChanged && this.platform.vehicle && this.vehicle) {
      const rho = this.waterDensityAt(this.vehicle.position);
      const r = this.conditions.ballast === "auto" ? rho : this.conditions.ballast === "fresh" ? 999 : 1025;
      this.params = ballastFor(this.platform.vehicle, r);
    }
  }

  setMission(id: MissionId): void {
    if (!MISSIONS[id]) return;
    this.mission = id;
  }

  setPilotMode(mode: PilotMode): void {
    if (!this.vehicle) return;
    if (mode === "HOLD") {
      const p = this.vehicle.position;
      this.pilotTarget.hold = { x: p[0], y: p[1], z: p[2], headingDeg: yawToHeading(qToEuler(this.vehicle.attitude).yaw) };
    }
    if (mode !== "WAYPOINTS" && this.phase === "RUNNING") this.abortMission();
    this.pilotTarget.mode = mode;
  }

  setStick(stick: Partial<Stick>): void {
    const s = this.pilotTarget.stick;
    this.pilotTarget.stick = {
      surge: clampf(stick.surge ?? s.surge, -1, 1, 0),
      sway: clampf(stick.sway ?? s.sway, -1, 1, 0),
      heave: clampf(stick.heave ?? s.heave, -1, 1, 0),
      yaw: clampf(stick.yaw ?? s.yaw, -1, 1, 0),
    };
  }

  /** Aims the station camera; pan positive turns to port, tilt positive looks further down. */
  aimStation(panDeg: number, tiltDeg: number): void {
    this.station.panDeg = clampf(panDeg, -170, 170, this.station.panDeg);
    this.station.tiltDeg = clampf(tiltDeg, -20, 60, this.station.tiltDeg);
  }

  // ---------- mission ----------

  /** Starts the mission from the vehicle's current pose. Statistics restart; the previous result is kept for comparison. */
  startMission(): void {
    this.resetMissionStats();
    if (this.result) this.previousResult = this.result;
    this.result = null;
    this.phase = "RUNNING";
    this.missionStart = this.time;
    if (this.vehicle) {
      const swath = this.swathAt(this.conditions.altitudeM);
      const route = missionRoute(this.mission, { env: this.env, platform: this.platform.id, start: [...this.vehicle.position] as [number, number, number], altitudeM: this.conditions.altitudeM, swathM: swath });
      this.rovPilot.reset();
      this.auvPilot.reset();
      if (route.length) {
        this.pilotTarget = { ...this.pilotTarget, mode: "WAYPOINTS", route, speed: this.conditions.speedMps };
      } else {
        const p = this.vehicle.position;
        this.pilotTarget = { ...this.pilotTarget, mode: "HOLD", hold: { x: p[0], y: p[1], z: p[2], headingDeg: yawToHeading(qToEuler(this.vehicle.attitude).yaw) } };
      }
      this.lastWaypoint = 0;
      this.log("MISSION", `${MISSIONS[this.mission].name}: ${route.length} waypoints at ${this.conditions.speedMps.toFixed(1)} m/s`);
    } else this.log("MISSION", `${MISSIONS[this.mission].name}: fixed station, 60 s observation`);
  }

  abortMission(): void {
    if (this.phase !== "RUNNING") return;
    this.finishMission("aborted");
  }

  private resetMissionStats(): void {
    this.distance = 0;
    this.energy = 0;
    this.xtSq = 0;
    this.xtN = 0;
    this.covered.clear();
    this.seen.clear();
    this.fpIds.clear();
    this.contacts = 0;
    this.wasContact = false;
  }

  /** Camera swath on the seabed at an altitude, m (width of the footprint across track). */
  swathAt(altitudeM: number): number {
    const cam = this.platform.camera;
    const tanH = Math.tan((cam.hfovDeg * Math.PI) / 360);
    // tilted cameras see further; the near edge of a tilted footprint is used, a conservative swath
    return 2 * altitudeM * tanH * (cam.tiltDeg >= 80 ? 1 : 0.8);
  }

  // ---------- loop ----------

  tick(dt: number): void {
    if (!(dt > 0) || this.paused) return;
    this.accumulator += Math.min(dt, 0.25) * this.timeScale;
    let n = 0;
    while (this.accumulator >= FIELD_DT && n < 120) {
      this.substep(FIELD_DT);
      this.accumulator -= FIELD_DT;
      n++;
    }
    if (n >= 120) this.accumulator = 0;
  }

  /** Advances exactly `seconds` of simulated time in fixed steps, regardless of pause and time scale. Headless use. */
  advance(seconds: number): void {
    const steps = Math.round(seconds / FIELD_DT);
    for (let i = 0; i < steps; i++) this.substep(FIELD_DT);
  }

  private bodyPosition(): Vec3 {
    return this.vehicle ? this.vehicle.position : this.station.position;
  }

  private bodyAttitude(): Quat {
    return this.vehicle ? this.vehicle.attitude : qFromEuler(headingToYaw(this.station.headingDeg), 0, 0);
  }

  private waterDensityAt(p: Vec3): number {
    return waterDensity(this.waterStateAt(p));
  }

  waterStateAt(p: Vec3): WaterState {
    const w = this.env.water;
    const depth = Math.max(0, -p[1]);
    const st = w.stratification;
    let temperatureC = w.temperatureC;
    if (st) {
      const f = Math.min(1, Math.max(0, (depth - (st.depthM - st.thicknessM / 2)) / st.thicknessM));
      temperatureC = w.temperatureC + (st.temperatureBelowC - w.temperatureC) * f;
    }
    return { temperatureC, salinityPsu: w.salinityPsu, depthM: depth };
  }

  private substep(dt: number): void {
    this.prevPos = [...this.bodyPosition()];
    this.prevAtt = [...this.bodyAttitude()];
    this.time += dt;
    const pos = this.bodyPosition();
    this.localCurrent = this.current.sample(pos, this.time);

    if (this.vehicle && this.params) {
      const s = this.vehicle;
      const pilot = this.platform.id === "auv" ? this.auvPilot : this.rovPilot;
      const cmd = pilot.update(this.params, s, this.pilotTarget, this.bed, dt);
      const before: Vec3 = [...s.position];
      stepVehicle(this.params, s, cmd, { water: this.waterStateAt(s.position), current: this.localCurrent, surfaceY: 0 }, this.collider, dt);
      if (this.phase === "RUNNING") {
        this.distance += len(sub(s.position, before));
        const tf = s.thrustForce;
        const vr = s.relativeVelocity;
        this.energy += Math.max(0, tf[0] * vr[0] + tf[1] * vr[1] + tf[2] * vr[2]) * dt;
        if (this.pilotTarget.mode === "WAYPOINTS") {
          this.xtSq += pilot.status.crossTrackM ** 2;
          this.xtN++;
          if (pilot.status.waypointIndex !== this.lastWaypoint) {
            this.lastWaypoint = pilot.status.waypointIndex;
            this.log("WAYPOINT", `waypoint ${Math.min(this.lastWaypoint, this.pilotTarget.route.length)}/${this.pilotTarget.route.length}`);
          }
          if (pilot.status.done) this.finishMission("complete");
        }
        if (s.contact && !this.wasContact) {
          this.contacts++;
          this.log("CONTACT", `hull contact at (${s.position[0].toFixed(1)}, ${s.position[2].toFixed(1)})`);
        }
      }
      this.wasContact = s.contact;
    } else if (this.phase === "RUNNING" && this.time - this.missionStart >= 60) {
      this.finishMission("complete");
    }

    // free-floating targets relax toward the local water velocity (response time 5 s), at constant height above the bed
    for (const t of this.targets) {
      if (!this.floating.has(t.id)) continue;
      const u = this.current.sample(t.position, this.time);
      const v = this.targetVel.get(t.id) ?? [0, 0, 0];
      for (let i = 0; i < 3; i += 2) v[i] += ((u[i] - v[i]) / 5) * dt;
      this.targetVel.set(t.id, v);
      const spec = this.env.targets.find((s) => s.id === t.id)!;
      const [ex, ez] = this.env.geometry.extentM;
      t.position[0] = Math.max(-ex / 2, Math.min(ex / 2, t.position[0] + v[0] * dt));
      t.position[2] = Math.max(-ez / 2, Math.min(ez / 2, t.position[2] + v[2] * dt));
      t.position[1] = this.bed(t.position[0], t.position[2]) + spec.lift;
    }

    this.detectAcc += dt;
    if (this.detectAcc >= 1 / DETECT_HZ) {
      const step = this.detectAcc;
      this.detectAcc = 0;
      this.detectTick++;
      this.runDetector(step);
    }
  }

  cameraPose(interpolated = false): CameraPose {
    if (interpolated) {
      const d = this.renderPose();
      return mountPose(d.position, d.attitude, this.platform.camera, this.vehicle ? 0 : this.station.panDeg, this.vehicle ? 0 : this.station.tiltDeg);
    }
    return mountPose(this.bodyPosition(), this.bodyAttitude(), this.platform.camera, this.vehicle ? 0 : this.station.panDeg, this.vehicle ? 0 : this.station.tiltDeg);
  }

  /** Line-of-sight test: 1 when the segment is blocked by the seabed or a solid structure. */
  occlusion = (a: Vec3, b: Vec3): number => {
    const n = 16;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      if (this.bed(x, z) > y + 0.02) return 1;
    }
    for (const c of this.collider.cylinders) {
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const L2 = dx * dx + dz * dz;
      const t = L2 > 0 ? Math.min(1, Math.max(0, ((c.x - a[0]) * dx + (c.z - a[2]) * dz) / L2)) : 0;
      if (t > 0.02 && t < 0.98 && Math.hypot(a[0] + dx * t - c.x, a[2] + dz * t - c.z) < c.radius) return 1;
    }
    return 0;
  };

  private runDetector(step: number): void {
    const cam = this.cameraPose();
    const s = this.vehicle;
    const vel = s ? worldVelocity(s) : ([0, 0, 0] as Vec3);
    const w = s ? len(s.angularVelocity) : 0;
    this.detections = runFieldDetection({
      env: this.env,
      turbidity: this.conditions.turbidity,
      lighting: this.conditions.lighting,
      lamps: this.conditions.lamps,
      threshold: this.conditions.threshold,
      camera: cam,
      cameraVelocity: vel,
      cameraAngularRate: w,
      exposureS: this.platform.camera.exposureS,
      lampReferenceM: lampReferenceM(this.platform.lamps.lumens),
      targets: this.targets,
      occlusion: this.occlusion,
      seed: this.conditions.seed,
      tick: this.detectTick,
      previous: this.detectionMap,
      dt: step,
    });
    this.detectionMap = new Map(this.detections.map((d) => [d.targetId, d]));
    if (this.phase !== "RUNNING") return;
    for (const d of this.detections) {
      const prev = this.seen.get(d.targetId);
      if (!prev) {
        this.seen.set(d.targetId, { best: d, firstRange: d.distance });
        this.log("DETECT", `${d.class} ${(d.confidence * 100).toFixed(1)}% at ${d.distance.toFixed(1)} m (${d.targetId})`);
      } else if (d.confidence > prev.best.confidence) prev.best = d;
      if (!d.correct && d.class !== "UNKNOWN") this.fpIds.add(d.targetId);
    }
    this.markCoverage(cam);
  }

  private coverageCell(): number {
    return Math.max(1, Math.max(...this.env.geometry.extentM) / 40);
  }

  /** Marks seabed cells under the camera's central footprint as covered. */
  private markCoverage(cam: CameraPose): void {
    // where the optical axis meets the seabed (marching), and the footprint radius there
    let hit: Vec3 | null = null;
    for (let d = 0.2; d < 25; d += 0.2) {
      const p: Vec3 = [cam.position[0] + cam.forward[0] * d, cam.position[1] + cam.forward[1] * d, cam.position[2] + cam.forward[2] * d];
      if (this.bed(p[0], p[2]) >= p[1]) {
        hit = p;
        break;
      }
    }
    if (!hit) return;
    // beyond the visibility range the seabed is not really imaged
    const range = len(sub(hit, cam.position));
    if (range > this.visibility()) return;
    const r = range * Math.tan((cam.hfovDeg * Math.PI) / 360) * 0.7;
    const cell = this.coverageCell();
    const [ex, ez] = this.env.geometry.extentM;
    const nx = Math.ceil(ex / cell);
    for (let x = hit[0] - r; x <= hit[0] + r; x += cell / 2)
      for (let z = hit[2] - r; z <= hit[2] + r; z += cell / 2) {
        if ((x - hit[0]) ** 2 + (z - hit[2]) ** 2 > r * r) continue;
        const i = Math.floor((x + ex / 2) / cell);
        const j = Math.floor((z + ez / 2) / cell);
        if (i >= 0 && j >= 0 && i < nx && j < Math.ceil(ez / cell)) this.covered.add(j * nx + i);
      }
  }

  /** Distance at which contrast falls to 2 percent in the green channel, m. */
  visibility(): number {
    const p = this.bodyPosition();
    return visibilityRange(pathOptics(this.env, this.conditions.turbidity, p, p).c[1]);
  }

  private finishMission(how: "complete" | "aborted"): void {
    const seen = [...this.seen.values()];
    const [ex, ez] = this.env.geometry.extentM;
    const cell = this.coverageCell();
    const total = Math.ceil(ex / cell) * Math.ceil(ez / cell);
    const c = this.conditions;
    this.result = {
      mission: this.mission,
      environment: this.env.id as FieldEnvironmentId,
      platform: this.platform.id,
      durationS: this.time - this.missionStart,
      distanceM: this.distance,
      energyJ: this.energy,
      crossTrackRmsM: this.xtN ? Math.sqrt(this.xtSq / this.xtN) : 0,
      coverage: this.covered.size / total,
      targetsTotal: this.targets.length,
      targetsFound: seen.length,
      correctClass: seen.filter((s) => s.best.correct).length,
      falsePositives: this.fpIds.size,
      meanConfidence: seen.length ? seen.reduce((a, s) => a + s.best.confidence, 0) / seen.length : 0,
      firstDetectionRangeM: seen.length ? seen.reduce((a, s) => a + s.firstRange, 0) / seen.length : 0,
      contacts: this.contacts,
      conditions: { turbidity: c.turbidity, ntu: ntuAt(this.env, c.turbidity), lighting: c.lighting, lamps: c.lamps, currentSpeedMps: c.current.speedMps, currentHeadingDeg: c.current.headingDeg, seed: c.seed },
      detector: "ANALYTICAL",
    };
    this.phase = "COMPLETE";
    if (this.vehicle) {
      const p = this.vehicle.position;
      this.pilotTarget.mode = "HOLD";
      this.pilotTarget.hold = { x: p[0], y: p[1], z: p[2], headingDeg: yawToHeading(qToEuler(this.vehicle.attitude).yaw) };
    }
    this.log("MISSION", `${how === "complete" ? "COMPLETE" : "ABORTED"}: ${seen.length}/${this.targets.length} targets, ${(this.result.coverage * 100).toFixed(0)}% coverage, ${this.result.distanceM.toFixed(0)} m`);
  }

  // ---------- output ----------

  /** Body pose for drawing, blended between the last two substeps. The returned object is reused. */
  renderPose(): { position: Vec3; attitude: Quat } {
    const a = Math.min(1, Math.max(0, this.accumulator / FIELD_DT));
    const p = this.bodyPosition();
    const q = this.bodyAttitude();
    const jump = Math.hypot(p[0] - this.prevPos[0], p[1] - this.prevPos[1], p[2] - this.prevPos[2]) > 1;
    for (let i = 0; i < 3; i++) this.drawPose.position[i] = jump ? p[i] : this.prevPos[i] + (p[i] - this.prevPos[i]) * a;
    const dotq = q[0] * this.prevAtt[0] + q[1] * this.prevAtt[1] + q[2] * this.prevAtt[2] + q[3] * this.prevAtt[3];
    const sgn = dotq < 0 ? -1 : 1;
    const blended = qNormalize([
      this.prevAtt[0] + (sgn * q[0] - this.prevAtt[0]) * a,
      this.prevAtt[1] + (sgn * q[1] - this.prevAtt[1]) * a,
      this.prevAtt[2] + (sgn * q[2] - this.prevAtt[2]) * a,
      this.prevAtt[3] + (sgn * q[3] - this.prevAtt[3]) * a,
    ]);
    for (let i = 0; i < 4; i++) this.drawPose.attitude[i] = jump ? q[i] : blended[i];
    return this.drawPose;
  }

  telemetry(): FieldTelemetry {
    const p = this.bodyPosition();
    const q = this.bodyAttitude();
    const e = qToEuler(q);
    const water = this.waterStateAt(p);
    const rho = waterDensity(water);
    const s = this.vehicle;
    const pr = this.params;
    const vw = s ? worldVelocity(s) : ([0, 0, 0] as Vec3);
    const vr = s ? s.relativeVelocity : ([0, 0, 0] as Vec3);
    const c = this.localCurrent;
    const ch = Math.hypot(c[0], c[2]);
    const pilot = this.platform.id === "auv" ? this.auvPilot.status : this.rovPilot.status;
    const lengthM = pr ? pr.halfExtents[0] * 2 : 1;
    return {
      time: this.time,
      position: [...p],
      depthM: -p[1],
      altitudeM: p[1] - this.bed(p[0], p[2]),
      headingDeg: yawToHeading(e.yaw),
      pitchDeg: (e.pitch * 180) / Math.PI,
      rollDeg: (e.roll * 180) / Math.PI,
      speedOverGround: len(vw),
      speedThroughWater: len(vr),
      current: [...c],
      currentSpeed: len(c),
      currentHeadingDeg: ch > 1e-6 ? ((Math.atan2(c[0], -c[2]) * 180) / Math.PI + 360) % 360 : this.conditions.current.headingDeg,
      thrustFraction: s && pr ? (s.thrustForce.map((f, i) => (pr.maxForce[i] > 0 ? f / pr.maxForce[i] : 0)) as Vec3) : [0, 0, 0],
      netBuoyancyN: pr ? -netWeight(pr, rho) : 0,
      densityKgM3: rho,
      pressureKPa: pressureAt(water.depthM, rho) / 1000,
      temperatureC: water.temperatureC,
      reynolds: (len(vr) * lengthM) / kinematicViscosity(water),
      ntu: ntuAt(this.env, this.conditions.turbidity),
      visibilityM: this.visibility(),
      contact: s?.contact ?? false,
      pilot: { mode: this.pilotTarget.mode, waypoint: pilot.waypointIndex, waypoints: this.pilotTarget.route.length, distanceM: pilot.distanceM, crossTrackM: pilot.crossTrackM },
    };
  }

  /** World position of the vehicle's forward direction, for follow cameras. */
  forward(): Vec3 {
    return qRotate(this.bodyAttitude(), [1, 0, 0]);
  }

  route(): Waypoint[] {
    return this.pilotTarget.route;
  }

  private log(kind: FieldEvent["kind"], text: string): void {
    this.events = [...this.events.slice(-199), { t: this.time, kind, text }];
  }
}
