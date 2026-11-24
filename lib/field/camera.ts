// Pinhole camera with an arbitrary pose, for the field platforms. Pure. The renderer's PerspectiveCamera is built
// from the same pose (components/field), so a projection here lands on the same pixel the feed shows.

import { add, cross, dot, len, qRotate, scale, sub, type Quat, type Vec3 } from "../physics/math";
import type { CameraMount } from "../platforms";

export interface CameraPose {
  position: Vec3;
  /** unit vectors in world: viewing direction, image up, image right */
  forward: Vec3;
  up: Vec3;
  right: Vec3;
  hfovDeg: number;
  aspect: number;
  width: number;
  height: number;
}

const norm = (v: Vec3): Vec3 => {
  const l = len(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Camera pose of a mount on a body (vehicle or station) at a world position and attitude. */
export function mountPose(bodyPos: Vec3, attitude: Quat, mount: CameraMount, extraPanDeg = 0, extraTiltDeg = 0): CameraPose {
  const tilt = ((mount.tiltDeg + extraTiltDeg) * Math.PI) / 180;
  const pan = (extraPanDeg * Math.PI) / 180;
  // in the body frame: forward tilted down by `tilt` about +Z (starboard), panned about +Y
  const fb: Vec3 = [Math.cos(tilt) * Math.cos(pan), -Math.sin(tilt), -Math.cos(tilt) * Math.sin(pan)];
  const ub: Vec3 = [Math.sin(tilt) * Math.cos(pan), Math.cos(tilt), -Math.sin(tilt) * Math.sin(pan)];
  const forward = norm(qRotate(attitude, fb));
  const up = norm(qRotate(attitude, ub));
  const right = norm(cross(forward, up));
  return {
    position: add(bodyPos, qRotate(attitude, mount.position)),
    forward,
    up,
    right,
    hfovDeg: mount.hfovDeg,
    aspect: mount.width / mount.height,
    width: mount.width,
    height: mount.height,
  };
}

/** Focal length in pixels along x. */
export const focalPx = (c: CameraPose) => c.width / 2 / Math.tan((c.hfovDeg * Math.PI) / 360);

/**
 * Projects a world point. u, v are normalised image coordinates from the top-left (0..1 inside the frame);
 * depth is the distance along the optical axis (negative = behind the camera).
 */
export function project(c: CameraPose, p: Vec3): { u: number; v: number; depth: number } {
  const d = sub(p, c.position);
  const z = dot(d, c.forward);
  if (z <= 1e-4) return { u: NaN, v: NaN, depth: z };
  const tanH = Math.tan((c.hfovDeg * Math.PI) / 360);
  const tanV = tanH / c.aspect;
  const x = dot(d, c.right) / (z * tanH);
  const y = dot(d, c.up) / (z * tanV);
  return { u: (x + 1) / 2, v: (1 - y) / 2, depth: z };
}

/** World point on the optical axis at a distance, for helpers and tests. */
export const along = (c: CameraPose, dist: number): Vec3 => add(c.position, scale(c.forward, dist));
