import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARM_PHRASE } from "./safety";
import { GrblDriver, parseStatus } from "./grbl";
import { GrblEmulator, HEALTHY, WORN, type RigFaults } from "./emulator";
import { TEST_ORDER, buildReport, overall, parsePiLog, runTest, toCsv, twinMs, type TestRecord } from "./acceptance";

/** A rig on a virtual clock: every macrotask advances the machine 5 ms. */
async function rig(faults: RigFaults = HEALTHY, home = true) {
  const emu = new GrblEmulator(faults);
  let clock = 0;
  const d = new GrblDriver(emu, () => clock);
  let alive = true;
  let n = 0;
  const loop = () => {
    if (!alive) return;
    clock += 5;
    emu.advance(0.005);
    if (++n % 4 === 0) d.tick();
    setImmediate(loop);
  };
  setImmediate(loop);
  await d.start(false);
  if (home) {
    assert.ok(d.supervisor.arm(ARM_PHRASE, d.now()).ok);
    await d.run({ kind: "HOME", source: "operator" });
  }
  return { emu, d, stop: () => (alive = false), clock: () => clock, skip: (ms: number) => (clock += ms) };
}

describe("GRBL driver", () => {
  it("parses status reports with MPos, WPos, offsets and pins, and rejects noise", () => {
    const a = parseStatus("<Idle|MPos:10.000,20.000,0.000|FS:0,0|WCO:4.000,5.000,0.000>", null)!;
    assert.deepEqual([a.status.x, a.status.y], [6, 15]);
    const b = parseStatus("<Run|MPos:10.000,20.000,0.000|FS:500,0|Pn:XR>", a.wco)!;
    assert.deepEqual([b.status.x, b.status.pins, b.status.feed], [6, "XR", 500]);
    assert.equal(parseStatus("<Idle|WPos:1.5,2.5,0>", [9, 9])!.status.x, 1.5);
    for (const bad of ["", "ok", "<", "<Idle|MPos:a,b>|", "Idle|MPos:1,2,3"]) assert.equal(parseStatus(bad, null), null, bad);
    assert.equal(parseStatus("<Idle|MPos:a,b,c>", null)!.status.x, null);
  });
  it("homes, moves where it was told and reports work coordinates in gantry cm", async () => {
    const r = await rig();
    await r.d.run({ kind: "MOVE", x: 40, y: 12, speed: 10, source: "operator" });
    assert.ok(Math.abs(r.d.packet().x - 40) < 1e-6 && Math.abs(r.d.packet().y - 12) < 1e-6);
    assert.equal(r.d.settings.get("100"), 80);
    r.stop();
  });
  it("refuses motion before arming and before homing, and outside the limits", async () => {
    const r = await rig(HEALTHY, false);
    await assert.rejects(r.d.run({ kind: "MOVE", x: 40, y: 12, speed: 10, source: "operator" }), /not armed/);
    r.d.supervisor.arm(ARM_PHRASE, r.d.now());
    await assert.rejects(r.d.run({ kind: "MOVE", x: 40, y: 12, speed: 10, source: "operator" }), /not homed/);
    await r.d.run({ kind: "HOME", source: "operator" });
    await assert.rejects(r.d.run({ kind: "MOVE", x: 140, y: 12, speed: 10, source: "operator" }), /soft limits/);
    await assert.rejects(r.d.run({ kind: "MOVE", x: 40, y: 12, speed: 10, source: "controller" }), /approval/);
    r.stop();
  });
  it("a silent controller faults the link; homing silence does not", async () => {
    const r = await rig();
    assert.equal(r.d.supervisor.state, "ARMED");
    r.skip(700);
    await new Promise((f) => setImmediate(f));
    r.d.tick();
    assert.equal(r.d.supervisor.state, "FAULT");
    r.stop();
  });
  it("an unplugged cable fails the move in progress and unhomes", async () => {
    const r = await rig();
    const p = r.d.run({ kind: "MOVE", x: 90, y: 20, speed: 5, source: "operator" });
    setTimeout(() => r.emu.unplug(), 5);
    await assert.rejects(p, /disconnected/);
    assert.equal(r.d.homed, false);
    r.stop();
  });
  it("a pressed E-stop input latches", async () => {
    const r = await rig();
    r.emu.pins = "R";
    for (let i = 0; i < 4; i++) await r.d.nextStatus();
    assert.equal(r.d.supervisor.state, "ESTOP");
    await assert.rejects(r.d.run({ kind: "MOVE", x: 40, y: 12, speed: 10, source: "operator" }), /not armed/);
    r.stop();
  });
});

describe("acceptance tests", () => {
  const suite = async (faults: RigFaults) => {
    const r = await rig(faults);
    const tests: TestRecord[] = [];
    for (const id of TEST_ORDER) tests.push(await runTest(id, r.d, async () => r.emu.readTrue(), () => {}));
    const report = buildReport(r.d, tests, "emulated", "");
    r.stop();
    return report;
  };
  it("a healthy rig is accepted and marked simulated", async () => {
    const rep = await suite(HEALTHY);
    assert.deepEqual(rep.tests.map((t) => t.error).filter(Boolean), []);
    assert.equal(overall(rep).verdict, "ACCEPTED", JSON.stringify(rep.tests.flatMap((t) => t.metrics).filter((m) => m.verdict === "fail")));
    assert.equal(rep.source, "simulated");
    const csv = toCsv(rep);
    assert.match(csv, /Backlash/);
    assert.ok(!csv.includes("NaN"));
  });
  it("a worn rig is rejected, and every injected fault is named with a fix that corrects it", async () => {
    const rep = await suite(WORN);
    assert.equal(overall(rep).verdict, "NOT ACCEPTED");
    const s = rep.suggestions.map((x) => x.title + " " + x.change).join("\n");
    assert.match(s, /Recalibrate X steps/);
    assert.match(s, /backlash/);
    assert.match(s, /losing steps/);
    assert.match(s, /twin's timing/);
    const steps = Number(/\$100=([\d.]+)/.exec(s)![1]);
    assert.ok(Math.abs(steps - 80 / WORN.scaleX) < 0.15, `suggested ${steps}, true ${80 / WORN.scaleX}`);
  });
  it("without a gauge, true-position tests say not measured instead of passing", async () => {
    const r = await rig();
    const t = await runTest("repeatability", r.d, null, () => {});
    assert.equal(t.metrics[0].verdict, "not measured");
    assert.equal(overall({ tests: [t] }).verdict, "INCOMPLETE");
    r.stop();
  });
  it("the twin's move time is the trapezoid", () => {
    assert.ok(Math.abs(twinMs(80, 15) - (80 / 15 + 15 / 30) * 1000) < 1e-9);
    assert.ok(Math.abs(twinMs(1, 15) - 2 * Math.sqrt(1 / 30) * 1000) < 1e-9);
  });
  it("parses a Pi log and rejects one it cannot read", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `${i * 0.5},${400 + i * 5},${50 + i / 2},${i > 35 ? 1 : 0}`).join("\n");
    const p = parsePiLog(`t_s,latency_ms,temp_c,throttled\n${rows}\n`);
    assert.equal(p.frames, 40);
    assert.equal(p.throttled, 4);
    assert.ok(p.slowdown > 1.2 && p.maxTempC === 69.5);
    assert.throws(() => parsePiLog("a,b\n1,2"), /columns/);
    assert.throws(() => parsePiLog("t_s,latency_ms\n0,10"), /usable/);
  });
});
