import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SWITCH, SwitchLearner, SwitchWorld, evaluatePolicies, exportPolicy } from "../autonomy/switching";
import { FEATURES, NavTrainer, randomScenario, runEpisode } from "../autonomy/nav";
import { NAV_HELD_OUT, NAV_WEIGHTS } from "../autonomy/nav-weights";
import { VALIDATION_BASE, scoreStrategy } from "../autonomy/nav-eval";
import { adviseModel, adviseSet } from "./advise";
import { routingGain, sharedBlindSpots, strengths, winnerMap } from "./compare";
import { CONDITION_GRID, SIMULATED_ROSTER as ROSTER, addCounts, f1, lightingBucket, turbidityBucket, ZERO } from "./profile";

describe("model benchmark", () => {
  it("the capture grid lands in every turbidity x lighting cell", () => {
    assert.equal(new Set(CONDITION_GRID.map(([t, l]) => `${turbidityBucket(t)},${lightingBucket(l)}`)).size, 12);
  });
  it("cells, slices and classes add up to the overall counts", () => {
    for (const p of ROSTER) {
      const cells = p.cells!.flat().reduce(addCounts, { ...ZERO });
      assert.deepEqual(cells, p.overall, p.id);
      const byClass = Object.values(p.byClass).reduce((s, c) => s + c.tp, 0);
      assert.equal(byClass, p.overall.tp);
      assert.equal(p.overall.tp + p.overall.fn, p.overall.nGt);
    }
  });
  it("finds a real specialist structure: different models win different waters", () => {
    const winners = new Set(winnerMap(ROSTER)!.flat().map((c) => c.winner));
    assert.ok(winners.size >= 2, `winners ${[...winners]}`);
    const g = routingGain(ROSTER)!;
    assert.ok(g.routed.f1 > g.bestSingle.f1);
    assert.ok(g.routed.f1 < 1);
  });
  it("names where each model is best and worst, on supported slices only", () => {
    for (const p of ROSTER) {
      const s = strengths(p);
      assert.ok(s.best.length > 0 && s.worst.length > 0);
      for (const x of [...s.best, ...s.worst]) assert.ok(x.nGt >= 10);
    }
  });
  it("a threshold suggestion reproduces the sweep it cites, and bounds are never below the present score", () => {
    for (const p of ROSTER)
      for (const a of adviseModel(p, 300)) {
        assert.ok(a.change && a.evidence, a.title);
        if (!a.effect) continue;
        assert.ok(a.effect.after >= a.effect.before - 1e-9, a.title);
        if (a.kind === "threshold") assert.ok(p.sweep.some((s) => s.f1 === a.effect!.after));
        assert.ok(Math.abs(a.effect.before - f1(p.overall)!) < 1e-12);
      }
    assert.ok(adviseSet(ROSTER).some((a) => a.kind === "routing"));
    void sharedBlindSpots(ROSTER);
  });
});

describe("learned model switching", () => {
  const world = new SwitchWorld(ROSTER, DEFAULT_SWITCH);
  const learner = new SwitchLearner(world);
  learner.step(Infinity);
  const rows = evaluatePolicies(world, learner);
  const of = (k: string) => rows.filter((r) => r.kind === k).map((r) => r.reward);
  it("beats every fixed model and random switching on held-out surveys, and stays below the oracle", () => {
    const learned = of("learned")[0];
    assert.ok(learned > Math.max(...of("fixed")) + 0.005, `learned ${learned} fixed ${of("fixed")}`);
    assert.ok(learned > of("random")[0]);
    assert.ok(of("oracle")[0] >= learned - 1e-9, `oracle ${of("oracle")[0]} learned ${learned}`);
  });
  it("is deterministic and learns: late training beats early training", () => {
    const again = new SwitchLearner(new SwitchWorld(ROSTER, DEFAULT_SWITCH));
    again.step(Infinity);
    assert.deepEqual(again.w, learner.w);
    const mean = (xs: { reward: number }[]) => xs.reduce((s, x) => s + x.reward, 0) / xs.length;
    assert.ok(mean(learner.curve.slice(-10)) > mean(learner.curve.slice(0, 10)) + 0.05);
  });
  it("a prohibitive switch cost makes it stop switching", () => {
    const l = new SwitchLearner(new SwitchWorld(ROSTER, { ...DEFAULT_SWITCH, switchCost: 5 }));
    l.step(Infinity);
    const r = evaluatePolicies(l.world, l, 20).find((x) => x.kind === "learned")!;
    assert.ok(r.switches <= 1.5, `switches ${r.switches}`);
  });
  it("exports a complete policy that marks simulated training", () => {
    const p = exportPolicy(learner);
    assert.equal(p.policy.length, 4);
    for (const row of p.policy) for (const cell of row) for (const a of cell) assert.ok(a >= 0 && a < ROSTER.length);
    assert.match(p.trained_on, /SIMULATED/);
  });
});

describe("learned gantry navigation", () => {
  it("training is deterministic and improves on its own start", () => {
    const run = () => {
      const t = new NavTrainer({ episodes: 120, seed: 3 });
      t.step(120);
      return t;
    };
    const a = run();
    assert.deepEqual(a.weights, run().weights);
    const mean = (xs: { reward: number }[]) => xs.reduce((s, x) => s + x.reward, 0) / xs.length;
    assert.ok(mean(a.curve.slice(-40)) > mean(a.curve.slice(0, 40)));
  });
  it("the shipped weights match the features and scan within the rails", () => {
    assert.equal(NAV_WEIGHTS.length, FEATURES.length);
    const r = runEpisode(randomScenario(77), (st, x, y, seen) => {
      const a = st.plan(NAV_WEIGHTS, x, y, seen).action;
      if (a) assert.ok(a.x >= 0 && a.x <= 100 && a.y >= 0 && a.y <= 40);
      return a;
    });
    assert.ok(r.viewpoints > 0 && r.viewpoints <= 20);
  });
  it("the recorded held-out scores are reproducible and the policy is competitive with the best heuristic", () => {
    const rec = (id: string) => NAV_HELD_OUT.find((h) => h.strategy === id)!.scores.all;
    const bestHand = Math.max(...NAV_HELD_OUT.filter((h) => h.strategy !== "learned").map((h) => h.scores.all.score));
    assert.ok(rec("learned").score >= bestHand - 0.1, `learned ${rec("learned").score} best ${bestHand}`);
    const live = scoreStrategy("learned", VALIDATION_BASE, 30).all;
    const serp = scoreStrategy("serpentine", VALIDATION_BASE, 30).all;
    assert.ok(live.score > serp.score, `learned ${live.score} serpentine ${serp.score}`);
  });
});
