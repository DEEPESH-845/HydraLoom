"use client";

import clsx from "clsx";
import { Pause, Play, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { LineChart, RankBars, Seg, Stat, download } from "@/components/bench/charts";
import { SourceBar } from "@/components/bench/SourceBar";
import { useProfiles } from "@/components/bench/useProfiles";
import { seriesColor } from "@/components/evaluation/charts/core";
import { EmptyState, PageShell, Panel, SkeletonRows } from "@/components/evaluation/ui";
import { WorkspaceNav } from "@/components/evaluation/WorkspaceNav";
import { useInterval } from "@/lib/api/hooks";
import { LEGS, runMission, scoreMissions, type MissionRun, type MissionScore } from "@/lib/autonomy/mission";
import { FEATURES, NavTrainer } from "@/lib/autonomy/nav";
import { NAV_HELD_OUT, NAV_TRAINING, NAV_WEIGHTS } from "@/lib/autonomy/nav-weights";
import { DEFAULT_SWITCH, L, SwitchLearner, SwitchWorld, evaluatePolicies, exportPolicy, trainable, type SwitchConfig } from "@/lib/autonomy/switching";
import { LIGHTING, SIMULATED_ROSTER, TURBIDITY, type ModelProfile } from "@/lib/bench/profile";
import { STRATEGIES } from "@/lib/gantry/strategies";
import { CAMERA, GANTRY } from "@/lib/sim/constants";

export function Autonomy() {
  const p = useProfiles();
  const usable = trainable(p.profiles) && p.profiles.some((m) => m.overall.tp > 0);
  const roster = usable ? p.profiles : SIMULATED_ROSTER;
  return (
    <PageShell testId="autonomy">
      <WorkspaceNav active="autonomy" />
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-6 py-5 max-[759px]:px-4 max-[479px]:px-2 max-[479px]:py-3">
        <div>
          <h1 className="text-[24px] font-medium leading-tight text-text max-[479px]:text-[20px]">Autonomy</h1>
          <p className="mt-1 max-w-[84ch] text-[13px] leading-relaxed text-muted">Two learned policies run the survey: one decides where the gantry camera looks next, the other decides which vision model looks, as the water changes.</p>
        </div>
        <SourceBar p={p} />
        {p.loading ? (
          <SkeletonRows rows={4} />
        ) : (
          <>
            {p.source === "measured" && !usable && (
              <EmptyState title="These runs cannot train a switching policy">
                It needs at least two models, one of which finds something, with turbidity and lighting varied together. Evaluate them on a Condition grid dataset in <Link className="underline" href="/benchmark#evaluate">Benchmark</Link>. The simulated roster is used below.
              </EmptyState>
            )}
            <Workspace key={roster.map((r) => r.id).join()} roster={roster} />
          </>
        )}
        <Navigation />
      </main>
    </PageShell>
  );
}

function Workspace({ roster }: { roster: ModelProfile[] }) {
  const [cfg, setCfg] = useState<SwitchConfig>(DEFAULT_SWITCH);
  const trained = useMemo(() => {
    const world = new SwitchWorld(roster, cfg);
    const learner = new SwitchLearner(world);
    learner.step(Infinity);
    return { world, learner, rows: evaluatePolicies(world, learner) };
  }, [roster, cfg]);
  const learned = trained.rows.find((r) => r.kind === "learned")!;
  const fixed = trained.rows.filter((r) => r.kind === "fixed").reduce((b, r) => (r.reward > b.reward ? r : b));
  const oracle = trained.rows.find((r) => r.kind === "oracle")!;
  const captured = oracle.reward - fixed.reward > 1e-4 ? (learned.reward - fixed.reward) / (oracle.reward - fixed.reward) : null;
  return (
    <>
      <div className="grid grid-cols-4 gap-3 max-[1099px]:grid-cols-2 max-[479px]:grid-cols-1" data-testid="autonomy-stats">
        <Stat label="Learned switching" value={learned.reward.toFixed(3)} sub="score per frame on held-out surveys" tone="teal" />
        <Stat label="Best single model" value={fixed.reward.toFixed(3)} sub={fixed.name.replace("Always ", "")} />
        <Stat label="Of the possible gain" value={captured === null ? "n/a" : `${Math.round(captured * 100)}%`} sub={captured === null ? "One model is best everywhere: there is nothing to switch for" : `An oracle that knows every model's scores reaches ${oracle.reward.toFixed(3)}`} tone="amber" />
        <Stat label="Switches per survey" value={learned.switches.toFixed(1)} sub="400 frames; each costs the load time" />
      </div>
      <Mission world={trained.world} learner={trained.learner} bestFixed={trained.rows.filter((r) => r.kind === "fixed").indexOf(fixed)} />
      <Switching roster={roster} cfg={cfg} setCfg={setCfg} {...trained} />
    </>
  );
}

/* ---------- mission playback ---------- */

function Mission({ world, learner, bestFixed }: { world: SwitchWorld; learner: SwitchLearner; bestFixed: number }) {
  const [seed, setSeed] = useState(1);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scores, setScores] = useState<MissionScore[] | null>(null);
  const [scoring, setScoring] = useState(false);
  const run = useMemo(() => runMission("learned", world, learner.policy, seed), [world, learner, seed]);
  const rival = useMemo(() => runMission("fixed", world, () => bestFixed, seed, bestFixed), [world, bestFixed, seed]);
  const step = run.steps[Math.min(idx, run.steps.length - 1)];
  const last = run.steps.length - 1;
  useInterval(
    () => {
      if (idx >= last) setPlaying(false);
      else setIdx(idx + 1);
    },
    900,
    playing,
  );
  const play = () => {
    if (idx >= last) setIdx(0);
    setPlaying(!playing);
  };
  const score = () => {
    setScoring(true);
    // let the button paint before the few seconds of simulation
    setTimeout(() => {
      setScores(scoreMissions(world, learner.policy));
      setScoring(false);
    }, 30);
  };
  if (!step) return null;
  const foundBy = (r: MissionRun, until: number) => {
    const byLeg = new Map<number, number>();
    for (const s of r.steps.slice(0, until + 1)) byLeg.set(s.leg, s.foundInLeg);
    return [...byLeg.values()].reduce((a, b) => a + b, 0);
  };
  return (
    <Panel
      id="mission"
      label="Autonomous mission"
      title={`Leg ${step.leg + 1} of ${LEGS.length}: ${LEGS[step.leg].name}`}
      note="A simulated survey of the lab tank through four waters. Navigation and switching are both learned; no operator input."
      right={
        <>
          <button type="button" className="btn btn-primary inline-flex items-center gap-1.5 !py-1.5" onClick={play} data-testid="mission-play">
            {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? "Pause" : idx >= last ? "Replay" : "Play mission"}
          </button>
          <button
            type="button"
            className="btn inline-flex items-center gap-1.5 !py-1.5"
            onClick={() => {
              setSeed(seed + 1);
              setIdx(0);
              setPlaying(false);
            }}
          >
            <RotateCcw size={13} /> New layout
          </button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_300px] gap-5 max-[1099px]:grid-cols-1">
        <div className="min-w-0">
          <TankMap run={run} idx={Math.min(idx, last)} />
          <Timeline run={run} idx={Math.min(idx, last)} onSeek={(i) => setIdx(i)} models={world.models} />
        </div>
        <div className="flex flex-col gap-3" data-testid="mission-now">
          <div className="border border-line p-3">
            <div className="label">Running model</div>
            <div className="mt-1 flex items-center gap-2 text-[16px] text-text">
              <span className="h-3 w-3 rounded-[2px]" style={{ background: seriesColor(step.model) }} aria-hidden />
              {world.models[step.model].name}
            </div>
            <p className="mt-1 text-[12px] leading-snug text-muted">
              {step.switched ? "Switched here: " : "Kept: "}
              {step.turbidity} water, {step.lighting} light.
            </p>
          </div>
          <div className="border border-line p-3">
            <div className="label">Why the camera is here</div>
            <p className="value mt-1 text-[12px] text-text">
              X {step.x.toFixed(1)}, Y {step.y.toFixed(1)} cm
            </p>
            <p className="mt-1 text-[12px] leading-snug text-muted">{step.reason}</p>
          </div>
          <div className="border border-line p-3">
            <div className="label">Objects found so far</div>
            <div className="value mt-1 text-[20px] text-teal">
              {foundBy(run, idx)} <span className="text-[12px] text-dim">of {run.possible}</span>
            </div>
            <p className="mt-1 text-[12px] leading-snug text-muted">
              Whole mission: {run.found} found, {run.falseAlarms} false alarms, {run.switches} switches in {run.timeS.toFixed(0)} s.
            </p>
            <p className="text-[12px] leading-snug text-muted">
              {world.models[bestFixed].name} alone, same layout: {rival.found} found, {rival.falseAlarms} false alarms in {rival.timeS.toFixed(0)} s.
            </p>
          </div>
        </div>
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="max-w-[70ch] text-[12px] text-muted">One mission is an anecdote. This averages 12 held-out missions, the same layouts and water for every choice of model.</p>
          <button type="button" className="btn !py-1.5" onClick={score} disabled={scoring} data-testid="score-missions">
            {scoring ? "Scoring" : "Score 12 missions"}
          </button>
        </div>
        {scores && (
          <div className="grid grid-cols-2 gap-5 max-[899px]:grid-cols-1" data-testid="mission-scores">
            <div>
              <div className="label mb-2">Objects found, mean of {scores[0].possible}</div>
              <RankBars max={scores[0].possible} format={(v) => v.toFixed(1)} rows={scores.map((s, i) => ({ name: s.name, value: s.found, color: i === 0 ? "#3db9b0" : seriesColor(i - 1), strong: i === 0 })).sort((a, b) => b.value - a.value)} />
            </div>
            <div>
              <div className="label mb-2">False alarms, mean per mission (fewer is better)</div>
              <RankBars format={(v) => v.toFixed(1)} rows={scores.map((s, i) => ({ name: s.name, value: s.falseAlarms, color: i === 0 ? "#3db9b0" : seriesColor(i - 1), strong: i === 0 })).sort((a, b) => a.value - b.value)} />
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

const LEG_TINT = ["#12303a", "#3a3524", "#101d2c", "#2a2620"];

function TankMap({ run, idx }: { run: MissionRun; idx: number }) {
  const step = run.steps[idx];
  const leg = run.steps.slice(0, idx + 1).filter((s) => s.leg === step.leg);
  const scenario = run.scenarios[step.leg];
  const tanH = Math.tan((CAMERA.hfovDeg * Math.PI) / 360);
  const halfW = CAMERA.lensHeight * tanH * 100;
  const halfH = halfW / CAMERA.aspect;
  const found = new Map<string, { cls: string; x: number; y: number }>();
  for (const s of leg) for (const d of s.seen) found.set(d.id, { cls: d.cls, x: d.x, y: d.y });
  return (
    <svg viewBox={`-6 -6 ${GANTRY.travelX + 12} ${GANTRY.travelY + 12}`} className="block w-full border border-line bg-ground" role="img" aria-label={`Tank from above: ${found.size} of ${scenario.objects.length} objects found in this leg`} data-testid="tank-map">
      <clipPath id="tank-clip">
        <rect x={-5} y={-5} width={GANTRY.travelX + 10} height={GANTRY.travelY + 10} />
      </clipPath>
      <rect x={-5} y={-5} width={GANTRY.travelX + 10} height={GANTRY.travelY + 10} fill={LEG_TINT[step.leg % LEG_TINT.length]} stroke="#34465a" strokeWidth={0.4} />
      <g clipPath="url(#tank-clip)">
        <rect x={step.x - halfW} y={step.y - halfH} width={2 * halfW} height={2 * halfH} fill="#3db9b0" fillOpacity={0.08} stroke="#3db9b0" strokeOpacity={0.6} strokeWidth={0.25} strokeDasharray="1.2 1" style={{ transition: "x 500ms ease, y 500ms ease" }} />
        <polyline points={leg.map((s) => `${s.x},${s.y}`).join(" ")} fill="none" stroke="#3db9b0" strokeWidth={0.3} strokeOpacity={0.8} />
        {leg.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={0.8} fill="#0b1219" stroke="#3db9b0" strokeWidth={0.35} />
        ))}
        {scenario.objects.map((o) => {
          const f = found.get(o.id);
          return (
            <g key={o.id}>
              <title>{f ? `${f.cls} (${o.label})` : `${o.label}, not found`}</title>
              {f ? <rect x={o.x - 4} y={o.y - 3} width={8} height={6} fill="none" stroke="#f2a93b" strokeWidth={0.35} /> : <circle cx={o.x} cy={o.y} r={1.2} fill="none" stroke="#738496" strokeWidth={0.35} strokeDasharray="0.7 0.6" />}
              <text x={o.x} y={o.y - 3.8} textAnchor="middle" fontSize={1.7} fill={f ? "#e6edf3" : "#738496"} className="value">
                {f ? f.cls : "not found"}
              </text>
            </g>
          );
        })}
        <g style={{ transform: `translate(${step.x}px, ${step.y}px)`, transition: "transform 500ms ease" }}>
          <line x1={-2.4} x2={2.4} y1={0} y2={0} stroke="#e6edf3" strokeWidth={0.4} />
          <line x1={0} x2={0} y1={-2.4} y2={2.4} stroke="#e6edf3" strokeWidth={0.4} />
        </g>
      </g>
    </svg>
  );
}

function Timeline({ run, idx, onSeek, models }: { run: MissionRun; idx: number; onSeek: (i: number) => void; models: ModelProfile[] }) {
  const used = [...new Set(run.steps.map((s) => s.model))];
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="label">Model at each viewpoint</span>
        {used.map((m) => (
          <span key={m} className="inline-flex items-center gap-1.5 text-[11px] text-text">
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: seriesColor(m) }} aria-hidden />
            {models[m].name}
          </span>
        ))}
      </div>
      <div className="flex gap-3" data-testid="mission-timeline">
        {LEGS.map((leg, li) => {
          const items = run.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.leg === li);
          return (
            <div key={li} className="min-w-0" style={{ flex: Math.max(1, items.length) }}>
              <div className="flex gap-[2px]">
                {items.map(({ s, i }) => (
                  <button key={i} type="button" onClick={() => onSeek(i)} aria-label={`Viewpoint ${i + 1}: ${models[s.model].name}${s.switched ? ", switched" : ""}`} aria-current={i === idx ? "step" : undefined} className={clsx("relative h-7 min-w-[6px] flex-1", i === idx ? "outline outline-2 outline-text" : "", i > idx && "opacity-35")} style={{ background: seriesColor(s.model) }}>
                    {s.switched && <span className="absolute -top-1 left-0 h-9 w-[2px] bg-text" aria-hidden />}
                  </button>
                ))}
              </div>
              <div className="mt-1 truncate text-[11px] text-muted" title={leg.name}>
                {leg.name}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- switching ---------- */

function Switching({ roster, cfg, setCfg, world, learner, rows }: { roster: ModelProfile[]; cfg: SwitchConfig; setCfg: (c: SwitchConfig) => void; world: SwitchWorld; learner: SwitchLearner; rows: ReturnType<typeof evaluatePolicies> }) {
  const rank = [...rows].sort((a, b) => b.reward - a.reward);
  const colorOf = (r: (typeof rows)[number]) => (r.kind === "learned" ? "#3db9b0" : r.kind === "fixed" ? seriesColor(rows.filter((x) => x.kind === "fixed").indexOf(r)) : "#34465a");
  const num = (k: "switchCost" | "latencyWeight" | "latencyBudgetMs" | "drift", label: string, min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label className="flex flex-col gap-1 text-[12px] text-muted">
      <span className="flex justify-between">
        {label} <span className="value text-text">{fmt(cfg[k])}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} data-testid={`cfg-${k}`} />
    </label>
  );
  return (
    <div className="grid grid-cols-2 items-start gap-4 max-[1099px]:grid-cols-1">
      <Panel
        id="policy"
        label="Model switching"
        title="What the policy learned to run"
        note="Learned from sampled frame rewards only. It never sees the benchmark table. A change of water must be read twice before it acts."
        right={
          <button type="button" className="btn !py-1.5" onClick={() => download("gantrylab-switch-policy.json", JSON.stringify(exportPolicy(learner), null, 2))} data-testid="export-policy">
            Export policy
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-[2px]" data-testid="policy-map">
            <thead>
              <tr>
                <th className="text-left text-[11px] font-normal text-dim">Water / light</th>
                {LIGHTING.map((l) => (
                  <th key={l} className="pb-1 text-[11px] font-normal text-muted">
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TURBIDITY.map((t, ti) => (
                <tr key={t}>
                  <th scope="row" className="pr-2 text-left text-[12px] font-normal text-text">
                    {t}
                  </th>
                  {LIGHTING.map((l, li) => {
                    const c = ti * L + li;
                    const a = learner.settled(c);
                    const runner = [...learner.w[c]].sort((x, y) => y - x);
                    return (
                      <td key={l} className="h-12 border border-line px-2 align-middle" title={`${t} water, ${l} light: ${world.models.map((m, i) => `${m.name} ${world.expected(c, i, i).toFixed(2)}`).join(", ")}`}>
                        <span className="flex items-center gap-1.5 text-[11px] text-text">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: seriesColor(a) }} aria-hidden />
                          <span className="truncate">{roster[a].name}</span>
                        </span>
                        <span className="value text-[10px] text-dim">lead {(runner[0] - runner[1]).toFixed(2)}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 max-[479px]:grid-cols-1">
          {num("switchCost", "Cost of a switch (frames lost)", 0, 2, 0.05, (v) => v.toFixed(2))}
          {num("latencyWeight", "Weight on slow models", 0, 0.5, 0.01, (v) => v.toFixed(2))}
          {num("latencyBudgetMs", "Frame budget", 50, 1000, 10, (v) => `${v} ms`)}
          {num("drift", "How fast the water changes", 0.005, 0.2, 0.005, (v) => `${(v * 100).toFixed(1)}% per frame`)}
        </div>
        <p className="mt-3 text-[11px] text-dim">Moving a slider retrains from scratch ({learner.frames.toLocaleString("en-US")} frames) and re-evaluates.</p>
      </Panel>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel id="switch-eval" label="Held out" title="Score per frame on 60 unseen surveys" note="Every policy meets the same water and the same sensor errors. The oracle reads the water perfectly and knows every score.">
          <div data-testid="switch-eval">
            <RankBars max={Math.max(...rows.map((r) => r.reward)) * 1.02} min={0} format={(v) => v.toFixed(3)} rows={rank.map((r) => ({ name: r.name, value: r.reward, color: colorOf(r), strong: r.kind === "learned", note: r.switches ? `${r.switches.toFixed(0)} sw` : undefined }))} />
          </div>
        </Panel>
        <Panel id="switch-curve" label="Training" title="Reward while learning" note="Exploration falls from every frame to one in ten, so the curve stays below the final greedy policy.">
          <LineChart label="Mean reward per frame during training" xLabel="training frames" yLabel="reward per frame" height={190} series={[{ name: "Learner", color: "#3db9b0", points: learner.curve.map((c) => [c.frame, c.reward]) }]} />
        </Panel>
      </div>
    </div>
  );
}

/* ---------- navigation ---------- */

const ENV_LABEL = { all: "All waters", tank: "Tank", harbor: "Harbor", river: "River", deepsea: "Deep sea" } as const;
type EnvKey = keyof typeof ENV_LABEL;

function Navigation() {
  const [env, setEnv] = useState<EnvKey>("all");
  const [metric, setMetric] = useState<"score" | "found" | "correct" | "scanS">("score");
  const rows = NAV_HELD_OUT.map((h, i) => ({ id: h.strategy, name: STRATEGIES[h.strategy].name, s: h.scores[env], color: h.strategy === "learned" ? "#3db9b0" : seriesColor(i - 1) })).sort((a, b) => (metric === "scanS" ? a.s.scanS - b.s.scanS : b.s[metric] - a.s[metric]));
  const all = (id: string) => NAV_HELD_OUT.find((h) => h.strategy === id)!.scores;
  const hand = NAV_HELD_OUT.filter((h) => h.strategy !== "learned");
  const verdict = (Object.keys(ENV_LABEL) as EnvKey[])
    .filter((k) => k !== "all")
    .map((k) => {
      const b = hand.reduce((x, h) => (h.scores[k].score > x.scores[k].score ? h : x));
      return { k, d: all("learned")[k].score - b.scores[k].score };
    });
  const wins = verdict.filter((v) => v.d > 0.005).map((v) => ENV_LABEL[v.k].toLowerCase());
  const losses = verdict.filter((v) => v.d < -0.005).map((v) => ENV_LABEL[v.k].toLowerCase());
  return (
    <div className="grid grid-cols-2 items-start gap-4 max-[1099px]:grid-cols-1">
      <Panel id="navigation" label="Gantry navigation" title="Learned viewpoints against hand-written plans" note={`Mean of ${NAV_TRAINING.layouts} held-out layouts in the full lab engine (motion, dwell, 10 Hz detector). Score = 0.5 per object found, 1 per correct class, minus 0.5 per wrong label and 0.03 per second.`} right={<Link href="/lab" prefetch={false} className="btn !py-1.5">Run it in the lab</Link>}>
        <div className="mb-3 flex flex-wrap gap-2">
          <Seg label="Water" value={env} onChange={setEnv} options={(Object.keys(ENV_LABEL) as EnvKey[]).map((k) => ({ id: k, label: ENV_LABEL[k] }))} />
          <Seg label="Metric" value={metric} onChange={setMetric} options={[{ id: "score", label: "Score" }, { id: "found", label: "Found" }, { id: "correct", label: "Correct" }, { id: "scanS", label: "Scan time" }]} />
        </div>
        <div data-testid="nav-eval">
          <RankBars format={(v) => (metric === "scanS" ? `${v.toFixed(1)} s` : v.toFixed(2))} rows={rows.map((r) => ({ name: r.name, value: r.s[metric], color: r.color, strong: r.id === "learned" }))} />
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-muted" data-testid="nav-verdict">
          {wins.length ? `The learned planner scores best in ${wins.join(" and ")}.` : "The learned planner is not best in any single water."} {losses.length ? `A hand-written plan still beats it in ${losses.join(" and ")}.` : ""}{" "}
          Choose it in the lab under Scenario, Inspection strategy, &quot;Learned (RL)&quot;.
        </p>
      </Panel>
      <Trainer />
    </div>
  );
}

const EPISODES = 600;

function Trainer() {
  const trainer = useRef<NavTrainer | null>(null);
  const [view, setView] = useState<{ episode: number; curve: [number, number][]; weights: number[]; done: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const t = trainer.current;
      if (!t) return;
      t.step(10);
      const bin = 30;
      const curve: [number, number][] = [];
      for (let i = 0; i + bin <= t.curve.length; i += bin) curve.push([i + bin, t.curve.slice(i, i + bin).reduce((s, c) => s + c.reward, 0) / bin]);
      setView({ episode: t.episode, curve, weights: [...t.weights], done: t.done });
      if (t.done) setRunning(false);
    }, 0);
    return () => clearInterval(id);
  }, [running]);
  const start = () => {
    trainer.current = new NavTrainer({ episodes: EPISODES, seed: Math.floor(Date.now() % 100000) });
    setView(null);
    setRunning(true);
  };
  const shipped: [number, number][] = NAV_TRAINING.curve.map((v, i) => [((i + 1) * NAV_TRAINING.episodes) / NAV_TRAINING.curve.length, v]);
  const weights = view?.weights ?? NAV_WEIGHTS;
  const top = Math.max(...weights.map(Math.abs), 0.1);
  return (
    <Panel
      id="nav-training"
      label="Training"
      title={view ? `Training here: episode ${view.episode} of ${EPISODES}` : "How it was trained"}
      note="Random layouts in random waters. It learns how much each kind of view is worth, then plans five viewpoints ahead with that."
      right={
        <button type="button" className="btn !py-1.5" onClick={running ? () => setRunning(false) : start} data-testid="nav-train">
          {running ? "Stop" : "Train from scratch"}
        </button>
      }
    >
      <LineChart
        label="Scan reward while learning"
        xLabel="episode"
        yLabel="reward per scan"
        height={200}
        series={view && view.curve.length > 0 ? [{ name: "Shipped policy", color: "#34465a", points: shipped.filter((p) => p[0] <= EPISODES), dashed: true }, { name: "This run", color: "#3db9b0", points: view.curve }] : [{ name: "Shipped policy", color: "#3db9b0", points: shipped }]}
      />
      <div className="label mb-2 mt-4">Learned value of a viewpoint, per unit</div>
      <ul className="flex flex-col gap-1.5" data-testid="nav-weights">
        {FEATURES.map((f, i) => (
          <li key={f} className="grid grid-cols-[minmax(150px,240px)_1fr_56px] items-center gap-2">
            <span className="truncate text-[12px] text-muted" title={f}>
              {f}
            </span>
            <span className="relative h-3 bg-panel-2">
              <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" aria-hidden />
              <span className="absolute inset-y-0" style={{ left: `${50 + Math.min(0, (weights[i] / top) * 50)}%`, width: `${(Math.abs(weights[i]) / top) * 50}%`, background: weights[i] >= 0 ? "#3987e5" : "#d95926" }} />
            </span>
            <span className="value text-right text-[11px] text-text">{weights[i].toFixed(2)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-dim">Training here is a demonstration in your browser; the lab keeps the shipped weights (npm run rl:train).</p>
    </Panel>
  );
}
