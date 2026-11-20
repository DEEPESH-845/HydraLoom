import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contrastRatio, visibilityRange, waterDetectability, waterOptics } from "../optics/water";
import { compatibility, PLATFORMS, type PlatformId } from "../platforms";
import { MISSIONS, missionRoute } from "../missions";
import { ENVIRONMENT_LIBRARY, ENVIRONMENT_ORDER, FIELD_ENVIRONMENT_IDS, ntuAt } from "../world/environments";
import { validateEnvironment, type EnvironmentDefinition } from "../world/schema";
import { terrainHeight } from "../world/terrain";
import { mountPose, project } from "./camera";
import { FieldEngine } from "./engine";
import { lightTerm, pathOptics, runFieldDetection, type TargetInstance } from "./detection";

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
    assert.ok(lightTerm(e, o, 0.8, 0, 1500, 2) > lightTerm(e, o, 0.8, 0, 1500, 4));
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
    const x0 = e.telemetry().position[0];
    e.advance(20);
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
          const r = missionRoute(def.id, { env, platform: p, start: [0, -3, 0], altitudeM: 2, swathM: 3 });
          if (def.id !== "calibration") assert.ok(r.length > 0, `${id}/${m}/${p}`);
          for (const w of r) assert.ok(Number.isFinite(w.x) && Number.isFinite(w.z));
        }
      }
    }
  });
});
