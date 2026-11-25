import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { waterOptics } from "../optics/water";
import { compatibility, type PlatformId } from "../platforms";
import { CurrentField, DEFAULT_CURRENT } from "../physics/current";
import { waterDensity } from "../physics/seawater";
import { mulberry32 } from "../sim/rng";
import { ENVIRONMENT_LIBRARY, FIELD_ENVIRONMENT_IDS } from "../world/environments";
import { validateEnvironment } from "../world/schema";
import { FieldEngine, workingRangeFor } from "./engine";
import { DEFAULT_SUN_DEG, PRESETS, SITE_KEYS, SITE_SPEC, breakingHeight, checkConditions, defaultSite, effectiveEnv, freezingPoint, maxWaterSpeed, sanitizeSite, sunFactor, underwaterMu0, waveNumber, type SiteParams } from "./site";
import { SWEEP_PARAMS, envelope, runSweep, sweepValues } from "./sweep";

const base = (id: (typeof FIELD_ENVIRONMENT_IDS)[number]) => ({ env: ENVIRONMENT_LIBRARY[id], site: defaultSite(ENVIRONMENT_LIBRARY[id], "rov") });
const reach = (id: (typeof FIELD_ENVIRONMENT_IDS)[number], patch: Partial<SiteParams>, c = { turbidity: 0.15, lighting: 0.8, lamps: 0.5 }) => {
  const { env, site } = base(id);
  return workingRangeFor(effectiveEnv(env, sanitizeSite(env, patch, site)), "rov", c);
};

describe("site parameters", () => {
  it("the defaults are the library environment: same water, same run, bit for bit", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const { env, site } = base(id);
      const e = effectiveEnv(env, site);
      assert.deepEqual(e.water.optics, env.water.optics, id);
      assert.equal(e.light.sunFactor, 1, id);
      assert.equal(e.water.type, env.water.type, id);
      assert.deepEqual(validateEnvironment(e), [], id);
    }
    const run = (touch: boolean) => {
      const e = new FieldEngine("reef", "rov");
      if (touch) e.setConditions({ site: { ...e.conditions.site } });
      e.startMission();
      e.advance(30);
      return JSON.stringify([e.telemetry(), e.detections]);
    };
    assert.equal(run(true), run(false));
  });
  it("more attenuation or haze never lengthens the working range; dissolved organics darken and shorten the view", () => {
    for (const id of ["harbor", "reef", "lake"] as const)
      for (const [k, values] of [["cPerNtu", [0.3, 1, 2]], ["backscatterRatio", [0.005, 0.02, 0.04]]] as const) {
        let prev = Infinity;
        for (const v of values) {
          const r = reach(id, { [k]: v });
          assert.ok(r <= prev + 1e-9, `${id} ${k}=${v}: ${r} > ${prev}`);
          prev = r;
        }
      }
    // absorption also darkens the veil, so a little of it can help contrast in silt; it always costs light and range to black
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const { env, site } = base(id);
      const at = (cdom440: number) => waterOptics({ ...effectiveEnv(env, { ...site, cdom440 }).water.optics, ntu: 2 });
      for (let i = 0; i < 3; i++) assert.ok(at(2).c[i] > at(0.1).c[i] && at(2).kd[i] > at(0.1).kd[i], id);
    }
    for (const id of ["reef", "ocean", "lake"] as const) assert.ok(reach(id, { cdom440: 5 }) < reach(id, { cdom440: 0.01 }), id);
    assert.ok(reach("harbor", { cPerNtu: 0.3 }) > reach("harbor", { cPerNtu: 2 }) * 1.5);
  });
  it("a brighter seabed shows targets through haze; a low sun dims the daylight", () => {
    assert.ok(reach("harbor", { seabedReflectance: 0.5 }) >= reach("harbor", { seabedReflectance: 0.05 }));
    assert.equal(sunFactor(0), 0);
    assert.ok(Math.abs(sunFactor(DEFAULT_SUN_DEG) - 1) < 1e-12);
    assert.ok(Math.abs(underwaterMu0(DEFAULT_SUN_DEG) - 0.87) < 5e-4);
    let prev = -1;
    for (let d = 0; d <= 90; d += 5) {
      assert.ok(sunFactor(d) > prev);
      prev = sunFactor(d);
    }
    // a low sun is enough for a camera in the shallows; deep down it is not
    const dark = reach("ocean", { sunElevationDeg: 2 }, { turbidity: 0.15, lighting: 0.05, lamps: 0 });
    assert.ok(dark < reach("ocean", { sunElevationDeg: 60 }, { turbidity: 0.15, lighting: 0.05, lamps: 0 }));
  });
  it("temperature and salinity reach the density, and auto ballast keeps the vehicle neutral through both", () => {
    const e = new FieldEngine("harbor", "rov");
    const rho0 = e.telemetry().densityKgM3;
    e.setConditions({ site: { salinityPsu: 5, temperatureC: 25 } });
    const t = e.telemetry();
    assert.ok(t.densityKgM3 < rho0 - 15);
    assert.ok(Math.abs(t.densityKgM3 - waterDensity({ temperatureC: 25, salinityPsu: 5, depthM: t.depthM })) < 1e-6);
    assert.ok(Math.abs(t.netBuoyancyN) < 3, `net ${t.netBuoyancyN}`);
    e.setConditions({ ballast: "sea" });
    assert.ok(e.telemetry().netBuoyancyN < -1, "trimmed for the sea, it sinks in fresher water");
  });
  it("burial and growth lower the confidence of every target, never raise it", () => {
    const e = new FieldEngine("reef", "rov");
    const before = e.targets.map((t) => ({ ...t }));
    e.setConditions({ site: { extraBurial: 0.5, fouling: 0.8 } });
    e.targets.forEach((t, i) => {
      assert.ok(t.burial > before[i].burial && t.burial <= 1);
      assert.ok(t.detectability < before[i].detectability);
    });
    e.reset();
    assert.ok(e.targets[0].burial > before[0].burial, "survives a reset");
  });
  it("a longer exposure gathers light and smears motion; a shorter one the reverse", () => {
    const see = (exposureS: number, speed: number) => {
      const e = new FieldEngine("deepsea", "rov");
      e.setConditions({ lighting: 0.06, current: { speedMps: 0 }, site: { exposureS }, threshold: 0.3 });
      const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
      e.vehicle!.position = [w.position[0] - 4.2, w.position[1] + 1.6, w.position[2]];
      e.vehicle!.attitude = [0, 0, 0, 1];
      e.vehicle!.velocity = [0, 0, speed];
      e.advance(0.11);
      return e.detections.find((d) => d.targetId === w.id)?.confidence ?? 0;
    };
    assert.ok(see(1 / 30, 0) > see(1 / 500, 0), "more light when still");
    assert.ok(see(1 / 30, 0) - see(1 / 30, 0.9) > see(1 / 500, 0) - see(1 / 500, 0.9), "more smear when moving");
  });
  it("impossible combinations cannot be set", () => {
    const { env, site } = base("reef");
    const s = sanitizeSite(env, { temperatureC: -5, salinityPsu: 10, waveHeightM: 100, wavePeriodS: 3, cdom440: NaN, particleAlbedo: 7, waveHeadingDeg: -30, layerDepthM: 1e6 }, site);
    assert.ok(s.temperatureC >= freezingPoint(10));
    assert.ok(s.waveHeightM <= breakingHeight(3, env.geometry.terrain.depthM) + 1e-9);
    assert.equal(s.cdom440, site.cdom440);
    assert.equal(s.particleAlbedo, SITE_SPEC.particleAlbedo.max);
    assert.equal(s.waveHeadingDeg, 330);
    assert.ok(s.layerDepthM <= env.geometry.terrain.depthM);
    const e = new FieldEngine("river", "rov");
    e.setConditions({ site: { waveHeightM: 6 } });
    assert.ok(e.conditions.site.waveHeightM < 3.2);
  });
});

describe("waves", () => {
  const field = (heightM: number, periodS: number, depthM: number) => new CurrentField({ ...DEFAULT_CURRENT, speedMps: 0, turbulence: 0, waves: { heightM, periodS, headingDeg: 90, depthM, k: waveNumber(periodS, depthM) } }, () => -depthM);
  it("satisfy the dispersion relation", () => {
    for (const [T, h] of [[4, 2], [8, 10], [12, 60], [3, 100]]) {
      const k = waveNumber(T, h);
      assert.ok(Math.abs(9.80665 * k * Math.tanh(k * h) - ((2 * Math.PI) / T) ** 2) < 1e-8);
    }
  });
  it("move the bed water at pi H / (T sinh kh), along their heading, with zero mean, and no vertical flow through the bed", () => {
    const [H, T, h] = [1.2, 10, 9];
    const f = field(H, T, h);
    let peak = 0;
    let mean = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const v = f.sample([0, -h + 1e-6, 0], (i / n) * T);
      peak = Math.max(peak, Math.abs(v[0]));
      mean += v[0] / n;
      assert.ok(Math.abs(v[2]) < 1e-9 && Math.abs(v[1]) < 1e-5);
    }
    const expected = (Math.PI * H) / (T * Math.sinh(waveNumber(T, h) * h));
    assert.ok(Math.abs(peak - expected) < 0.01 * expected, `${peak} vs ${expected}`);
    assert.ok(Math.abs(mean) < 1e-3);
  });
  it("die out with depth and never overflow in deep water", () => {
    const f = field(5, 8, 1500);
    const at = (z: number) => Math.max(...Array.from({ length: 50 }, (_, i) => Math.hypot(...f.sample([0, z, 0], i * 0.16))));
    assert.ok(at(-2) > 1 && at(-60) < 0.1 && at(-1400) < 1e-9 && Number.isFinite(at(-1400)));
  });
  it("surge an ROV that is drifting, and cannot carry it out of the site", () => {
    const e = new FieldEngine("reef", "rov");
    e.setConditions({ current: { speedMps: 0 }, site: { waveHeightM: 2, wavePeriodS: 10, waveHeadingDeg: 90 } });
    e.setPilotMode("MANUAL");
    e.pilotTarget.assist = false;
    const xs: number[] = [];
    const b = e.bounds();
    for (let i = 0; i < 300; i++) {
      e.advance(0.1);
      xs.push(e.vehicle!.position[0]);
      assert.ok(e.vehicle!.position[0] >= b.x0 && e.vehicle!.position[0] <= b.x1);
    }
    assert.ok(Math.max(...xs) - Math.min(...xs) > 0.4, "it is moved back and forth");
  });
});

describe("checks and presets", () => {
  it("flag what will not work, with numbers, and stay quiet at the defaults", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      const e = new FieldEngine(id, "rov");
      const warn = checkConditions(e.env, e.conditions, "rov").filter((i) => i.level === "warn");
      // the river's default current peaks at what the ROV can make: that one is true
      assert.deepEqual(warn.map((w) => w.text).filter((t) => !t.includes("hold station")), [], id);
    }
    const e = new FieldEngine("harbor", "rov");
    const texts = (patch: Parameters<FieldEngine["setConditions"]>[0]) => {
      e.setConditions(patch);
      return checkConditions(e.env, e.conditions, "rov").map((i) => i.text).join("\n");
    };
    assert.match(texts({ altitudeM: 8 }), /Fly lower/);
    assert.match(texts({ current: { speedMps: 1.5 } }), /cannot hold station/);
    assert.match(texts({ lighting: 0, lamps: 0 }), /sees nothing/);
    assert.match(texts({ site: { exposureS: 1 / 25 }, speedMps: 1 }), /smears/);
    assert.ok(Math.abs(maxWaterSpeed("rov") - 0.9) < 0.05);
  });
  it("every preset is possible as written, changes something, and runs", () => {
    for (const id of FIELD_ENVIRONMENT_IDS) {
      assert.equal(new Set(PRESETS[id].map((p) => p.id)).size, PRESETS[id].length);
      for (const p of PRESETS[id]) {
        const { env, site } = base(id);
        const s = sanitizeSite(env, p.site ?? {}, site);
        for (const k of Object.keys(p.site ?? {}) as (keyof SiteParams)[]) assert.equal(s[k], p.site![k], `${id}/${p.id}: ${k} was clamped to ${s[k]}`);
        const e = new FieldEngine(id, "rov");
        e.setConditions({ turbidity: p.turbidity, lighting: p.lighting, lamps: p.lamps, current: p.current, site: p.site });
        e.setConditions({ altitudeM: e.plannedAltitude() });
        e.reset();
        e.startMission();
        e.advance(10);
        for (const v of Object.values(e.telemetry())) if (typeof v === "number") assert.ok(Number.isFinite(v), `${id}/${p.id}`);
      }
    }
  });
  it("random parameter sets never break the physics", () => {
    const rand = mulberry32(99);
    for (let n = 0; n < 60; n++) {
      const id = FIELD_ENVIRONMENT_IDS[n % FIELD_ENVIRONMENT_IDS.length];
      const pf = (["rov", "auv", "station"] as PlatformId[])[n % 3];
      if (!compatibility(ENVIRONMENT_LIBRARY[id], pf).ok) continue;
      const e = new FieldEngine(id, pf);
      const site = Object.fromEntries(SITE_KEYS.map((k) => [k, SITE_SPEC[k].min + rand() * (SITE_SPEC[k].max - SITE_SPEC[k].min)])) as unknown as SiteParams;
      e.setConditions({ turbidity: rand(), lighting: rand(), lamps: rand(), current: { speedMps: rand() * 2, headingDeg: rand() * 360, turbulence: rand() * 0.5 }, site });
      e.reset();
      e.startMission();
      e.advance(6);
      const t = e.telemetry();
      for (const v of [...t.position, ...t.current, t.densityKgM3, t.visibilityM, t.reynolds, t.netBuoyancyN]) assert.ok(Number.isFinite(v), `${id}/${pf} ${JSON.stringify(site)}`);
      for (const d of e.detections) assert.ok(d.confidence >= 0 && d.confidence <= 1 && d.bbox.every(Number.isFinite));
    }
  });
});

describe("sensitivity test", () => {
  const param = (id: string) => SWEEP_PARAMS.find((p) => p.id === id)!;
  const opts = (id: string, values: number[]) => {
    const e = new FieldEngine("reef", "rov");
    return { env: "reef" as const, platform: "rov" as const, mission: "detection" as const, base: e.conditions, param: param(id), values, seeds: 1, replan: true };
  };
  it("finds where the platform stops working, and the live engine is not involved", async () => {
    const rows = await runSweep(opts("turbidity", [0, 0.5, 1]), () => {});
    assert.equal(rows.length, 3);
    assert.ok(rows[0].classified >= 5, `clear ${rows[0].classified}`);
    assert.ok(rows[2].classified <= rows[0].classified && rows[2].visibilityM < rows[0].visibilityM && rows[2].altitudeM < rows[0].altitudeM);
    assert.match(envelope(rows).text(String), /Classifies|Never/);
  });
  it("is reproducible and every parameter it offers takes effect", async () => {
    const o = opts("site.fouling", [0, 1]);
    const [a, b] = [await runSweep(o, () => {}), await runSweep(o, () => {})];
    assert.deepEqual(a, b);
    assert.ok(a[1].meanConfidence < a[0].meanConfidence);
    for (const p of SWEEP_PARAMS) {
      const e = new FieldEngine("reef", "rov");
      e.setConditions(p.patch(p.min));
      const lo = p.read(e.conditions);
      e.setConditions(p.patch(p.min + (p.max - p.min) * 0.2));
      assert.notEqual(p.read(e.conditions), lo, p.id);
    }
  });
  it("can be cancelled and makes readable steps", async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(runSweep(opts("turbidity", [0, 1]), () => {}, ac.signal), /cancelled/);
    assert.deepEqual(sweepValues(0, 1, 5, 2), [0, 0.25, 0.5, 0.75, 1]);
    assert.deepEqual(sweepValues(1, 0, 3, 2), [0, 0.5, 1]);
  });
});
