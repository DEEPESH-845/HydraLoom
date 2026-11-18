import { GANTRY, clamp } from "./constants";
import type { AxisState, GantryState } from "./types";

/** Parked over the middle of the tank so the camera and its footprint read at a glance. */
export const PARK: readonly [number, number] = [50, 20];

export function createGantry(): GantryState {
  return {
    x: { pos: PARK[0], vel: 0, target: PARK[0] },
    y: { pos: PARK[1], vel: 0, target: PARK[1] },
    moving: false,
  };
}

/**
 * One axis of a trapezoidal move: accelerate toward the target, decelerate so
 * the axis stops exactly on it, never exceed vmax, never leave the rail.
 * `accel` shapes the planned profile; `brake` (at least accel) is what the axis may use to shed speed it should not
 * have, so a move retargeted mid-flight (live steering) never overshoots.
 */
function stepAxis(a: AxisState, dt: number, vmax: number, accel: number, limit: number, brake = accel): void {
  a.target = clamp(a.target, 0, limit);
  const err = a.target - a.pos;
  const dist = Math.abs(err);

  if (dist < GANTRY.arriveTolerance && Math.abs(a.vel) < accel * dt * 1.5) {
    a.pos = a.target;
    a.vel = 0;
    return;
  }

  const dir = Math.sign(err);
  // Speed at which we can still stop in the remaining distance.
  const stopSpeed = Math.sqrt(2 * accel * dist);
  const desired = dir * Math.min(vmax, stopSpeed);
  const slowing = Math.sign(desired) !== Math.sign(a.vel) || Math.abs(desired) < Math.abs(a.vel);
  const lim = (slowing ? Math.max(brake, accel) : accel) * dt;
  const dv = clamp(desired - a.vel, -lim, lim);
  a.vel += dv;
  a.pos = clamp(a.pos + a.vel * dt, 0, limit);
}

/**
 * Both axes move together along a straight line: the axis with less distance to cover gets its speed and
 * acceleration scaled by the ratio of the remaining distances, so the two trapezoids have the same shape and
 * arrive together. Without this a diagonal move is a dog-leg (the short axis finishes early and the carriage turns
 * a corner). The long axis keeps the full limits, so no move gets slower. The floor keeps a nearly aligned axis
 * from crawling onto its target.
 */
export function stepGantry(g: GantryState, dt: number, speedFraction: number): void {
  const vmax = GANTRY.maxSpeed * clamp(speedFraction, 0.2, 1);
  const dx = Math.abs(clamp(g.x.target, 0, GANTRY.travelX) - g.x.pos);
  const dy = Math.abs(clamp(g.y.target, 0, GANTRY.travelY) - g.y.pos);
  const far = Math.max(dx, dy);
  const sx = far > 0 ? Math.max(0.05, dx / far) : 1;
  const sy = far > 0 ? Math.max(0.05, dy / far) : 1;
  stepAxis(g.x, dt, vmax * sx, GANTRY.accel * sx, GANTRY.travelX, GANTRY.accel);
  stepAxis(g.y, dt, vmax * sy, GANTRY.accel * sy, GANTRY.travelY, GANTRY.accel);
  g.moving = g.x.vel !== 0 || g.y.vel !== 0;
}

export function gantryAtTarget(g: GantryState): boolean {
  return !g.moving && g.x.pos === g.x.target && g.y.pos === g.y.target;
}

/** A non-finite coordinate is dropped (that axis keeps its target) rather than sent to a rail end. */
export function setGantryTarget(g: GantryState, x: number, y: number): void {
  if (Number.isFinite(x)) g.x.target = clamp(x, 0, GANTRY.travelX);
  if (Number.isFinite(y)) g.y.target = clamp(y, 0, GANTRY.travelY);
}
