// Test platforms, independent of environments. An environment never creates a platform; the user picks one and the
// field engine places it. The gantry exists only in the Gantry Lab (lib/sim), which is its own experience at /lab.

import { VEHICLES, type VehicleParams } from "../physics/vehicle";
import type { EnvironmentDefinition } from "../world/schema";

export type PlatformId = "gantry" | "rov" | "auv" | "station";

export interface CameraMount {
  /** lens position in the platform body frame, m (x forward, y up, z starboard) */
  position: [number, number, number];
  /** downward tilt from the body's forward axis, degrees (90 = straight down) */
  tiltDeg: number;
  /** horizontal field of view under water, degrees */
  hfovDeg: number;
  /** image size, px */
  width: number;
  height: number;
  fps: number;
  /** exposure time, s; motion during it smears the image (the AUV camera is strobe-lit, the ROV runs a short shutter) */
  exposureS: number;
}

export interface LampMount {
  count: number;
  /** total luminous flux of all lamps, lm (representative) */
  lumens: number;
  /** full beam angle, degrees */
  beamDeg: number;
  /** offset of each lamp from the lens, body frame, m; separation reduces backscatter in the image */
  offsets: [number, number, number][];
}

export interface PlatformDefinition {
  id: PlatformId;
  name: string;
  summary: string;
  /** "lab" platforms run in /lab; "field" platforms run in the field engine */
  domain: "lab" | "field";
  vehicle?: VehicleParams;
  camera: CameraMount;
  lamps: LampMount;
  sensors: string[];
  /** on-board compute profile id used by the hardware estimate (backend compute profiles) */
  compute: string;
  /** station: fixed on a tripod, pan and tilt only */
  fixed: boolean;
}

export const PLATFORMS: Record<PlatformId, PlatformDefinition> = {
  gantry: {
    id: "gantry",
    name: "Gantry camera rig",
    summary: "XY gantry over the lab tank with a downward camera. Repeatable positioning to 0.15 cm; runs in the Gantry Lab.",
    domain: "lab",
    camera: { position: [0, 0, 0], tiltDeg: 90, hfovDeg: 75, width: 1280, height: 960, fps: 30, exposureS: 1 / 120 },
    lamps: { count: 0, lumens: 0, beamDeg: 0, offsets: [] },
    sensors: ["Raspberry Pi Camera Module 3 Wide", "limit switches X0, Y0"],
    compute: "rpi4",
    fixed: false,
  },
  rov: {
    id: "rov",
    name: "Observation ROV",
    summary: "Tethered, fully actuated (6 DOF, 8 thrusters). Holds station in moderate current; forward camera tilted 30 degrees down.",
    domain: "field",
    vehicle: VEHICLES.rov,
    camera: { position: [0.22, 0.02, 0], tiltDeg: 30, hfovDeg: 80, width: 1280, height: 720, fps: 30, exposureS: 1 / 120 },
    lamps: { count: 4, lumens: 6000, beamDeg: 135, offsets: [[0.2, 0.08, -0.18], [0.2, 0.08, 0.18], [0.2, -0.08, -0.18], [0.2, -0.08, 0.18]] },
    sensors: ["HD camera (1280x720)", "depth sensor", "IMU/AHRS", "DVL (simulated velocity)"],
    compute: "rpi4",
    fixed: false,
  },
  auv: {
    id: "auv",
    name: "Survey AUV",
    summary: "Torpedo AUV, propeller plus rudder and elevator. Flies survey lines at 1 to 2 m/s; cannot hover. Downward camera.",
    domain: "field",
    vehicle: VEHICLES.auv,
    camera: { position: [0.3, -0.09, 0], tiltDeg: 90, hfovDeg: 70, width: 1280, height: 960, fps: 10, exposureS: 1 / 1000 },
    lamps: { count: 2, lumens: 10000, beamDeg: 90, offsets: [[0.1, -0.1, -0.08], [0.55, -0.1, 0.08]] },
    sensors: ["downward survey camera", "DVL", "INS", "depth sensor", "altimeter"],
    compute: "rpi5",
    fixed: false,
  },
  station: {
    id: "station",
    name: "Seabed camera station",
    summary: "Fixed tripod camera 1.2 m above the seabed with pan and tilt. A stable baseline: no vehicle motion, only the water changes.",
    domain: "field",
    camera: { position: [0, 1.2, 0], tiltDeg: 25, hfovDeg: 75, width: 1920, height: 1080, fps: 15, exposureS: 1 / 60 },
    lamps: { count: 2, lumens: 4000, beamDeg: 100, offsets: [[0, 0.25, -0.35], [0, 0.25, 0.35]] },
    sensors: ["fixed HD camera", "pan/tilt head", "CTD (temperature, salinity, depth)", "current meter"],
    compute: "rpi4",
    fixed: true,
  },
};

export const PLATFORM_ORDER: PlatformId[] = ["gantry", "rov", "auv", "station"];

export const isPlatformId = (v: unknown): v is PlatformId => typeof v === "string" && (PLATFORM_ORDER as string[]).includes(v);

/** Whether a platform can operate in an environment, with the reason when it cannot. */
export function compatibility(env: EnvironmentDefinition, platform: PlatformId): { ok: boolean; reason: string } {
  if (env.platforms.includes(platform)) return { ok: true, reason: "" };
  if (platform === "gantry") return { ok: false, reason: "The gantry is a bench-top rig: it only exists in the Gantry Lab." };
  if (env.kind === "lab") return { ok: false, reason: "The Gantry Lab tests the gantry camera rig only." };
  if (platform === "auv") return { ok: false, reason: `${env.name} is too confined for an AUV that cannot hover; use the ROV.` };
  return { ok: false, reason: `${PLATFORMS[platform].name} is not configured for ${env.name}.` };
}
