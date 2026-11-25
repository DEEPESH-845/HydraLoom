import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contrastRatio, visibilityRange, waterDetectability, waterOptics } from "../optics/water";
import { compatibility, PLATFORMS, type PlatformId } from "../platforms";
import { MISSIONS, missionRoute } from "../missions";
import { ENVIRONMENT_LIBRARY, ENVIRONMENT_ORDER, FIELD_ENVIRONMENT_IDS, ntuAt } from "../world/environments";
import { validateEnvironment, type EnvironmentDefinition } from "../world/schema";
import { terrainHeight } from "../world/terrain";
import { mountPose, project } from "./camera";
import { FIELD_DT, FieldEngine } from "./engine";
import { toBox, worldVelocity } from "../physics/vehicle";
import { qFromEuler, qToEuler, headingToYaw, wrapPi } from "../physics/math";
import { approachExtent, lightTerm, pathOptics, runFieldDetection, type TargetInstance } from "./detection";

describe("environment library", () => {
  it("every definition validates", () => {
    for (const id of ENVIRONMENT_ORDER) assert.deepEqual(validateEnvironment(ENVIRONMENT_LIBRARY[id]), [], id);
  });
  it("the validator rejects broken definitions", () => {
    const bad: EnvironmentDefinition = JSON.parse(JSON.stringify(ENVIRONMENT_LIBRARY.harbor));
    bad.water.salinityPsu = 2; // "sea" water that is nearly fresh
    bad.water.ntuRange = [5, 1];
    bad.platforms = ["gantry"];
    bad.targets.push({ ...bad.targets[0] }); // duplicate id
    const paths = validateEnvironment(bad).map((i) => i.path);
    for (const p of ["water.salinityPsu", "water.ntuRange", "platforms", "targets[6].id"]) assert.ok(paths.includes(p), p);
  });
  it("environments are physically distinct, not recolours", () => {
    const sig = (e: EnvironmentDefinition) => JSON.stringify([e.water.type, e.water.optics, e.geometry.terrain.kind, e.light.source, e.seabed.material]);
    const set = new Set(FIELD_ENVIRONMENT_IDS.map((id) => sig(ENVIRONMENT_LIBRARY[id])));
    assert.equal(set.size, FIELD_ENVIRONMENT_IDS.length);
  });
  it("only the Gantry Lab offers the gantry, and no field environment does", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      assert.ok(!ENVIRONMENT_LIBRARY[id].platforms.includes("gantry"), id);
      assert.equal(compatibility(ENVIRONMENT_LIBRARY[id], "gantry").ok, false);
    }
    assert.deepEqual(ENVIRONMENT_LIBRARY["gantry-lab"].platforms, ["gantry"]);
  });
  it("targets sit inside the site and the terrain is deterministic", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const e = ENVIRONMENT_LIBRARY[id];
      for (const t of e.targets) {
        const h1 = terrainHeight(e.geometry.terrain, t.x, t.z);
        assert.equal(h1, terrainHeight(e.geometry.terrain, t.x, t.z));
        assert.ok(h1 < 0, `${id}/${t.id} seabed above the surface`);
      }
    }
  });
});

describe("water optics in the field", () => {
  it("increasing turbidity never improves visibility or contrast", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const e = ENVIRONMENT_LIBRARY[id];
      let prevVis = Infinity;
      let prevC = Infinity;
      for (let t = 0; t <= 1.0001; t += 0.1) {
        const o = waterOptics({ ...e.water.optics, ntu: ntuAt(e, t) });
        const vis = visibilityRange(o.c[1]);
        const c = contrastRatio(o, { pathM: 2, objectDepthM: 5, veilDepthM: 4, backgroundReflectance: e.seabed.reflectance });
        assert.ok(vis <= prevVis + 1e-12 && c <= prevC + 1e-12, `${id} t=${t}`);
        prevVis = vis;
        prevC = c;
      }
    }
  });
  it("contrast falls with path length and stratification adds attenuation inside its layer", () => {
    const e = ENVIRONMENT_LIBRARY.lake;
    const o = waterOptics({ ...e.water.optics, ntu: 2 });
    assert.ok(waterDetectability(contrastRatio(o, { pathM: 1, objectDepthM: 8, veilDepthM: 7 })) > waterDetectability(contrastRatio(o, { pathM: 3, objectDepthM: 8, veilDepthM: 7 })));
    const above = pathOptics(e, 0.1, [0, -2, 0], [0, -3, 0]);
    const inside = pathOptics(e, 0.1, [0, -6.5, 0], [0, -7.5, 0]);
    assert.ok(inside.c[1] > above.c[1]);
  });
  it("lamp light falls with distance; no lamps in the deep sees nothing", () => {
    const e = ENVIRONMENT_LIBRARY.deepsea;
    const o = waterOptics({ ...e.water.optics, ntu: 0.2 });
    assert.ok(lightTerm(e, o, 0.8, 0, 1500, 6) > lightTerm(e, o, 0.8, 0, 1500, 9));
    assert.equal(lightTerm(e, o, 0, 0, 1500, 2), 0);
  });
});

describe("camera projection", () => {
  it("a point on the optical axis projects to the image centre for any mount and attitude", () => {
    const pose = mountPose([1, -5, 2], [0.1, 0.3, -0.2, 0.927], PLATFORMS.rov.camera);
    const n = Math.hypot(0.1, 0.3, -0.2, 0.927);
    const q = [0.1 / n, 0.3 / n, -0.2 / n, 0.927 / n] as [number, number, number, number];
    const c = mountPose([1, -5, 2], q, PLATFORMS.rov.camera);
    const p = project(c, [c.position[0] + c.forward[0] * 3, c.position[1] + c.forward[1] * 3, c.position[2] + c.forward[2] * 3]);
    assert.ok(Math.abs(p.u - 0.5) < 1e-9 && Math.abs(p.v - 0.5) < 1e-9);
    void pose;
  });
  it("image right is +world X and image up is forward for a level downward camera heading north", () => {
    const c = mountPose([0, 0, 0], [0, 0, 0, 1], { ...PLATFORMS.auv.camera, position: [0, 0, 0] });
    // body forward is +X at identity, so the image's up direction points along +X (forward) and right along +Z
    const pr = project(c, [0, -2, 0.5]);
    const pu = project(c, [0.5, -2, 0]);
    assert.ok(pr.u > 0.5 && Math.abs(pr.v - 0.5) < 1e-9);
    assert.ok(pu.v < 0.5 && Math.abs(pu.u - 0.5) < 1e-9);
  });
});

describe("field engine", () => {
  it("every compatible environment and platform pair runs and reports finite telemetry", () => {
    for (const id of FIELD_ENVIRONMENT_IDS)
      for (const p of ["rov", "auv", "station"] as PlatformId[]) {
        if (!compatibility(ENVIRONMENT_LIBRARY[id], p).ok) continue;
        const e = new FieldEngine(id, p);
        assert.equal(e.platform.id, p);
        e.advance(5);
        const t = e.telemetry();
        for (const v of [t.depthM, t.altitudeM, t.headingDeg, t.speedOverGround, t.densityKgM3, t.visibilityM]) assert.ok(Number.isFinite(v), `${id}/${p}`);
      }
  });
  it("an incompatible platform falls back to one the environment supports", () => {
    const e = new FieldEngine("harbor", "auv");
    assert.notEqual(e.platform.id, "auv");
  });
  it("identical configuration and seed give bit-identical runs", () => {
    const run = () => {
      const e = new FieldEngine("river", "rov");
      e.setConditions({ current: { speedMps: 0.6, turbulence: 0.2 } });
      e.startMission();
      e.advance(40);
      return JSON.stringify([e.telemetry(), e.detections, e.events]);
    };
    assert.equal(run(), run());
  });
  it("the current pushes an unpowered-hold-free vehicle; changing it does not change the vehicle's commanded speed", () => {
    const e = new FieldEngine("harbor", "rov");
    e.setConditions({ current: { speedMps: 1.8, headingDeg: 90, turbulence: 0, variability: 0 } });
    e.setPilotMode("MANUAL");
    e.pilotTarget.assist = false;
    const x0 = e.telemetry().position[0];
    e.advance(12); // longer would reach the edge of the site, where the guard holds it
    const t = e.telemetry();
    assert.ok(t.position[0] > x0 + 5, `moved ${t.position[0] - x0}`);
    assert.equal(e.conditions.speedMps, 0.5);
    // water current and vehicle velocity are reported separately
    assert.ok(Math.abs(t.currentSpeed - t.speedOverGround) < 0.5);
    assert.ok(t.speedThroughWater < 0.5);
  });
  it("a free-floating target drifts downstream with the current", () => {
    const e = new FieldEngine("harbor", "rov");
    e.setConditions({ current: { speedMps: 0.6, headingDeg: 90, turbulence: 0, variability: 0 } });
    const drum = () => e.targets.find((t) => t.id === "drum-h1")!.position[0];
    const x0 = drum();
    e.advance(30);
    assert.ok(drum() > x0 + 3);
  });
  it("ROV and AUV missions finish, and the AUV does not touch the seabed", () => {
    const r = new FieldEngine("reef", "rov");
    r.startMission();
    for (let i = 0; i < 400 && r.phase === "RUNNING"; i++) r.advance(1);
    assert.equal(r.phase, "COMPLETE");
    assert.ok(r.result!.targetsFound >= 4, `found ${r.result!.targetsFound}`);
    const a = new FieldEngine("deepsea", "auv");
    a.startMission();
    for (let i = 0; i < 1500 && a.phase === "RUNNING"; i++) a.advance(1);
    assert.equal(a.phase, "COMPLETE");
    assert.equal(a.result!.contacts, 0);
    assert.equal(a.result!.detector, "ANALYTICAL");
  });
  it("detection confidence never rises with turbidity at a fixed pose", () => {
    const e = new FieldEngine("reef", "station");
    const cam = e.cameraPose();
    const targets: TargetInstance[] = e.targets;
    let prev = new Map<string, number>();
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const d = runFieldDetection({ env: e.env, turbidity: t, lighting: 0.9, lamps: 0.5, threshold: 0.3, camera: cam, cameraVelocity: [0, 0, 0], cameraAngularRate: 0, exposureS: 1 / 60, lampReferenceM: 2.5, targets, occlusion: e.occlusion, seed: 1, tick: 0, previous: new Map(), dt: 0.1 });
      const cur = new Map(d.map((x) => [x.targetId, x.confidence]));
      for (const [id, c] of cur) if (prev.has(id)) assert.ok(c <= prev.get(id)! + 1e-12, `${id} rose at t=${t}`);
      for (const id of prev.keys()) if (!cur.has(id)) prev.delete(id);
      prev = cur;
    }
  });
  it("mission routes exist for every listed mission and platform", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const env = ENVIRONMENT_LIBRARY[id];
      for (const m of env.missions) {
        const def = MISSIONS[m as keyof typeof MISSIONS];
        assert.ok(def, `${id}: unknown mission ${m}`);
        for (const p of def.platforms) {
          if (p === "gantry" || p === "station" || !compatibility(env, p).ok) continue;
          const r = missionRoute(def.id, { env, platform: p, start: [0, -3, 0], altitudeM: 2, swathM: 3, speedMps: 0.5 });
          if (def.id !== "calibration") assert.ok(r.length > 0, `${id}/${m}/${p}`);
          for (const w of r) assert.ok(Number.isFinite(w.x) && Number.isFinite(w.z));
        }
      }
    }
  });
});

describe("shipwreck detection (regression: never classified in any field environment)", () => {
  const hover = (env: (typeof FIELD_ENVIRONMENT_IDS)[number], range: number, approachDeg: number) => {
    const e = new FieldEngine(env, "rov");
    const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
    // hover at the survey altitude, `range` off the hull surface, looking at it: what a pilot does by hand
    const a = (approachDeg * Math.PI) / 180;
    const d = approachExtent(w, Math.cos(a), Math.sin(a)) + range;
    const x = w.position[0] - Math.cos(a) * d;
    const z = w.position[2] - Math.sin(a) * d;
    e.vehicle!.position = [x, terrainHeight(e.env.geometry.terrain, x, z) + e.conditions.altitudeM, z];
    e.vehicle!.attitude = qFromEuler(headingToYaw(((Math.atan2(Math.cos(a), -Math.sin(a)) * 180) / Math.PI + 360) % 360), 0, 0);
    e.setPilotMode("HOLD");
    let best = 0;
    let cls = "";
    for (let i = 0; i < 20; i++) {
      e.advance(0.1);
      const f = e.detections.find((q) => q.targetId === w.id);
      if (f && f.confidence > best) [best, cls] = [f.confidence, f.class];
    }
    return { e, best, cls };
  };
  it("a pilot hovering off the hull gets SHIPWRECK in every environment", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const seen = [0, 60, 120, 180, 240, 300].map((a) => hover(id, 0.8, a));
      const named = seen.filter((s) => s.cls === "SHIPWRECK").length;
      assert.ok(named >= 4, `${id}: SHIPWRECK from ${named}/6 approaches, best ${Math.max(...seen.map((s) => s.best)).toFixed(2)}`);
    }
  });
  it("finds made while piloting by hand are logged without a mission running", () => {
    const { e } = hover("harbor", 0.8, 0);
    assert.equal(e.phase, "IDLE");
    assert.ok(e.finds().some((f) => f.trueClass === "SHIPWRECK"));
    assert.ok(e.events.some((v) => v.kind === "DETECT" && v.text.startsWith("SHIPWRECK")));
  });
  it("the ROV detection mission classifies the wreck in every environment at default conditions", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const e = new FieldEngine(id, "rov");
      e.setMission("detection");
      e.startMission();
      // stop on the exact step it completes: nothing seen afterwards may count
      for (let i = 0; i < 1500 * 120 && e.phase === "RUNNING"; i++) e.advance(1 / 120);
      assert.equal(e.phase, "COMPLETE", id);
      const w = e.finds().find((f) => f.trueClass === "SHIPWRECK");
      assert.ok(w?.correct, `${id}: wreck ${w ? `${w.class} ${w.confidence.toFixed(2)}` : "not found"}; found ${e.result!.targetsFound}/${e.result!.targetsTotal}`);
    }
  });
  it("every target can reach its true class in ideal conditions", () => {
    for (const id of FIELD_ENVIRONMENT_IDS)
      for (const t of ENVIRONMENT_LIBRARY[id].targets) assert.ok(t.detectability * (1 - 0.15 * t.burial) >= 0.67, `${id}/${t.id} can never exceed the classify threshold`);
  });
  it("nothing is seen through water far beyond its visibility, at any range", () => {
    const e = new FieldEngine("harbor", "rov");
    e.setConditions({ turbidity: 1 });
    e.setMission("detection");
    e.startMission();
    for (let i = 0; i < 600 && e.phase === "RUNNING"; i++) e.advance(1);
    assert.equal(e.finds().length, 0);
  });
});

describe("navigation stays in the site, off the obstacles, and smooth", () => {
  const drives: [string, Partial<{ surge: number; sway: number; heave: number; yaw: number }>][] = [
    ["forward", { surge: 1 }],
    ["back", { surge: -1 }],
    ["port", { sway: -1 }],
    ["starboard", { sway: 1 }],
    ["up and forward", { surge: 0.5, heave: 1 }],
    ["down and forward", { surge: 1, heave: -1 }],
    ["circling", { surge: 1, yaw: 0.5 }],
  ];
  /** Flies until `seconds`, checking every step. Returns the peak yaw rate. */
  const fly = (e: FieldEngine, seconds: number, label: string) => {
    const b = e.bounds();
    let yaw = 0;
    for (let i = 0; i < seconds * 120; i++) {
      e.advance(FIELD_DT);
      const p = e.vehicle!.position;
      assert.ok(p[0] >= b.x0 && p[0] <= b.x1 && p[2] >= b.z0 && p[2] <= b.z1, `${label}: left the site at ${p.map((v) => v.toFixed(1))}`);
      assert.ok(p[1] <= 0, `${label}: above the surface`);
      assert.ok(p[1] > terrainHeight(e.env.geometry.terrain, p[0], p[2]), `${label}: under the seabed`);
      yaw = Math.max(yaw, Math.abs(e.vehicle!.angularVelocity[1]));
    }
    return yaw;
  };
  it("full stick in every direction never leaves the water of any site", () => {
    for (const id of FIELD_ENVIRONMENT_IDS)
      for (const pf of ["rov", "auv"] as const) {
        if (!compatibility(ENVIRONMENT_LIBRARY[id], pf).ok) continue;
        for (const [name, st] of drives) {
          const e = new FieldEngine(id, pf);
          e.setPilotMode("MANUAL");
          e.setStick(st);
          const yaw = fly(e, id === "ocean" ? 200 : 90, `${id}/${pf} ${name}`);
          assert.ok(yaw < 1.1, `${id}/${pf} ${name}: turns at ${((yaw * 180) / Math.PI).toFixed(0)} deg/s`);
        }
      }
  });
  it("a strong current cannot carry a drifting vehicle out of the site", () => {
    for (const id of FIELD_ENVIRONMENT_IDS)
      for (const headingDeg of [0, 90, 180, 270]) {
        const e = new FieldEngine(id, "rov");
        e.setConditions({ current: { speedMps: 2, headingDeg } });
        e.setPilotMode("MANUAL");
        e.pilotTarget.assist = false;
        fly(e, 60, `${id} current ${headingDeg}`);
      }
  });
  it("every mission stays in the site and inside no target", () => {
    for (const id of FIELD_ENVIRONMENT_IDS)
      for (const pf of ["rov", "auv"] as const) {
        if (!compatibility(ENVIRONMENT_LIBRARY[id], pf).ok) continue;
        for (const m of ENVIRONMENT_LIBRARY[id].missions as (keyof typeof MISSIONS)[]) {
          if (!MISSIONS[m].platforms.includes(pf) || m === "coverage-mapping") continue;
          const e = new FieldEngine(id, pf);
          e.setMission(m);
          e.startMission();
          const b = e.bounds();
          for (let i = 0; i < 1300 * 12 && e.phase === "RUNNING"; i++) {
            e.advance(0.1);
            const p = e.vehicle!.position;
            assert.ok(p[0] >= b.x0 && p[0] <= b.x1 && p[2] >= b.z0 && p[2] <= b.z1, `${id}/${pf}/${m} left the site`);
          }
          assert.equal(e.phase, "COMPLETE", `${id}/${pf}/${m} never finished`);
        }
      }
  });
  it("targets are solid: driving into a wreck stops at the hull, gently, still seeing it", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const e = new FieldEngine(id, "rov");
      e.setConditions({ current: { speedMps: 0 } });
      const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
      const a = Math.PI / 2 - (w.yawDeg * Math.PI) / 180;
      const d = approachExtent(w, Math.cos(a), Math.sin(a)) + 3;
      const x = w.position[0] - Math.cos(a) * d;
      const z = w.position[2] - Math.sin(a) * d;
      // at the height of the hull, not of the ground it starts over (the river bank is higher than its bed)
      const deck = w.position[1] + w.halfExtents[1] * (1 - w.burial);
      e.vehicle!.position = [x, Math.max(deck - 0.1, terrainHeight(e.env.geometry.terrain, x, z) + 0.45), z];
      e.vehicle!.attitude = qFromEuler(Math.atan2(-Math.sin(a), Math.cos(a)), 0, 0);
      e.setPilotMode("MANUAL");
      e.setStick({ surge: 0.2 });
      let seen = false;
      let hit = 0;
      for (let i = 0; i < 25 * 120; i++) {
        const before = Math.hypot(...e.vehicle!.velocity);
        e.advance(FIELD_DT);
        hit = Math.max(hit, before - Math.hypot(...e.vehicle!.velocity));
        const { lx, lz } = toBox({ x: w.position[0], z: w.position[2], yawDeg: w.yawDeg, hx: 0, hz: 0, top: 0 }, e.vehicle!.position[0], e.vehicle!.position[2]);
        const top = w.position[1] + w.halfExtents[1] * (1 - w.burial);
        assert.ok(Math.abs(lx) > w.halfExtents[0] || Math.abs(lz) > w.halfExtents[2] || e.vehicle!.position[1] > top, `${id}: inside the hull`);
        seen ||= e.detections.some((q) => q.class === "SHIPWRECK");
      }
      assert.ok(seen, `${id}: never classified on the way in`);
      assert.ok(hit < 0.06, `${id}: lost ${hit.toFixed(2)} m/s in one step, a collision`);
    }
  });
  it("sticks ramp: full ahead does not jolt, and releasing it glides", () => {
    const e = new FieldEngine("ocean", "rov");
    e.setConditions({ current: { speedMps: 0 } });
    e.setPilotMode("MANUAL");
    e.advance(2);
    e.setStick({ surge: 1, yaw: 1 });
    let prev = e.vehicle!.velocity[0];
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      e.advance(FIELD_DT);
      peak = Math.max(peak, Math.abs(e.vehicle!.velocity[0] - prev) / FIELD_DT);
      prev = e.vehicle!.velocity[0];
    }
    assert.ok(peak < 2.5, `accelerates at ${peak.toFixed(1)} m/s2`);
  });
});

describe("finding the wreck by hand", () => {
  /** Hovers the ROV facing the wreck from 12 sides, `gap` from its box and `h` above the ground; what it reads after 4 s. */
  const around = (id: (typeof FIELD_ENVIRONMENT_IDS)[number], gap: number, h: number) =>
    Array.from({ length: 12 }, (_, i) => {
      const e = new FieldEngine(id, "rov");
      e.setConditions({ current: { speedMps: 0 } });
      const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
      const a = (i * Math.PI) / 6;
      const d = approachExtent(w, Math.cos(a), Math.sin(a)) + gap;
      const x = w.position[0] + Math.cos(a) * d;
      const z = w.position[2] + Math.sin(a) * d;
      e.vehicle!.position = [x, e.floor(x, z) + h + 0.15, z];
      e.vehicle!.attitude = qFromEuler(Math.atan2(Math.sin(a), -Math.cos(a)), 0, 0);
      e.setPilotMode("MANUAL");
      e.advance(4);
      return e.detections.find((q) => q.targetId === w.id)?.class ?? "none";
    });
  it("in clear water it is named from every side, low or high, several metres off; in murk as far as the water allows", () => {
    const cases: [(typeof FIELD_ENVIRONMENT_IDS)[number], number, number, number][] = [
      ["ocean", 5, 0.5, 12], ["ocean", 5, 3, 12], ["deepsea", 3, 0.5, 12], ["deepsea", 3, 2, 12], ["reef", 3, 0.5, 12], ["reef", 3, 3, 12],
      ["lake", 2, 0.5, 11], ["lake", 2, 1.5, 11], ["harbor", 1.5, 0.5, 11], ["harbor", 1, 1, 11], ["river", 1, 0.5, 9], ["river", 0.6, 0.8, 9],
    ];
    for (const [id, gap, h, least] of cases) {
      const r = around(id, gap, h);
      const n = r.filter((c) => c === "SHIPWRECK").length;
      assert.ok(n >= least, `${id} ${gap} m off, ${h} m up: ${n}/12 (${r.join(" ")})`);
    }
  });
  it("is not seen through murk: nothing past the visibility", () => {
    for (const id of ["harbor", "river", "lake"] as const) assert.deepEqual([...new Set(around(id, 5, 1))], ["none"], id);
  });
  it("flying at it and over it, the camera keeps it and the label holds", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const e = new FieldEngine(id, "rov");
      e.setConditions({ current: { speedMps: 0 } });
      const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
      const a = Math.PI / 2 - (w.yawDeg * Math.PI) / 180;
      const d = approachExtent(w, Math.cos(a), Math.sin(a)) + 3;
      const x = w.position[0] - Math.cos(a) * d;
      const z = w.position[2] - Math.sin(a) * d;
      const deck = w.position[1] + w.halfExtents[1] * (1 - w.burial);
      e.vehicle!.position = [x, Math.min(-0.4, deck + 0.5), z];
      e.vehicle!.attitude = qFromEuler(Math.atan2(-Math.sin(a), Math.cos(a)), 0, 0);
      e.setPilotMode("MANUAL");
      e.setStick({ surge: 0.35 });
      const labels: string[] = [];
      for (let i = 0; i < 100; i++) {
        e.advance(0.1);
        const q = e.detections.find((f) => f.targetId === w.id);
        if (q) labels.push(q.class);
      }
      const named = labels.indexOf("SHIPWRECK");
      assert.ok(named >= 0, `${id}: never named`);
      assert.ok(labels.slice(named).filter((c) => c !== "SHIPWRECK").length <= 3, `${id}: label lost (${labels.join(" ")})`);
    }
  });
});

describe("manual flight", () => {
  const ground = (e: FieldEngine) => {
    const v = worldVelocity(e.vehicle!);
    return Math.hypot(v[0], v[2]);
  };
  const from = (e: FieldEngine, p: number[]) => Math.hypot(e.vehicle!.position[0] - p[0], e.vehicle!.position[1] - p[1], e.vehicle!.position[2] - p[2]);
  it("untouched sticks keep station in the default current of every site", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const e = new FieldEngine(id, "rov");
      e.setPilotMode("MANUAL");
      const p = [...e.vehicle!.position];
      e.advance(30);
      // the river gusts past the thrusters (1.1 m/s); it gives way by the leash at most
      assert.ok(from(e, p) < (id === "river" ? 0.6 : 0.25), `${id}: drifted ${from(e, p).toFixed(2)} m`);
    }
  });
  it("answers quickly, flies the commanded speed, and stops and stays when released", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const e = new FieldEngine(id, "rov");
      e.setConditions({ current: { speedMps: 0.3, turbulence: 0.05 } });
      e.setPilotMode("MANUAL");
      e.advance(2);
      e.setStick({ surge: 0.6 });
      e.advance(0.6);
      const v = ground(e);
      assert.ok(v > 0.45 && v < 0.62, `${id}: ${v.toFixed(2)} m/s 0.6 s after 60 percent stick (0.54 commanded)`);
      e.setStick({ surge: 0 });
      const p = [...e.vehicle!.position];
      e.advance(1);
      assert.ok(ground(e) < 0.06, `${id}: still moving at ${ground(e).toFixed(2)} m/s a second after release`);
      assert.ok(from(e, p) < 0.3, `${id}: stopped in ${from(e, p).toFixed(2)} m`);
      const q = [...e.vehicle!.position];
      e.advance(30);
      assert.ok(from(e, q) < 0.12, `${id}: wandered ${from(e, q).toFixed(2)} m`);
    }
  });
  it("yaw and heave stop where they are released", () => {
    const e = new FieldEngine("harbor", "rov");
    e.setPilotMode("MANUAL");
    e.setStick({ yaw: 1, heave: 1 });
    e.advance(1.5);
    e.setStick({ yaw: 0, heave: 0 });
    const yaw = () => qToEuler(e.vehicle!.attitude).yaw;
    const h = yaw();
    const y = e.vehicle!.position[1];
    e.advance(5);
    assert.ok(Math.abs(wrapPi(yaw() - h)) < 0.14, `turned on by ${Math.abs(wrapPi(yaw() - h)).toFixed(2)} rad`);
    assert.ok(Math.abs(e.vehicle!.position[1] - y) < 0.15, `rose on by ${(e.vehicle!.position[1] - y).toFixed(2)} m`);
  });
  it("a current above its thrust pushes it, and it does not race back when the water calms", () => {
    const e = new FieldEngine("ocean", "rov");
    e.setConditions({ current: { speedMps: 1.8, headingDeg: 90, turbulence: 0, variability: 0 } });
    e.setPilotMode("MANUAL");
    const p = [...e.vehicle!.position];
    e.advance(10);
    assert.ok(from(e, p) > 2, "thrusters cannot hold it");
    const q = [...e.vehicle!.position];

    e.setConditions({ current: { speedMps: 0 } });
    e.advance(20);
    assert.ok(from(e, q) < 1, `moved ${from(e, q).toFixed(2)} m after it calmed`);
  });
  it("Hold at full speed stops within its braking distance and does not come back", () => {
    const e = new FieldEngine("harbor", "rov");
    e.setPilotMode("MANUAL");
    e.setStick({ surge: 1 });
    e.advance(2);
    const p = [...e.vehicle!.position];
    e.setPilotMode("HOLD");
    let far = 0;
    for (let i = 0; i < 100; i++) {
      e.advance(0.1);
      far = Math.max(far, from(e, p));
    }
    assert.ok(far < 0.6 && far - from(e, p) < 0.1, `${far.toFixed(2)} m, rests at ${from(e, p).toFixed(2)} m`);
  });
  it("a stick left over from manual flight does not take off again, and an AUV brakes", () => {
    const e = new FieldEngine("ocean", "rov");
    e.setPilotMode("MANUAL");
    e.setStick({ surge: 1 });
    e.setPilotMode("HOLD");
    e.advance(5);
    e.setPilotMode("MANUAL");
    const p = [...e.vehicle!.position];
    e.advance(5);
    assert.ok(from(e, p) < 0.1);
    const a = new FieldEngine("lake", "auv");
    a.setConditions({ current: { speedMps: 0 } });
    a.setPilotMode("MANUAL");
    a.setStick({ surge: 1 });
    a.advance(6);
    a.setStick({ surge: 0 });
    a.advance(8);
    assert.ok(ground(a) < 0.15, `AUV still at ${ground(a).toFixed(2)} m/s`);
  });
});

describe("detection while moving", () => {
  it("guided detection classifies nearly every target, ROV and AUV", () => {
    const floor: Record<string, number> = { "river/rov": 4, "ocean/auv": 4 };
    for (const id of FIELD_ENVIRONMENT_IDS)
      for (const pf of ["rov", "auv"] as const) {
        if (!compatibility(ENVIRONMENT_LIBRARY[id], pf).ok) continue;
        const e = new FieldEngine(id, pf);
        e.setMission("detection");
        e.startMission();
        for (let i = 0; i < 1300 * 120 && e.phase === "RUNNING"; i++) e.advance(FIELD_DT);
        const right = e.finds().filter((f) => f.correct).length;
        assert.ok(right >= (floor[`${id}/${pf}`] ?? e.targets.length - 1), `${id}/${pf}: ${right}/${e.targets.length} classified`);
        assert.ok(e.finds().some((f) => f.class === "SHIPWRECK"), `${id}/${pf}: wreck`);
        assert.equal(e.result!.contacts <= 2, true, `${id}/${pf}: ${e.result!.contacts} contacts`);
      }
  });
  it("a track survives a fast glance away and its label does not flicker", () => {
    const e = new FieldEngine("reef", "rov");
    e.setConditions({ current: { speedMps: 0 } });
    const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
    const d = approachExtent(w, 1, 0) + 2.5;
    const x = w.position[0] - d;
    e.vehicle!.position = [x, terrainHeight(e.env.geometry.terrain, x, w.position[2]) + 2, w.position[2]];
    e.vehicle!.attitude = qFromEuler(0, 0, 0);
    e.setPilotMode("HOLD");
    e.advance(2);
    const labels = new Set<string>();
    let gaps = 0;
    e.setPilotMode("MANUAL");
    for (let i = 0; i < 60; i++) {
      // look left and right, up to full yaw rate, wreck always in the picture
      e.setStick({ yaw: Math.sin(i / 4) * 0.5 });
      e.advance(0.1);
      const q = e.detections.find((f) => f.targetId === w.id);
      if (q) labels.add(q.class);
      else gaps++;
    }
    assert.deepEqual([...labels], ["SHIPWRECK"]);
    assert.equal(gaps, 0, `${gaps} of 60 readings lost`);
  });
  it("a pipeline far longer than the picture is detected by the segment in view", () => {
    const e = new FieldEngine("ocean", "auv");
    e.setMission("pipeline-inspection");
    e.startMission();
    for (let i = 0; i < 300 * 120 && e.phase === "RUNNING"; i++) e.advance(FIELD_DT);
    assert.ok(e.finds().some((f) => f.class === "PIPELINE"));
  });
});
