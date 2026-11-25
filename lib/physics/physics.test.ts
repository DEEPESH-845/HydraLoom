import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuvPilot, RovPilot, lawnmower, type PilotTarget } from "./autopilot";
import { CurrentField, DEFAULT_CURRENT, sanitizeCurrent } from "./current";
import { headingToYaw, headingVector, qFromEuler, qRotate, qToEuler, yawToHeading } from "./math";
import { waterDensity } from "./seawater";
import { VEHICLES, ballastFor, createVehicleState, netWeight, stepVehicle, worldVelocity, zeroCommand } from "./vehicle";

const SEA = { temperatureC: 15, salinityPsu: 35, depthM: 5 };
const FRESH = { temperatureC: 15, salinityPsu: 0, depthM: 5 };
const DT = 1 / 120;
const flat = { bed: () => -50, cylinders: [] };

describe("frames and conventions", () => {
  it("heading 090 points east (+X), 000 north (-Z)", () => {
    const e = headingVector(90);
    assert.ok(Math.abs(e[0] - 1) < 1e-12 && Math.abs(e[2]) < 1e-12);
    const n = headingVector(0);
    assert.ok(Math.abs(n[2] + 1) < 1e-12);
  });
  it("heading and yaw round-trip, and body forward follows heading", () => {
    for (const h of [0, 45, 90, 180, 270, 359]) {
      assert.ok(Math.abs(((yawToHeading(headingToYaw(h)) - h + 540) % 360) - 180) < 1e-9);
      const f = qRotate(qFromEuler(headingToYaw(h), 0, 0), [1, 0, 0]);
      const v = headingVector(h);
      assert.ok(Math.hypot(f[0] - v[0], f[1] - v[1], f[2] - v[2]) < 1e-9);
    }
  });
  it("euler round-trip", () => {
    const e = qToEuler(qFromEuler(0.7, 0.2, -0.3));
    assert.ok(Math.abs(e.yaw - 0.7) < 1e-9 && Math.abs(e.pitch - 0.2) < 1e-9 && Math.abs(e.roll + 0.3) < 1e-9);
  });
});

describe("current field", () => {
  const quiet = { ...DEFAULT_CURRENT, turbulence: 0, variability: 0 };
  it("a 090 current flows toward +X at the reference height", () => {
    const f = new CurrentField({ ...quiet, speedMps: 0.5, headingDeg: 90, profile: "log", roughnessM: 1e-3, referenceHeightM: 1 }, () => 0);
    const v = f.sample([0, 1, 0], 0);
    assert.ok(Math.abs(v[0] - 0.5) < 1e-9 && Math.abs(v[2]) < 1e-9);
  });
  it("log profile: zero at the bed, increasing with height", () => {
    const f = new CurrentField({ ...quiet, speedMps: 0.5 }, () => 0);
    let prev = -1;
    for (const z of [0, 0.01, 0.1, 0.5, 1, 2, 5]) {
      const u = f.sample([0, z, 0], 0)[0];
      assert.ok(u >= prev - 1e-12, `non-monotonic at ${z}`);
      prev = u;
    }
    assert.equal(f.sample([0, 0, 0], 0)[0], 0);
  });
  it("channel profile is zero at the banks and maximal on the centreline", () => {
    const f = new CurrentField({ ...quiet, speedMps: 1, profile: "uniform", channel: { axis: "x", centre: 0, halfWidth: 10 } }, () => 0);
    assert.equal(f.sample([0, 1, 10], 0)[0], 0);
    assert.ok(f.sample([0, 1, 0], 0)[0] > f.sample([0, 1, 7], 0)[0]);
  });
  it("potential flow around a cylinder matches U (1 + R^2 / r^2) abeam and stagnates upstream", () => {
    const f = new CurrentField({ ...quiet, speedMps: 0.4, profile: "uniform", obstacles: [{ x: 0, z: 0, radius: 0.5 }] }, () => 0);
    // flow toward +X; abeam is +-Z, upstream is -X
    const side = f.sample([0, 1, 0.8], 0);
    assert.ok(Math.abs(side[0] - 0.4 * (1 + 0.25 / 0.64)) < 1e-9);
    const up = f.sample([-0.5001, 1, 0], 0);
    assert.ok(Math.abs(up[0]) < 1e-3);
    assert.deepEqual(f.sample([0.1, 1, 0], 0), [0, 0, 0]); // inside the solid
  });
  it("turbulence is divergence-free and has the configured horizontal RMS", () => {
    const f = new CurrentField({ ...DEFAULT_CURRENT, speedMps: 0.5, turbulence: 0.1, profile: "uniform", variability: 0 }, () => 0);
    const h = 1e-4;
    let maxDiv = 0;
    let sq = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const p: [number, number, number] = [i * 0.371, 3 + (i % 7) * 0.13, i * 0.713];
      const t = i * 0.05;
      const dx = (f.sample([p[0] + h, p[1], p[2]], t)[0] - f.sample([p[0] - h, p[1], p[2]], t)[0]) / (2 * h);
      const dy = (f.sample([p[0], p[1] + h, p[2]], t)[1] - f.sample([p[0], p[1] - h, p[2]], t)[1]) / (2 * h);
      const dz = (f.sample([p[0], p[1], p[2] + h], t)[2] - f.sample([p[0], p[1], p[2] - h], t)[2]) / (2 * h);
      if (i < 200) maxDiv = Math.max(maxDiv, Math.abs(dx + dy + dz));
      sq += (f.sample(p, t)[2]) ** 2;
    }
    assert.ok(maxDiv < 1e-5, `divergence ${maxDiv}`);
    const rms = Math.sqrt(sq / n);
    assert.ok(Math.abs(rms - 0.05) < 0.012, `cross-flow RMS ${rms}`);
  });
  it("is deterministic for a seed and sanitises bad input", () => {
    const a = new CurrentField({ ...DEFAULT_CURRENT, speedMps: 0.3, turbulence: 0.2 }, () => 0).sample([1, 2, 3], 4);
    const b = new CurrentField({ ...DEFAULT_CURRENT, speedMps: 0.3, turbulence: 0.2 }, () => 0).sample([1, 2, 3], 4);
    assert.deepEqual(a, b);
    const s = sanitizeCurrent({ speedMps: NaN, headingDeg: -90, turbulence: 9 });
    assert.equal(s.speedMps, DEFAULT_CURRENT.speedMps);
    assert.equal(s.headingDeg, 270);
    assert.equal(s.turbulence, 0.5);
  });
});

describe("water", () => {
  it("fresh water is less dense than sea water, density rises with depth and falls with temperature", () => {
    assert.ok(waterDensity(FRESH) < waterDensity(SEA));
    assert.ok(waterDensity({ ...SEA, depthM: 1500 }) > waterDensity(SEA));
    assert.ok(waterDensity({ ...SEA, temperatureC: 25 }) < waterDensity(SEA));
    assert.ok(Math.abs(waterDensity({ temperatureC: 15, salinityPsu: 0, depthM: 0 }) - 999.1) < 1);
    assert.ok(Math.abs(waterDensity({ temperatureC: 15, salinityPsu: 35, depthM: 0 }) - 1025.9) < 1);
  });
});

describe("vehicle dynamics", () => {
  it("hydrodynamic drag opposes motion relative to the water", () => {
    const s = createVehicleState([0, -5, 0]);
    s.velocity = [0.6, 0, 0];
    const w = stepVehicle(VEHICLES.rov, s, zeroCommand(), { water: SEA, current: [0, 0, 0], surfaceY: 0 }, flat, DT);
    assert.ok(w.damping[0] < 0);
    // same over-ground speed, water moving faster in the same direction: drag pushes forward
    const s2 = createVehicleState([0, -5, 0]);
    s2.velocity = [0.6, 0, 0];
    const w2 = stepVehicle(VEHICLES.rov, s2, zeroCommand(), { water: SEA, current: [1.0, 0, 0], surfaceY: 0 }, flat, DT);
    assert.ok(w2.damping[0] > 0);
  });
  it("an unpowered vehicle drifts toward the water velocity, not past it", () => {
    const s = createVehicleState([0, -5, 0]);
    let maxU = 0;
    for (let i = 0; i < 120 * 40; i++) {
      stepVehicle(VEHICLES.rov, s, zeroCommand(), { water: SEA, current: [0.4, 0, 0], surfaceY: 0 }, flat, DT);
      maxU = Math.max(maxU, worldVelocity(s)[0]);
    }
    assert.ok(Math.abs(worldVelocity(s)[0] - 0.4) < 0.01);
    assert.ok(maxU <= 0.4 + 1e-6, `overshoot ${maxU}`);
  });
  it("top speed is bounded by thrust against quadratic drag", () => {
    // full surge through the pilot, which keeps the frame level (an open frame is pitch-unstable at speed from the
    // Munk moment of its added mass, as the dynamics model says; pilots always hold attitude)
    const s = createVehicleState([0, -5, 0]);
    const pilot = new RovPilot();
    const t: PilotTarget = { mode: "MANUAL", stick: { surge: 1, sway: 0, heave: 0, yaw: 0 }, hold: { x: 0, y: -5, z: 0 }, route: [], speed: 0.5, assist: false };
    for (let i = 0; i < 120 * 30; i++) stepVehicle(VEHICLES.rov, s, pilot.update(VEHICLES.rov, s, t, () => -50, DT), { water: SEA, current: [0, 0, 0], surfaceY: 0 }, flat, DT);
    const p = VEHICLES.rov;
    // steady state: F = Dl u + Dq u^2
    const u = (-p.dampLin[0] + Math.sqrt(p.dampLin[0] ** 2 + 4 * p.dampLinQ[0] * p.maxForce[0])) / (2 * p.dampLinQ[0]);
    assert.ok(Math.abs(s.velocity[0] - u) < 0.01, `${s.velocity[0]} vs ${u}`);
  });
  it("a vehicle trimmed for sea water sinks in fresh water; re-ballasting restores the margin", () => {
    const rho = waterDensity(FRESH);
    assert.ok(netWeight(VEHICLES.rov, rho) > 0);
    assert.ok(netWeight(VEHICLES.rov, waterDensity(SEA)) < 0);
    const b = ballastFor(VEHICLES.rov, rho);
    assert.ok(netWeight(b, rho) < 0);
  });
  it("stays out of the seabed and solid cylinders", () => {
    const s = createVehicleState([0, -9.5, 0]);
    const c = zeroCommand();
    c.force = [1, -1, 0];
    const col = { bed: () => -10, cylinders: [{ x: 2, z: 0, radius: 0.5 }] };
    for (let i = 0; i < 120 * 10; i++) stepVehicle(VEHICLES.rov, s, c, { water: SEA, current: [0, 0, 0], surfaceY: 0 }, col, DT);
    assert.ok(s.position[1] - VEHICLES.rov.halfExtents[1] >= -10 - 1e-6);
    assert.ok(Math.hypot(s.position[0] - 2, s.position[2]) >= 0.5 + Math.max(VEHICLES.rov.halfExtents[0], VEHICLES.rov.halfExtents[2]) - 1e-6);
  });
  it("is deterministic", () => {
    const run = () => {
      const s = createVehicleState([0, -5, 0]);
      const pilot = new RovPilot();
      const t: PilotTarget = { mode: "WAYPOINTS", stick: { surge: 0, sway: 0, heave: 0, yaw: 0 }, hold: { x: 0, y: -5, z: 0 }, route: [{ x: 5, y: -6, z: 2 }], speed: 0.5, assist: true };
      const f = new CurrentField({ ...DEFAULT_CURRENT, speedMps: 0.3, turbulence: 0.2 }, () => -50);
      for (let i = 0; i < 120 * 20; i++) {
        const cmd = pilot.update(VEHICLES.rov, s, t, () => -50, DT);
        stepVehicle(VEHICLES.rov, s, cmd, { water: SEA, current: f.sample(s.position, i * DT), surfaceY: 0 }, flat, DT);
      }
      return s.position;
    };
    assert.deepEqual(run(), run());
  });
});

describe("autopilots", () => {
  it("ROV holds station within 5 cm in a 0.4 m/s cross current", () => {
    const s = createVehicleState([0, -5, 0]);
    const pilot = new RovPilot();
    const t: PilotTarget = { mode: "HOLD", stick: { surge: 0, sway: 0, heave: 0, yaw: 0 }, hold: { x: 0, y: -5, z: 0, headingDeg: 0 }, route: [], speed: 0.5, assist: true };
    let err = 0;
    for (let i = 0; i < 120 * 60; i++) {
      const cmd = pilot.update(VEHICLES.rov, s, t, () => -50, DT);
      stepVehicle(VEHICLES.rov, s, cmd, { water: SEA, current: [0.4, 0, 0], surfaceY: 0 }, flat, DT);
      if (i > 120 * 30) err = Math.max(err, Math.hypot(s.position[0], s.position[1] + 5, s.position[2]));
    }
    assert.ok(err < 0.05, `station error ${err}`);
  });
  it("ROV cannot hold station when the current exceeds its thrust", () => {
    const s = createVehicleState([0, -5, 0]);
    const pilot = new RovPilot();
    const t: PilotTarget = { mode: "HOLD", stick: { surge: 0, sway: 0, heave: 0, yaw: 0 }, hold: { x: 0, y: -5, z: 0, headingDeg: 0 }, route: [], speed: 0.5, assist: false };
    for (let i = 0; i < 120 * 30; i++) {
      const cmd = pilot.update(VEHICLES.rov, s, t, () => -50, DT);
      stepVehicle(VEHICLES.rov, s, cmd, { water: SEA, current: [1.6, 0, 0], surfaceY: 0 }, flat, DT);
    }
    assert.ok(s.position[0] > 5, `drifted only ${s.position[0]} m`);
  });
  it("AUV flies a lawnmower survey in a cross current and finishes", () => {
    const s = createVehicleState([0, -20, 0], qFromEuler(headingToYaw(90), 0, 0));
    s.velocity = [1.5, 0, 0];
    const pilot = new AuvPilot();
    const route = lawnmower({ x0: 0, z0: 0, x1: 80, z1: 30 }, 15, 0, -20);
    const t: PilotTarget = { mode: "WAYPOINTS", stick: { surge: 0, sway: 0, heave: 0, yaw: 0 }, hold: { x: 0, y: -20, z: 0 }, route, speed: 1.5, assist: true };
    let i = 0;
    let maxDepthErr = 0;
    for (; i < 120 * 600 && !pilot.status.done; i++) {
      const cmd = pilot.update(VEHICLES.auv, s, t, () => -60, DT);
      stepVehicle(VEHICLES.auv, s, cmd, { water: SEA, current: [0, 0, 0.2], surfaceY: 0 }, { bed: () => -60, cylinders: [] }, DT);
      if (i > 120 * 20) maxDepthErr = Math.max(maxDepthErr, Math.abs(s.position[1] + 20));
    }
    assert.ok(pilot.status.done, "route not finished");
    assert.ok(maxDepthErr < 1.5, `depth error ${maxDepthErr}`);
  });
});
