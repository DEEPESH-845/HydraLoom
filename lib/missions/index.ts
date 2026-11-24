// Missions: what a run is trying to achieve. A mission turns (environment, platform) into a route and names the
// metrics that judge it. Composable: route generators are shared, missions only choose and parameterise them.

import { lawnmower, type Waypoint } from "../physics/autopilot";
import type { EnvironmentDefinition, TargetSpec } from "../world/schema";
import { terrainHeight } from "../world/terrain";
import type { PlatformId } from "../platforms";

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
    const x = t.x - (dx / L) * standoff;
    const z = t.z - (dz / L) * standoff;
    const heading = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    out.push({ x, z, y: 0, altitude, headingDeg: heading });
    cur = [x, 0, z];
  }
  return out;
}

/** Builds the route for a mission. Station platforms return no route (they do not move). */
export function missionRoute(id: MissionId, ctx: RouteContext): Waypoint[] {
  const { env, platform, start, altitudeM, swathM } = ctx;
  if (platform === "station" || platform === "gantry") return [];
  const [ex, ez] = env.geometry.extentM;
  const margin = platform === "auv" ? 8 : 2;
  // surveys cover at most an 80 x 80 m box in the middle of the site, so a mission stays minutes, not hours
  const hx = Math.min(ex / 2 - margin, 40);
  const hz = Math.min(ez / 2 - margin, 40);
  const area = { x0: -hx, z0: -hz, x1: hx, z1: hz };
  const isAuv = platform === "auv";
  switch (id) {
    case "coverage-mapping":
    case "seabed-exploration":
      return lawnmower(area, swathM, id === "coverage-mapping" ? 0.2 : 0, 0, altitudeM);
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
      return isAuv ? lawnmower(area, swathM, 0.1, 0, altitudeM) : tour(env, start, altitudeM, Math.min(2.5, Math.max(0.8, altitudeM * (id === "classification" ? 0.7 : 1))));
  }
}
