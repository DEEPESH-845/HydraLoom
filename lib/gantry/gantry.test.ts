import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SimEngine } from "../sim/engine";
import { TEST } from "../sim/constants";
import { ARM_PHRASE, DryRunAdapter, SafeGantryLink, SafetySupervisor, type HardwareStatus } from "../hardware/safety";
import { STRATEGY_IDS, cellsSeenFrom, coveragePlan, createPlanner, type StrategyId } from "./strategies";

function runTest(strategy: StrategyId, patch: Parameters<SimEngine["setScenario"]>[0] = {}) {
  const e = new SimEngine();
  e.setScenario({ ...patch, strategy });
  e.runTest();
  for (let i = 0; i < 120 * 600 && e.phase !== "COMPLETE"; i++) e.tick(1 / 120);
  assert.equal(e.phase, "COMPLETE", strategy);
  return e;
}

describe("inspection strategies", () => {
  it("serpentine reproduces the golden test run exactly", () => {
    const r = runTest("serpentine").result!;
    assert.equal(r.objectsDetected, 5);
    assert.equal(r.successfulDetections, 4);
    assert.equal(r.falsePositives, 1);
    assert.equal(r.coverage, 0.9);
    assert.equal(r.episodeReward, 15.7);
    assert.ok(Math.abs(r.durationS - 43.4) < 0.05);
    assert.equal(r.viewpoints, TEST.scanWaypoints.length);
  });
  it("the coverage plan images every floor cell", () => {
    const cells = new Set<number>();
    for (const [x, y] of coveragePlan()) for (const c of cellsSeenFrom(x, y)) cells.add(c);
    assert.equal(cells.size, TEST.coverageGrid[0] * TEST.coverageGrid[1]);
    assert.equal(runTest("coverage").result!.coverage, 1);
  });
  it("every strategy terminates, stays on the rails and is deterministic", () => {
    for (const s of STRATEGY_IDS) {
      const a = runTest(s, { turbidity: 0.45 });
      const b = runTest(s, { turbidity: 0.45 });
      assert.deepEqual(a.result, b.result, s);
      assert.ok(a.result!.viewpoints > 0 && a.result!.viewpoints <= 40, s);
      assert.ok(a.result!.pathCm > 0);
    }
  });
  it("detection-driven re-centring raises confidence in murky water", () => {
    const r = runTest("detection-driven", { turbidity: 0.45 }).result!;
    assert.ok(r.repositionGain !== null && r.repositionGain > 0, `gain ${r.repositionGain}`);
    const base = runTest("serpentine", { turbidity: 0.45 }).result!;
    assert.ok(r.avgConfidence > base.avgConfidence);
  });
  it("user waypoints are clamped to travel and fall back to the plan when empty", () => {
    const p = createPlanner("waypoints", [[-50, 10], [500, 500]]);
    assert.deepEqual(p.next({ x: 0, y: 0, seen: new Map(), covered: new Set(), time: 0 }), { x: 0, y: 10, reason: "user" });
    assert.deepEqual(p.next({ x: 0, y: 0, seen: new Map(), covered: new Set(), time: 0 }), { x: 100, y: 40, reason: "user" });
    assert.equal(createPlanner("waypoints", []).total, TEST.scanWaypoints.length);
  });
  it("invalid strategy ids and waypoints are ignored", () => {
    const e = new SimEngine();
    e.setScenario({ strategy: "teleport" as StrategyId, waypoints: [[NaN, 1], [10, 10]] });
    assert.equal(e.scenario.strategy, "serpentine");
    assert.deepEqual(e.scenario.waypoints, [[10, 10]]);
  });
});

describe("hardware safety boundary", () => {
  const status = (p: Partial<HardwareStatus> = {}): HardwareStatus => ({ connected: true, homed: true, limitX0: false, limitY0: false, estopPressed: false, x: 50, y: 20, ...p });
  const armed = (mode: "dry-run" | "live" = "live") => {
    const s = new SafetySupervisor(undefined, mode);
    s.heartbeat(status(), 0);
    assert.ok(s.arm(ARM_PHRASE, 10).ok);
    return s;
  };

  it("refuses motion while disarmed, and arming needs the phrase and a live link", () => {
    const s = new SafetySupervisor(undefined, "live");
    assert.equal(s.validate({ kind: "MOVE", x: 10, y: 10, speed: 5, source: "operator" }, 0).ok, false);
    assert.equal(s.arm(ARM_PHRASE, 0).ok, false); // no heartbeat yet
    s.heartbeat(status(), 0);
    assert.equal(s.arm("yes", 10).ok, false);
    assert.equal(s.arm(ARM_PHRASE, 10).ok, true);
  });
  it("rejects (never clamps) out-of-limit, non-finite and over-speed commands", () => {
    const s = armed();
    for (const cmd of [
      { x: 150, y: 10, speed: 5 },
      { x: -1, y: 10, speed: 5 },
      { x: 10, y: NaN, speed: 5 },
      { x: 10, y: 10, speed: 50 },
      { x: 10, y: 10, speed: 0 },
    ])
      assert.equal(s.validate({ kind: "MOVE", ...cmd, source: "operator" }, 20).ok, false, JSON.stringify(cmd));
    assert.equal(s.validate({ kind: "MOVE", x: 10, y: 10, speed: 5, source: "operator" }, 20).ok, true);
  });
  it("only HOME and STOP before homing", () => {
    const s = new SafetySupervisor(undefined, "live");
    s.heartbeat(status({ homed: false }), 0);
    s.arm(ARM_PHRASE, 0);
    assert.equal(s.validate({ kind: "MOVE", x: 10, y: 10, speed: 5, source: "operator" }, 1).ok, false);
    assert.equal(s.validate({ kind: "HOME", source: "operator" }, 1).ok, true);
    assert.equal(s.validate({ kind: "STOP", source: "operator" }, 1).ok, true);
  });
  it("AI and controller commands need operator approval and still pass validation", () => {
    const s = armed();
    assert.equal(s.validate({ kind: "MOVE", x: 10, y: 10, speed: 5, source: "ai" }, 20).ok, false);
    assert.equal(s.validate({ kind: "MOVE", x: 10, y: 10, speed: 5, source: "ai", approvalId: "op-1" }, 20).ok, true);
    assert.equal(s.validate({ kind: "MOVE", x: 999, y: 10, speed: 5, source: "ai", approvalId: "op-1" }, 20).ok, false);
  });
  it("heartbeat loss faults the link, sends STOP and latches", () => {
    const s = armed();
    const ad = new DryRunAdapter();
    const link = new SafeGantryLink(s, ad);
    const r = link.submit({ kind: "MOVE", x: 10, y: 10, speed: 5, source: "operator" }, 5000);
    assert.equal(r.ok, false);
    assert.equal(s.state, "FAULT");
    assert.equal(ad.sent[0].kind, "STOP");
    s.heartbeat(status(), 5001);
    assert.equal(s.arm(ARM_PHRASE, 5002).ok, false); // latched
    assert.ok(s.resetLatch(5003).ok);
    assert.equal(s.state, "DISARMED");
  });
  it("physical E-stop trips immediately and must be released before reset", () => {
    const s = armed();
    s.heartbeat(status({ estopPressed: true }), 20);
    assert.equal(s.state, "ESTOP");
    assert.equal(s.resetLatch(21).ok, false);
    s.heartbeat(status(), 22);
    assert.ok(s.resetLatch(23).ok);
  });
  it("limit switches block motion toward them", () => {
    const s = new SafetySupervisor(undefined, "live");
    s.heartbeat(status({ limitX0: true, x: 0.5 }), 0);
    s.arm(ARM_PHRASE, 0);
    assert.equal(s.validate({ kind: "MOVE", x: 0.5, y: 10, speed: 5, source: "operator" }, 1).ok, true);
    s.heartbeat(status({ limitX0: true, x: 2 }), 2);
    assert.equal(s.validate({ kind: "MOVE", x: 1, y: 10, speed: 5, source: "operator" }, 3).ok, false);
  });
  it("dry-run never transmits to a serial adapter", () => {
    const s = armed("dry-run");
    const sent: unknown[] = [];
    const link = new SafeGantryLink(s, { kind: "serial", send: (c) => sent.push(c) });
    const r = link.submit({ kind: "MOVE", x: 10, y: 10, speed: 5, source: "operator" }, 20);
    assert.equal(r.ok, true);
    assert.equal(r.transmitted, false);
    assert.equal(sent.length, 0);
  });
});
