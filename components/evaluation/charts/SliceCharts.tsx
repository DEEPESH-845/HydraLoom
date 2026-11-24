"use client";

import clsx from "clsx";
import { useMemo, useState } from "react";
import type { Sensitivity, SliceMetrics, SliceRanking } from "@/lib/api/types";
import { fmt, fmtSigned } from "../ui";
import { seriesColor } from "./core";

export const SLICE_KEY_LABEL: Record<string, string> = {
  environment: "Environment",
  turbidity: "Turbidity",
  ntu: "Turbidity (NTU)",
  lighting: "Lighting",
  current_speed_mps: "Current speed",
  current_dir_deg: "Current direction",
  depth_m: "Depth",
  distance_m: "Distance to object",
  object_size: "Object size",
  occlusion: "Occlusion",
  vehicle_speed_mps: "Vehicle speed",
  motion_blur_px: "Motion blur",
  platform: "Platform",
};

/** Keys from the brief first, in this order; anything else the backend sliced follows. */
const KEY_ORDER = ["environment", "turbidity", "ntu", "lighting", "current_speed_mps", "current_dir_deg", "depth_m", "distance_m", "object_size", "occlusion", "vehicle_speed_mps", "motion_blur_px"];

type Metric = "f1" | "recall" | "precision" | "ap50";
const METRICS: { id: Metric; label: string }[] = [
  { id: "f1", label: "F1" },
  { id: "recall", label: "Recall" },
  { id: "precision", label: "Precision" },
  { id: "ap50", label: "AP50" },
];

export function groupSlices(slices: SliceMetrics[]) {
  const g = new Map<string, SliceMetrics[]>();
  for (const s of slices) {
    if (!g.has(s.key)) g.set(s.key, []);
    g.get(s.key)!.push(s);
  }
  for (const v of g.values()) v.sort((a, b) => a.order - b.order);
  return [...g.entries()].sort((a, b) => {
    const ia = KEY_ORDER.indexOf(a[0]);
    const ib = KEY_ORDER.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
  });
}

/**
 * Per-condition small multiples. One series, one colour; each bar carries its support (n_gt).
 * Low-support slices (n_gt < min_support) are faded and labelled. BEST / WORST come from the
 * backend `slice_ranking`, never recomputed here.
 */
export function SliceSensitivity({ slices, ranking, sensitivity }: { slices: SliceMetrics[]; ranking: SliceRanking; sensitivity: Sensitivity[] }) {
  const [metric, setMetric] = useState<Metric>("f1");
  const [showLow, setShowLow] = useState(true);
  const groups = useMemo(() => groupSlices(slices), [slices]);
  const best = new Map(ranking.best.map((r, i) => [r.id, i + 1]));
  const worst = new Map(ranking.worst.map((r, i) => [r.id, i + 1]));
  const sens = new Map(sensitivity.map((s) => [s.key, s]));

  return (
    <div className="flex flex-col gap-3" data-testid="slice-sensitivity">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex border border-line" role="group" aria-label="Slice metric">
          {METRICS.map((m, i) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={metric === m.id}
              onClick={() => setMetric(m.id)}
              className={clsx("px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em]", i > 0 && "border-l border-line", metric === m.id ? "bg-panel-2 text-text" : "text-dim hover:text-text")}
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
          <input type="checkbox" className="accent-teal" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} />
          Show low-support slices (n_gt &lt; {ranking.min_support})
        </label>
        <span className="text-[11px] text-dim">
          {ranking.n_eligible} slices ranked, {ranking.n_excluded_low_support} excluded for low support
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3 max-[1279px]:grid-cols-2 max-[759px]:grid-cols-1">
        {groups.map(([key, rows]) => {
          const recallOnly = rows[0]?.scope === "recall_only";
          const m: Metric = recallOnly && metric !== "recall" ? "recall" : metric;
          const visible = rows.filter((r) => showLow || !r.low_support);
          const s = sens.get(key);
          return (
            <div key={key} className="flex min-w-0 flex-col gap-2 border border-line p-3" data-slice-key={key}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="text-[13px] text-text">{SLICE_KEY_LABEL[key] ?? key}</span>
                <span className="value text-[10px] text-dim">
                  {key} · {rows[0]?.kind}
                  {m !== metric && " · recall only"}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {visible.map((r) => {
                  const v = r[m];
                  const bRank = best.get(r.id);
                  const wRank = worst.get(r.id);
                  return (
                    <div
                      key={r.id}
                      className={clsx("grid grid-cols-[minmax(52px,26%)_1fr_auto] items-center gap-2", r.low_support && "opacity-45")}
                      data-low-support={r.low_support}
                      title={`${key}=${r.bucket}: ${m} ${fmt(v)}, n_gt ${r.n_gt}, ${r.n_frames} frames, TP ${r.tp}, FN ${r.fn}${r.fp !== null ? `, FP ${r.fp}` : ""}`}
                    >
                      <span className="value truncate text-[11px] text-muted">{r.bucket}</span>
                      <span className="relative h-3 bg-panel-2/70">
                        {v !== null && <span className="absolute inset-y-0 left-0 rounded-r-[3px]" style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%`, background: seriesColor(0) }} />}
                        {v === null && <span className="absolute inset-0 flex items-center pl-1 font-mono text-[9px] text-dim">n/a</span>}
                      </span>
                      <span className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                        <span className="value w-10 text-right text-[11px] text-text">{fmt(v)}</span>
                        <span className="value w-12 text-right text-[10px] text-dim">n={r.n_gt}</span>
                        <span className="flex w-[46px] justify-start">
                        {bRank && (
                          <span className="sim-tag !px-1 !text-[8px] !border-teal/70 !text-teal" title={`Best condition #${bRank} (backend ranking by ${ranking.best[bRank - 1].metric})`}>
                            BEST
                          </span>
                        )}
                        {wRank && (
                          <span className="sim-tag !px-1 !text-[8px] !border-amber/70 !text-amber" title={`Worst condition #${wRank} (backend ranking by ${ranking.worst[wRank - 1].metric})`}>
                            WORST
                          </span>
                        )}
                        {!bRank && !wRank && r.low_support && <span className="sim-tag !px-1 !text-[8px]">LOW</span>}
                        </span>
                      </span>
                    </div>
                  );
                })}
                {!visible.length && <span className="text-[11px] text-dim">Every bucket is low support.</span>}
              </div>
              {s && (
                <p className="mt-0.5 border-t border-line/60 pt-1.5 text-[10px] leading-snug text-dim">
                  Recall slope {fmtSigned(s.slope_per_unit)} per unit · range {fmt(s.recall_range[0])} to {fmt(s.recall_range[1])} (delta {fmt(s.delta_recall)}). Association, not causation.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
