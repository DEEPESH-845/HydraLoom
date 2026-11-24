// Missions: what a run is trying to achieve. A mission turns (environment, platform) into a route and names the
// metrics that judge it. Composable: route generators are shared, missions only choose and parameterise them.

import { lawnmower, type Waypoint } from "../physics/autopilot";
import type { EnvironmentDefinition, TargetSpec } from "../world/schema";
import { terrainHeight } from "../world/terrain";
import type { PlatformId } from "../platforms";
import { approachExtent } from "../field/detection";

export type MissionId =
  | "detection"
  | "classification"
  | "structure-inspection"
  | "localization"
  | "seabed-exploration"
  | "obstacle-avoidance"
  | "pipeline-inspection"
  | "coverage-mapping"
  | "waypoint-navigation"
  | "calibration";

export interface MissionDefinition {
  id: MissionId;
  name: string;
  objective: string;
  /** metrics reported for this mission */
  metrics: string[];
  platforms: PlatformId[];
}

export const MISSIONS: Record<MissionId, MissionDefinition> = {
  detection: { id: "detection", name: "Object detection", objective: "Pass over every target and record which ones the detector finds.", metrics: ["targets found", "false positives", "first-detection range"], platforms: ["rov", "auv", "station", "gantry"] },
  classification: { id: "classification", name: "Object classification", objective: "Approach each target and record the class reported at close range.", metrics: ["correct class rate", "confusions"], platforms: ["rov", "station", "gantry"] },
  "structure-inspection": { id: "structure-inspection", name: "Structure inspection", objective: "Orbit the nearest structure at a fixed stand-off, keeping it in frame.", metrics: ["stand-off error", "time in frame"], platforms: ["rov"] },
  localization: { id: "localization", name: "Target localization", objective: "Estimate each target's position from detections and compare with ground truth.", metrics: ["position error"], platforms: ["rov", "auv", "gantry"] },
  "seabed-exploration": { id: "seabed-exploration", name: "Seabed exploration", objective: "Open survey of the site at a constant altitude.", metrics: ["area covered", "targets found"], platforms: ["rov", "auv"] },
  "obstacle-avoidance": { id: "obstacle-avoidance", name: "Obstacle avoidance", objective: "Transit through the structure field without contact.", metrics: ["contacts", "minimum clearance"], platforms: ["rov"] },
  "pipeline-inspection": { id: "pipeline-inspection", name: "Pipeline inspection", objective: "Follow the pipeline at survey altitude, keeping it under the camera.", metrics: ["cross-track error", "pipeline in frame"], platforms: ["rov", "auv"] },
  "coverage-mapping": { id: "coverage-mapping", name: "Coverage and mapping", objective: "Lawnmower survey with swath overlap sized from the camera footprint.", metrics: ["coverage", "overlap", "duration"], platforms: ["auv", "rov"] },
  "waypoint-navigation": { id: "waypoint-navigation", name: "Waypoint navigation", objective: "Visit a square of waypoints under the current; measure tracking error.", metrics: ["cross-track RMS", "arrival time"], platforms: ["rov", "auv"] },
  calibration: { id: "calibration", name: "Camera calibration", objective: "Hold a fixed pose facing a target and log image quality against water conditions.", metrics: ["confidence vs turbidity"], platforms: ["station", "rov", "gantry"] },
};

export interface RouteContext {
  env: EnvironmentDefinition;
  platform: PlatformId;
  /** vehicle start, world */
  start: [number, number, number];
  /** survey altitude above the seabed, m */
  altitudeM: number;
  /** camera swath width at that altitude, m */
  swathM: number;
  /** cruise speed, m/s */
  speedMps: number;
}

const bed = (env: EnvironmentDefinition) => (x: number, z: number) => terrainHeight(env.geometry.terrain, x, z);

function nearestTarget(env: EnvironmentDefinition, from: [number, number, number], pred: (t: TargetSpec) => boolean): TargetSpec | null {
  let best: TargetSpec | null = null;
  let bd = Infinity;
  for (const t of env.targets) {
    if (!pred(t)) continue;
    const d = Math.hypot(t.x - from[0], t.z - from[2]);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

/** Visits targets in nearest-neighbour order from the start. */
function tour(env: EnvironmentDefinition, start: [number, number, number], altitude: number, standoff: number): Waypoint[] {
  const left = [...env.targets];
  const out: Waypoint[] = [];
  let cur = start;
  while (left.length) {
    let bi = 0;
    let bd = Infinity;
    left.forEach((t, i) => {
      const d = Math.hypot(t.x - cur[0], t.z - cur[2]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    const t = left.splice(bi, 1)[0];
    // approach to a stand-off point on the near side, facing the target
    const dx = t.x - cur[0];
    const dz = t.z - cur[2];
    const L = Math.hypot(dx, dz) || 1;
    // the stand-off is from the near surface: a 5 m wreck measured from its centre would be parked inside
    const off = approachExtent(t, dx / L, dz / L) + standoff;
    const x = t.x - (dx / L) * off;
    const z = t.z - (dz / L) * off;
    const heading = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    out.push({ x, z, y: 0, altitude, headingDeg: heading });
    cur = [x, 0, z];
  }
  return out;
}

/** Minutes an open exploration may take: it samples the site; coverage mapping is the mission that fills it. */
const EXPLORE_MINUTES = 12;
function exploreSpacing(area: { x0: number; z0: number; x1: number; z1: number }, swath: number, speed: number): number {
  const along = Math.max(area.x1 - area.x0, area.z1 - area.z0);
  const across = Math.min(area.x1 - area.x0, area.z1 - area.z0);
  const legs = Math.max(2, Math.floor((speed * EXPLORE_MINUTES * 60 - across) / along));
  return Math.max(swath, across / (legs - 1) - 1e-6);
}

/** Straight water an AUV gets before a target to settle on the line, m. */
const RUN_IN_M = 18;

/**
 * Straight passes over every target, nearest first: a run-in long enough for an AUV to settle on the line, then out the
 * other side. It cannot hover, so a pass is its inspection.
 */
function overflights(env: EnvironmentDefinition, start: [number, number, number], altitude: number, margin: number): Waypoint[] {
  const [ex, ez] = env.geometry.extentM;
  const cx = (v: number) => Math.max(-ex / 2 + margin, Math.min(ex / 2 - margin, v));
  const cz = (v: number) => Math.max(-ez / 2 + margin, Math.min(ez / 2 - margin, v));
  const left = [...env.targets];
  const out: Waypoint[] = [];
  let cur: [number, number] = [start[0], start[2]];
  let heading: [number, number] = [1, 0];
  const turn = (a: [number, number], b: [number, number]) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));
  while (left.length) {
    left.sort((a, b) => Math.hypot(a.x - cur[0], a.z - cur[1]) - Math.hypot(b.x - cur[0], b.z - cur[1]));
    const t = left.shift()!;
    // the pass direction that leaves the longest straight run-in with the least turning; along a long object if it is one
    const r = (t.yawDeg * Math.PI) / 180;
    const long = t.halfExtents[0] > 3 * t.halfExtents[2];
    let best = { cost: Infinity, dir: [1, 0] as [number, number], inX: 0, inZ: 0, outX: 0, outZ: 0 };
    for (let k = 0; k < 24; k++) {
      const dir: [number, number] = [Math.cos((k / 24) * 2 * Math.PI), Math.sin((k / 24) * 2 * Math.PI)];
      const inX = cx(t.x - dir[0] * RUN_IN_M);
      const inZ = cz(t.z - dir[1] * RUN_IN_M);
      const outX = cx(t.x + dir[0] * 6);
      const outZ = cz(t.z + dir[1] * 6);
      const leg: [number, number] = [inX - cur[0], inZ - cur[1]];
      const legL = Math.hypot(leg[0], leg[1]);
      const to: [number, number] = legL > 1e-6 ? [leg[0] / legL, leg[1] / legL] : heading;
      // clamping to the site bends the line off the target: that is the run-in lost
      const miss = Math.abs((t.x - inX) * -dir[1] + (t.z - inZ) * dir[0]);
      const run = Math.hypot(t.x - inX, t.z - inZ);
      const across = long ? 4 * Math.abs(dir[0] * Math.sin(r) + dir[1] * Math.cos(r)) : 0;
      const cost = legL * 0.25 + 5 * turn(heading, to) + 7 * turn(to, dir) + 3 * Math.max(0, RUN_IN_M - run) + 6 * miss + across + (legL < 8 ? 6 : 0);
      if (cost < best.cost) best = { cost, dir, inX, inZ, outX, outZ };
    }
    // the line always goes through the target itself
    const L = Math.hypot(t.x - best.inX, t.z - best.inZ) || 1;
    const d: [number, number] = [(t.x - best.inX) / L, (t.z - best.inZ) / L];
    out.push({ x: best.inX, z: best.inZ, y: 0, altitude }, { x: cx(t.x + d[0] * 6), z: cz(t.z + d[1] * 6), y: 0, altitude });
    cur = [cx(t.x + d[0] * 6), cz(t.z + d[1] * 6)];
    heading = d;
  }
  return out;
}

/** Builds the route for a mission. Station platforms return no route (they do not move). */
export function missionRoute(id: MissionId, ctx: RouteContext): Waypoint[] {
  const { env, platform, start, altitudeM, swathM } = ctx;
  if (platform === "station" || platform === "gantry") return [];
  const [ex, ez] = env.geometry.extentM;
  const margin = platform === "auv" ? Math.min(9, 0.22 * Math.min(ex, ez)) : 2;
  // surveys cover at most an 80 x 80 m box in the middle of the site, so a mission stays minutes, not hours
  const hx = Math.min(ex / 2 - margin, 40);
  const hz = Math.min(ez / 2 - margin, 40);
  const area = { x0: -hx, z0: -hz, x1: hx, z1: hz };
  const isAuv = platform === "auv";
  switch (id) {
    case "coverage-mapping":
    case "seabed-exploration":
      return id === "coverage-mapping" ? lawnmower(area, swathM, 0.2, 0, altitudeM) : lawnmower(area, exploreSpacing(area, swathM, ctx.speedMps), 0, 0, altitudeM);
    case "structure-inspection": {
      // orbit the nearest solid asset (piling or pier) at 2 m stand-off, 8 points, facing it
      const solids: { x: number; z: number; r: number }[] = [];
      for (const a of env.assets) if (a.solidRadius && a.at) for (const [x, z, , s] of a.at) solids.push({ x, z, r: a.solidRadius * s });
      solids.sort((a, b) => Math.hypot(a.x - start[0], a.z - start[2]) - Math.hypot(b.x - start[0], b.z - start[2]));
      const c = solids[0];
      if (!c) return tour(env, start, altitudeM, 1.5);
      const R = c.r + 2;
      const pts: Waypoint[] = [];
      for (let i = 0; i <= 8; i++) {
        const a = (i / 8) * 2 * Math.PI;
        const x = c.x + R * Math.cos(a);
        const z = c.z + R * Math.sin(a);
        pts.push({ x, z, y: bed(env)(x, z) + Math.max(1.0, altitudeM), headingDeg: ((Math.atan2(c.x - x, -(c.z - z)) * 180) / Math.PI + 360) % 360 });
      }
      return pts;
    }
    case "pipeline-inspection": {
      const p = nearestTarget(env, start, (t) => t.class === "PIPELINE");
      if (!p) return tour(env, start, altitudeM, 1.5);
      const yaw = (-p.yawDeg * Math.PI) / 180;
      const hx = Math.cos(yaw) * p.halfExtents[0];
      const hz = -Math.sin(yaw) * p.halfExtents[0];
      const run = isAuv ? 10 : 1;
      return [
        { x: p.x - hx - (hx / p.halfExtents[0]) * run, z: p.z - hz - (hz / p.halfExtents[0]) * run, y: 0, altitude: altitudeM },
        { x: p.x + hx + (hx / p.halfExtents[0]) * run, z: p.z + hz + (hz / p.halfExtents[0]) * run, y: 0, altitude: altitudeM },
      ];
    }
    case "waypoint-navigation": {
      const s = Math.min(ex, ez) * (isAuv ? 0.3 : 0.25);
      return [
        { x: -s, z: -s, y: 0, altitude: altitudeM },
        { x: s, z: -s, y: 0, altitude: altitudeM },
        { x: s, z: s, y: 0, altitude: altitudeM },
        { x: -s, z: s, y: 0, altitude: altitudeM },
        { x: -s, z: -s, y: 0, altitude: altitudeM },
      ];
    }
    case "obstacle-avoidance": {
      // weave through the solid assets in x order, passing 1.5 m beside each
      const solids: { x: number; z: number; r: number }[] = [];
      for (const a of env.assets) if (a.solidRadius && a.at) for (const [x, z, , s] of a.at) solids.push({ x, z, r: a.solidRadius * s });
      solids.sort((a, b) => a.x - b.x);
      return solids.map((c, i) => ({ x: c.x, z: c.z + (i % 2 ? 1 : -1) * (c.r + 1.5), y: 0, altitude: altitudeM }));
    }
    case "calibration":
      return [];
    case "detection":
    case "classification":
    case "localization":
    default:
      // the stand-off follows the survey altitude, which the field engine sizes from the water's visibility
      return isAuv ? overflights(env, start, altitudeM, margin) : tour(env, start, altitudeM, Math.min(2.5, Math.max(0.8, altitudeM * (id === "classification" ? 0.7 : 1))));
  }
}
