"use client";

import clsx from "clsx";
import Link from "next/link";
import { useMemo, useState } from "react";
import { seriesColor } from "@/components/evaluation/charts/core";
import { CopyButton, EmptyState, ErrorNote, KindTag, PageShell, Panel, SkeletonRows } from "@/components/evaluation/ui";
import { WorkspaceNav } from "@/components/evaluation/WorkspaceNav";
import { adviseModel, adviseSet, type Advice } from "@/lib/bench/advise";
import { isCondition, routingGain, sharedBlindSpots, strengths, supported, winnerMap } from "@/lib/bench/compare";
import { LIGHTING, TURBIDITY, f1, precision, recall, sliceScore, type Counts, type ModelProfile, type Slice } from "@/lib/bench/profile";
import { BatchEvaluate } from "./BatchEvaluate";
import { HeatCell, LineChart, RankBars, Seg, Stat, download, pct } from "./charts";
import { SourceBar } from "./SourceBar";
import { useProfiles } from "./useProfiles";

const KEY_LABEL: Record<string, string> = { turbidity: "Turbidity", lighting: "Lighting", distance_m: "Distance", object_size: "Object size", occlusion: "Occlusion", ntu: "NTU", environment: "Environment", class: "Object class", motion_blur_px: "Motion blur", current_speed_mps: "Current", vehicle_speed_mps: "Vehicle speed", depth_m: "Depth" };
const keyLabel = (k: string) => KEY_LABEL[k] ?? k.replace(/_/g, " ");
const sliceName = (s: Slice) => `${keyLabel(s.key)}: ${s.bucket}`;

interface Pick {
  title: string;
  rows: { model: number; counts: Counts | null; hasPrecision: boolean }[];
}

export function Benchmark() {
  const p = useProfiles();
  return (
    <PageShell testId="benchmark">
      <WorkspaceNav active="benchmark" />
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-6 py-5 max-[759px]:px-4 max-[479px]:px-2 max-[479px]:py-3">
        <div>
          <h1 className="text-[24px] font-medium leading-tight text-text max-[479px]:text-[20px]">Model benchmark</h1>
          <p className="mt-1 max-w-[80ch] text-[13px] leading-relaxed text-muted">Where each vision model performs best, where it fails, and the specific changes that would help.</p>
        </div>
        <SourceBar p={p} />
        {p.error && <ErrorNote error={p.error} />}
        {p.loading ? <SkeletonRows rows={4} /> : p.profiles.length === 0 ? <EmptyState title="No measured models yet">Evaluate models below, or switch to the simulated roster.</EmptyState> : <Dashboard key={p.profiles.map((x) => x.id).join()} ps={p.profiles} />}
        <BatchEvaluate p={p} />
      </main>
    </PageShell>
  );
}

function Dashboard({ ps }: { ps: ModelProfile[] }) {
  const gain = useMemo(() => routingGain(ps), [ps]);
  const blind = useMemo(() => sharedBlindSpots(ps), [ps]);
  const best = ps.reduce((b, m, i) => ((f1(m.overall) ?? -1) > (f1(ps[b].overall) ?? -1) ? i : b), 0);
  const [pick, setPick] = useState<Pick | null>(null);
  return (
    <>
      <div className="grid grid-cols-4 gap-3 max-[1099px]:grid-cols-2 max-[479px]:grid-cols-1">
        <Stat label="Best single model" value={f1(ps[best].overall)?.toFixed(3) ?? "n/a"} sub={`${ps[best].name}, F1 over every condition`} tone="teal" />
        <Stat label="Switching by condition" value={gain ? gain.routed.f1.toFixed(3) : "n/a"} sub={gain ? `${gain.routed.f1 - gain.bestSingle.f1 >= 0 ? "+" : ""}${((gain.routed.f1 - gain.bestSingle.f1) * 100).toFixed(1)} points over ${ps[gain.bestSingle.index].name} alone` : "Needs turbidity and lighting varied together"} tone={gain ? "amber" : undefined} />
        <Stat label="Conditions no model handles" value={blind.length} sub={blind.length ? `Worst: ${keyLabel(blind[0].key)} ${blind[0].bucket}, best recall ${pct(blind[0].best)}` : "Some model reaches 50% recall in every tested condition"} tone={blind.length ? "danger" : undefined} />
        <Stat label="Models compared" value={ps.length} sub={ps[0].datasetName} />
      </div>

      <Scorecards ps={ps} />

      <div className="grid grid-cols-[7fr_5fr] items-start gap-4 max-[1099px]:grid-cols-1">
        <Matrix ps={ps} onPick={setPick} pick={pick} />
        <div className="flex min-w-0 flex-col gap-4">
          <Winners ps={ps} onPick={setPick} pick={pick} />
          <Drill ps={ps} pick={pick} />
        </div>
      </div>

      <Threshold ps={ps} />
      <Changes ps={ps} />
    </>
  );
}

function Scorecards({ ps }: { ps: ModelProfile[] }) {
  return (
    <Panel id="scorecards" label="Verdict" title="Where each model is best and where it fails" note="Condition slices with at least 10 labelled objects, ranked by F1 (recall where the condition is a property of the object).">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
        {ps.map((m, i) => {
          const s = strengths(m);
          const weakClass = Object.entries(m.byClass)
            .filter(([, c]) => supported(c))
            .sort((a, b) => recall(a[1])! - recall(b[1])!)[0];
          return (
            <article key={m.id} data-testid="scorecard" className="flex min-w-0 flex-col gap-2 border border-line bg-ground/40 p-3">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: seriesColor(i) }} aria-hidden />
                <h3 className="min-w-0 truncate text-[14px] font-medium text-text">{m.name}</h3>
              </div>
              <p className="text-[12px] leading-snug text-muted">{m.note}</p>
              <dl className="grid grid-cols-4 gap-2">
                {(
                  [
                    ["F1", f1(m.overall)?.toFixed(2)],
                    ["Precision", precision(m.overall)?.toFixed(2)],
                    ["Recall", recall(m.overall)?.toFixed(2)],
                    ["ms", m.latencyMs?.toFixed(0)],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt className="label text-[9px]">{k}</dt>
                    <dd className="value text-[14px] text-text">{v ?? "n/a"}</dd>
                  </div>
                ))}
              </dl>
              <Chips title="Best at" tone="teal" items={s.best.map((x) => `${sliceName(x)} ${sliceScore(x)!.toFixed(2)}`)} />
              <Chips title="Fails at" tone="danger" items={[...s.worst.map((x) => `${sliceName(x)} ${sliceScore(x)!.toFixed(2)}`), ...(weakClass ? [`Class: ${weakClass[0]} ${recall(weakClass[1])!.toFixed(2)}`] : [])]} />
              <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                <KindTag kind={m.latencyKind === "measured" ? "measured" : m.latencyKind === "simulated" ? "simulated" : m.latencyKind === "estimated" ? "estimated" : "not_measured"} />
                {m.runId && (
                  <Link href={`/reports/${m.runId}`} className="text-[12px] text-teal underline underline-offset-2">
                    Full report
                  </Link>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

function Chips({ title, items, tone }: { title: string; items: string[]; tone: "teal" | "danger" }) {
  return (
    <div>
      <div className={clsx("label mb-1 text-[9px]", tone === "teal" ? "!text-teal" : "!text-danger")}>{title}</div>
      <ul className="flex flex-wrap gap-1">
        {items.length === 0 && <li className="text-[11px] text-dim">nothing yet</li>}
        {items.map((t) => (
          <li key={t} className={clsx("border px-1.5 py-0.5 text-[11px] text-text", tone === "teal" ? "border-teal/40" : "border-danger/40")}>
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Matrix({ ps, onPick, pick }: { ps: ModelProfile[]; onPick: (p: Pick) => void; pick: Pick | null }) {
  const keys = useMemo(() => [...new Set(ps.flatMap((m) => m.slices.map((s) => s.key)))].filter((k) => isCondition(k) && new Set(ps.flatMap((m) => m.slices.filter((s) => s.key === k).map((s) => s.bucket))).size > 1), [ps]);
  const [key, setKey] = useState("turbidity");
  const options = ["class", ...keys];
  const cur = options.includes(key) ? key : (keys[0] ?? "class");
  const columns = useMemo(() => {
    if (cur === "class") return [...new Set(ps.flatMap((m) => Object.keys(m.byClass)))].map((bucket) => ({ bucket, at: (m: ModelProfile) => m.byClass[bucket] ?? null, hasPrecision: true }));
    const order = new Map<string, number>();
    for (const m of ps) for (const s of m.slices) if (s.key === cur) order.set(s.bucket, s.order);
    return [...order].sort((a, b) => a[1] - b[1]).map(([bucket]) => ({ bucket, at: (m: ModelProfile) => m.slices.find((s) => s.key === cur && s.bucket === bucket) ?? null, hasPrecision: ps.every((m) => m.slices.find((s) => s.key === cur && s.bucket === bucket)?.hasPrecision ?? true) }));
  }, [ps, cur]);
  const score = (c: Counts | null, hp: boolean) => (c && c.nGt > 0 ? (hp ? f1(c) : recall(c)) : null);
  const hp = columns.every((c) => c.hasPrecision);
  return (
    <Panel id="matrix" label="Condition matrix" title={`${hp ? "F1" : "Recall"} by ${keyLabel(cur).toLowerCase()}`} note="The amber dot marks the best model in a column. Select a cell to see every model there.">
      <Seg label="Condition" value={cur} onChange={setKey} options={options.map((k) => ({ id: k, label: keyLabel(k) }))} />
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-separate border-spacing-[2px]" data-testid="matrix">
          <thead>
            <tr>
              <th className="text-left text-[11px] font-normal text-dim">Model</th>
              {columns.map((c) => (
                <th key={c.bucket} className="px-1 pb-1 text-[11px] font-normal text-muted">
                  {c.bucket}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ps.map((m, i) => (
              <tr key={m.id}>
                <th scope="row" className="max-w-[170px] truncate pr-2 text-left text-[12px] font-normal text-text">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-[2px]" style={{ background: seriesColor(i) }} aria-hidden />
                  {m.name}
                </th>
                {columns.map((col) => {
                  const c = col.at(m);
                  const v = score(c, hp);
                  const top = Math.max(...ps.map((q) => score(col.at(q), hp) ?? -1));
                  const title = `${keyLabel(cur)}: ${col.bucket}`;
                  return (
                    <td key={col.bucket} className="p-0">
                      <HeatCell value={v} best={v !== null && v === top && ps.length > 1} low={!!c && !supported(c)} selected={pick?.title === title} title={c ? `${m.name}, ${title}: ${v?.toFixed(3) ?? "n/a"} (${c.tp} found, ${c.fn} missed, ${c.fp} false, ${c.nGt} objects)` : `${m.name}: no data`} onClick={() => onPick({ title, rows: ps.map((q, k) => ({ model: k, counts: col.at(q), hasPrecision: hp })) })} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-dim">Faded cells have fewer than 10 objects and are not evidence.</p>
    </Panel>
  );
}

function Winners({ ps, onPick, pick }: { ps: ModelProfile[]; onPick: (p: Pick) => void; pick: Pick | null }) {
  const map = useMemo(() => winnerMap(ps), [ps]);
  return (
    <Panel id="winners" label="Winner map" title="Which model to run in which water" right={<Link href="/autonomy" className="btn !py-1">Train switching</Link>}>
      {!map ? (
        <EmptyState title="No joint cells">At least one run did not vary turbidity and lighting together, or was made before the backend reported joint cells. Re-run those models on a dataset that sweeps both.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-[2px]" data-testid="winner-map">
            <thead>
              <tr>
                <th className="text-left text-[11px] font-normal text-dim">Water / light</th>
                {LIGHTING.map((l) => (
                  <th key={l} className="px-1 pb-1 text-[11px] font-normal text-muted">
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {map.map((row, t) => (
                <tr key={TURBIDITY[t]}>
                  <th scope="row" className="pr-2 text-left text-[12px] font-normal text-text">
                    {TURBIDITY[t]}
                  </th>
                  {row.map((c) => {
                    const title = `${TURBIDITY[t]} water, ${LIGHTING[c.l]} light`;
                    return (
                      <td key={c.l} className="p-0">
                        <button type="button" aria-pressed={pick?.title === title} onClick={() => onPick({ title, rows: ps.map((q, k) => ({ model: k, counts: q.cells![c.t][c.l], hasPrecision: true })) })} className={clsx("flex h-14 w-full min-w-[84px] flex-col items-start justify-center gap-0.5 border px-2 text-left", pick?.title === title ? "border-amber" : "border-line hover:border-line-strong")}>
                          {c.winner === null ? (
                            <span className="text-[11px] text-dim">{c.scores.some((s) => s !== null) ? "none works" : "no data"}</span>
                          ) : (
                            <>
                              <span className="flex max-w-full items-center gap-1.5 text-[11px] text-text">
                                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: seriesColor(c.winner) }} aria-hidden />
                                <span className="truncate">{ps[c.winner].name}</span>
                              </span>
                              <span className="value text-[11px] text-muted">
                                {c.scores[c.winner]!.toFixed(2)} {c.margin > 0 && <span className={c.margin < 0.02 ? "text-dim" : "text-teal"}>+{c.margin.toFixed(2)}</span>}
                              </span>
                            </>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Drill({ ps, pick }: { ps: ModelProfile[]; pick: Pick | null }) {
  return (
    <Panel id="drill" label="Selected condition" title={pick ? pick.title : "Select a cell"}>
      {!pick ? (
        <p className="text-[12px] text-muted">Choose any cell in the matrix or the winner map to compare every model in that condition.</p>
      ) : (
        <div data-testid="drill" className="flex flex-col gap-3">
          <RankBars max={1} format={(v) => v.toFixed(2)} rows={pick.rows.filter((r) => r.counts).map((r) => ({ name: ps[r.model].name, color: seriesColor(r.model), value: (r.hasPrecision ? f1(r.counts!) : recall(r.counts!)) ?? 0 })).sort((a, b) => b.value - a.value)} />
          <table className="value w-full text-left text-[11px]">
            <thead className="text-dim">
              <tr>
                {["Model", "Found", "Missed", "False", "Objects"].map((h) => (
                  <th key={h} className="py-1 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pick.rows.map((r) => (
                <tr key={r.model} className="border-t border-line text-text">
                  <td className="max-w-[140px] truncate py-1 pr-2">{ps[r.model].name}</td>
                  <td>{r.counts?.tp ?? "n/a"}</td>
                  <td>{r.counts?.fn ?? "n/a"}</td>
                  <td>{r.counts && r.hasPrecision ? r.counts.fp : "n/a"}</td>
                  <td>{r.counts?.nGt ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Threshold({ ps }: { ps: ModelProfile[] }) {
  const [id, setId] = useState(ps[0].id);
  const m = ps.find((x) => x.id === id) ?? ps[0];
  const [conf, setConf] = useState<number | null>(null);
  const pts = m.sweep.filter((s) => s.f1 !== null && s.precision !== null && s.recall !== null);
  const c = conf ?? m.conf;
  const near = pts.reduce<(typeof pts)[number] | null>((b, s) => (!b || Math.abs(s.conf - c) < Math.abs(b.conf - c) ? s : b), null);
  if (!near) return null;
  return (
    <Panel
      id="threshold"
      label="What if"
      title="Confidence threshold"
      note="Recomputed from the stored detections, so this effect is exact on this benchmark."
      right={
        <Seg
          label="Model"
          value={m.id}
          onChange={(v) => {
            setId(v);
            setConf(null);
          }}
          options={ps.map((x) => ({ id: x.id, label: x.name }))}
        />
      }
    >
      <div className="grid grid-cols-[1fr_260px] gap-5 max-[899px]:grid-cols-1">
        <LineChart
          label={`Precision, recall and F1 of ${m.name} against the confidence threshold`}
          xLabel="confidence threshold"
          yLabel="score"
          yRange={[0, 1]}
          marker={{ x: near.conf, label: `conf ${near.conf.toFixed(2)}` }}
          series={[
            { name: "F1", color: seriesColor(0), points: pts.map((s) => [s.conf, s.f1!]) },
            { name: "Precision", color: seriesColor(1), points: pts.map((s) => [s.conf, s.precision!]) },
            { name: "Recall", color: seriesColor(2), points: pts.map((s) => [s.conf, s.recall!]) },
          ]}
        />
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Threshold {near.conf.toFixed(2)}
            <input type="range" min={pts[0].conf} max={pts[pts.length - 1].conf} step={0.01} value={c} onChange={(e) => setConf(Number(e.target.value))} data-testid="threshold-slider" />
          </label>
          {(
            [
              ["F1", near.f1!, f1(m.overall) ?? 0],
              ["Precision", near.precision!, precision(m.overall) ?? 0],
              ["Recall", near.recall!, recall(m.overall) ?? 0],
            ] as const
          ).map(([k, v, base]) => (
            <div key={k} className="flex items-baseline justify-between border-b border-line pb-1">
              <span className="text-[12px] text-muted">{k}</span>
              <span className="value text-[14px] text-text" data-testid={`whatif-${k}`}>
                {v.toFixed(3)}{" "}
                <span className={clsx("text-[11px]", v - base > 0.0005 ? "text-ok" : v - base < -0.0005 ? "text-danger" : "text-dim")}>
                  {v - base >= 0 ? "+" : ""}
                  {(v - base).toFixed(3)}
                </span>
              </span>
            </div>
          ))}
          <p className="text-[11px] text-dim">Change against the deployed threshold {m.conf.toFixed(2)}.</p>
        </div>
      </div>
    </Panel>
  );
}

const KIND_LABEL: Record<Advice["kind"], string> = { threshold: "Threshold", augmentation: "Training", data: "Data", resolution: "Resolution", routing: "Switching", operation: "Operation", compute: "Compute" };

function Changes({ ps }: { ps: ModelProfile[] }) {
  const [budget, setBudget] = useState(300);
  const advice = useMemo(() => [...adviseSet(ps), ...ps.flatMap((m) => adviseModel(m, budget))], [ps, budget]);
  const [who, setWho] = useState("all");
  const shown = advice.filter((a) => who === "all" || (who === "set" ? a.modelId === null : a.modelId === who)).sort((a, b) => (b.effect ? b.effect.after - b.effect.before : 0) - (a.effect ? a.effect.after - a.effect.before : 0));
  const name = (a: Advice) => ps.find((m) => m.id === a.modelId)?.name ?? "All models";
  const markdown = shown.map((a, i) => `${i + 1}. **${a.title}** (${name(a)})\n   - Change: ${a.change}\n   - Evidence: ${a.evidence}\n   - Trade-off: ${a.tradeoff}${a.effect ? `\n   - F1 ${a.effect.before.toFixed(3)} -> ${a.effect.after.toFixed(3)} (${a.effect.basis})` : ""}`).join("\n");
  return (
    <Panel
      id="changes"
      label="What to change"
      title={`${shown.length} specific changes`}
      note="Exact effects are recomputed from stored detections. An upper bound is what closing the gap completely would give: retraining cannot be predicted, so it is never claimed."
      right={
        <>
          <CopyButton text={markdown} label="Copy as Markdown" className="h-8" />
          <button type="button" className="btn !py-1.5" onClick={() => download("gantrylab-changes.json", JSON.stringify({ models: ps.map((m) => ({ id: m.id, name: m.name, source: m.source })), changes: shown }, null, 2))}>
            Export
          </button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Seg label="Model" value={who} onChange={setWho} options={[{ id: "all", label: "All" }, { id: "set", label: "Across models" }, ...ps.map((m) => ({ id: m.id, label: m.name }))]} />
        <label className="flex items-center gap-2 text-[12px] text-muted">
          Frame budget
          <input type="number" min={10} max={5000} step={10} value={budget} onChange={(e) => setBudget(Math.min(5000, Math.max(10, Number(e.target.value) || 10)))} className="value w-20 border border-line-strong bg-ground px-2 py-1 text-[12px] text-text" />
          ms
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="text-[12px] text-muted">Nothing to change here on this evidence.</p>
      ) : (
        <ol className="grid grid-cols-2 gap-3 max-[1099px]:grid-cols-1" data-testid="changes-list">
          {shown.map((a) => (
            <li key={a.id} className="flex min-w-0 flex-col gap-2 border border-line bg-ground/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="sim-tag">{KIND_LABEL[a.kind].toUpperCase()}</span>
                <span className="text-[11px] text-dim">{name(a)}</span>
              </div>
              <h3 className="text-[14px] font-medium leading-snug text-text">{a.title}</h3>
              <p className="value break-words border-l-2 border-amber/70 pl-2 text-[11px] leading-relaxed text-text">{a.change}</p>
              <p className="text-[12px] leading-snug text-muted">{a.evidence}</p>
              {a.effect && (
                <div className="flex flex-col gap-1">
                  <RankBars
                    max={1}
                    format={(v) => v.toFixed(3)}
                    rows={[
                      { name: "F1 now", value: a.effect.before, color: "#34465a" },
                      { name: a.effect.basis === "exact" ? "F1 after" : "F1 at most", value: a.effect.after, color: seriesColor(0), strong: true },
                    ]}
                  />
                  <span className="text-[11px] text-dim">{a.effect.basis === "exact" ? "Exact on this benchmark" : "Upper bound, not a prediction"}</span>
                </div>
              )}
              <p className="text-[11px] leading-snug text-dim">Trade-off: {a.tradeoff}</p>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
