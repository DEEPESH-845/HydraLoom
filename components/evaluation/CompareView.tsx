"use client";

import clsx from "clsx";
import { Fragment, useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { useResource } from "@/lib/api/hooks";
import type { CompareRun, Delta, SliceDelta } from "@/lib/api/types";
import { ErrorNote, fmt, fmtSigned, KindTag, shortSha, SkeletonRows } from "./ui";

const TYPE_LABEL: Record<string, string> = {
  models: "Model comparison (same dataset)",
  environments: "Environment comparison (same model)",
  models_and_environments: "Different model and different dataset",
  repeat: "Repeat (same model, same dataset)",
};

/** Diverging delta: a bar from the centre, right for b > a. Text stays in text tokens. */
function DeltaCell({ d, digits = 3, lowerIsBetter }: { d: Delta | undefined; digits?: number; lowerIsBetter?: boolean }) {
  if (!d) return <td className="px-2 py-1 text-dim">n/a</td>;
  const v = d.delta;
  const good = v !== null && (lowerIsBetter ? v < 0 : v > 0);
  const w = v === null ? 0 : Math.min(1, Math.abs(v) / (lowerIsBetter ? Math.max(1e-9, Math.abs(d.a ?? 0), Math.abs(d.b ?? 0)) : 1));
  return (
    <td className="px-2 py-1">
      <div className="flex items-center justify-end gap-2">
        <span className="relative hidden h-1.5 w-16 bg-panel-2 min-[480px]:block" aria-hidden>
          <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
          {v !== null && v !== 0 && (
            <span
              className={clsx("absolute inset-y-0", good ? "bg-teal" : "bg-danger")}
              style={v > 0 ? { left: "50%", width: `${w * 50}%` } : { right: "50%", width: `${w * 50}%` }}
            />
          )}
        </span>
        <span className="value w-14 text-right text-text">{fmtSigned(v, digits)}</span>
      </div>
    </td>
  );
}

function RunCard({ r, tag }: { r: CompareRun; tag: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="value border border-line-strong px-1.5 text-[11px] text-text">{tag}</span>
        <span className="value truncate text-[12px] text-text">{r.run_id}</span>
        {r.mock && <span className="sim-tag !border-danger/70 !text-danger">MOCK</span>}
      </div>
      <span className="truncate text-[12px] text-muted">
        {String(r.model.name ?? "model")} v{String(r.model.version ?? "?")} <span className="value text-dim">{shortSha(String(r.model.sha256 ?? ""))}</span>
      </span>
      <span className="truncate text-[12px] text-muted">
        {String(r.dataset.name ?? "dataset")} · {r.adapter}
      </span>
      <span className="flex items-center gap-2 text-[11px] text-muted">
        <KindTag kind={r.hardware.kind} /> p50 {fmt(r.latency_ms_p50, 1)} ms
      </span>
    </div>
  );
}

export function CompareView({ a, b }: { a: string; b: string }) {
  const res = useResource(`compare:${a},${b}`, (s) => api.compare(a, b, s));
  const [slicesLowSupport, setSlicesLowSupport] = useState(true);
  const sliceDeltas = res.data?.slice_deltas;
  const sliceGroups = useMemo(() => {
    const g = new Map<string, SliceDelta[]>();
    for (const s of sliceDeltas ?? []) {
      if (!slicesLowSupport && s.low_support) continue;
      if (!g.has(s.key)) g.set(s.key, []);
      g.get(s.key)!.push(s);
    }
    return [...g.entries()];
  }, [sliceDeltas, slicesLowSupport]);

  if (res.loading) return <SkeletonRows rows={5} />;
  if (res.error) return <ErrorNote error={res.error} onRetry={res.reload} />;
  const c = res.data!;
  const classes = Object.keys(c.per_class_deltas);

  return (
    <div className="flex flex-col gap-4" data-testid="compare-view">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label text-text">{TYPE_LABEL[c.comparison_type] ?? c.comparison_type}</span>
        <span className="text-[11px] text-dim">delta = B - A</span>
      </div>
      <div className="grid grid-cols-2 gap-2 max-[759px]:grid-cols-1">
        {c.runs[0] && <RunCard r={c.runs[0]} tag="A" />}
        {c.runs[1] && <RunCard r={c.runs[1]} tag="B" />}
      </div>
      {c.notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[11px] text-muted">
          {c.notes.map((n) => (
            <li key={n} className={clsx(n.includes("MOCK") && "text-danger")}>
              {n}
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-4 max-[1099px]:grid-cols-1">
        <div className="min-w-0">
          <div className="label mb-1.5">Overall</div>
          <div className="relative overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="label px-2 py-1 font-normal">Metric</th>
                  <th className="label px-2 py-1 text-right font-normal">A</th>
                  <th className="label px-2 py-1 text-right font-normal">B</th>
                  <th className="label px-2 py-1 text-right font-normal">Delta</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(c.overall_deltas).map(([k, d]) => (
                  <tr key={k} className="border-b border-line/60">
                    <td className="value px-2 py-1 text-muted">{k}</td>
                    <td className="value px-2 py-1 text-right text-text">{fmt(d.a, k.includes("latency") ? 1 : 3)}</td>
                    <td className="value px-2 py-1 text-right text-text">{fmt(d.b, k.includes("latency") ? 1 : 3)}</td>
                    <DeltaCell d={d} digits={k.includes("latency") ? 1 : 3} lowerIsBetter={k.includes("latency")} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="min-w-0">
          <div className="label mb-1.5">Per class (delta)</div>
          <div className="relative overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="label px-2 py-1 font-normal">Class</th>
                  <th className="label px-2 py-1 text-right font-normal">Recall</th>
                  <th className="label px-2 py-1 text-right font-normal">Precision</th>
                  <th className="label px-2 py-1 text-right font-normal">AP50</th>
                </tr>
              </thead>
              <tbody>
                {classes.map((cl) => (
                  <tr key={cl} className="border-b border-line/60">
                    <td className="value px-2 py-1 text-text">{cl}</td>
                    <DeltaCell d={c.per_class_deltas[cl].recall} />
                    <DeltaCell d={c.per_class_deltas[cl].precision} />
                    <DeltaCell d={c.per_class_deltas[cl].ap50} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="min-w-0">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <span className="label">Per slice (delta)</span>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
            <input type="checkbox" className="accent-teal" checked={slicesLowSupport} onChange={(e) => setSlicesLowSupport(e.target.checked)} /> Show low-support slices
          </label>
        </div>
        <div className="relative max-h-[420px] overflow-auto border border-line">
          <table className="w-full min-w-[560px] text-[12px]">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-line text-left">
                <th className="label px-2 py-1 font-normal">Bucket</th>
                <th className="label px-2 py-1 text-right font-normal">n_gt A / B</th>
                <th className="label px-2 py-1 text-right font-normal">Recall</th>
                <th className="label px-2 py-1 text-right font-normal">Precision</th>
                <th className="label px-2 py-1 text-right font-normal">F1</th>
              </tr>
            </thead>
            <tbody>
              {sliceGroups.map(([key, rows]) => (
                <Fragment key={key}>
                  <tr className="bg-panel-2/60">
                    <td colSpan={5} className="label px-2 py-1 text-text">
                      {key}
                    </td>
                  </tr>
                  {rows.map((s) => (
                    <tr key={s.id} className={clsx("border-b border-line/60", s.low_support && "opacity-50")} data-low-support={s.low_support}>
                      <td className="value px-2 py-1 text-text">
                        {s.bucket}
                        {s.low_support && <span className="sim-tag ml-2 !text-[8px]">LOW SUPPORT</span>}
                      </td>
                      <td className="value px-2 py-1 text-right text-muted">
                        {s.n_gt_a ?? "n/a"} / {s.n_gt_b ?? "n/a"}
                      </td>
                      <DeltaCell d={s.recall} />
                      <DeltaCell d={s.precision} />
                      <DeltaCell d={s.f1} />
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
