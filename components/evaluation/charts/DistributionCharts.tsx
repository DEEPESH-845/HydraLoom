"use client";

import clsx from "clsx";
import { useState } from "react";
import type { ConfidenceHistogram, ConfusionMatrix } from "@/lib/api/types";
import { fmt } from "../ui";
import { AXIS, barPath, ChartTableToggle, GRID, LegendItem, SEQ_HUE, seriesColor, TEXT_DIM, TipRow, Tooltip, useWidth } from "./core";

const M = { top: 12, right: 18, bottom: 34, left: 40 };

function niceMax(v: number) {
  if (v <= 5) return Math.max(1, Math.ceil(v));
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** TP versus FP prediction counts per confidence bin (grouped columns, one baseline). */
export function ConfidenceHistogramChart({ hist, conf }: { hist: ConfidenceHistogram; conf: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null);
  const [table, setTable] = useState(false);
  const nb = hist.tp.length;
  const h = Math.max(200, Math.min(280, w * 0.55));
  const iw = w - M.left - M.right;
  const ih = h - M.top - M.bottom;
  const max = niceMax(Math.max(1, ...hist.tp, ...hist.fp));
  const band = iw / nb;
  const bw = Math.min(24, Math.max(3, (band - 8) / 2 - 1));
  const Y = (v: number) => M.top + ih * (1 - v / max);
  const yt = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max).filter((v, i, a) => a.indexOf(v) === i && (max > 4 || Number.isInteger(v)));
  const colors = { tp: seriesColor(0), fp: seriesColor(1) };

  return (
    <div ref={ref} className="flex flex-col gap-2" data-testid="conf-histogram">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-2">
          <LegendItem color={colors.tp} label="True positives" />
          <LegendItem color={colors.fp} label="False positives" />
          <span className="text-[10px] text-dim">match IoU {fmt(hist.iou_threshold, 2)} · operating conf {fmt(conf, 2)}</span>
        </div>
        <ChartTableToggle table={table} onChange={setTable} />
      </div>
      {table ? (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-line">
              <th className="label px-2 py-1 text-left font-normal">Confidence</th>
              <th className="label px-2 py-1 text-right font-normal">TP</th>
              <th className="label px-2 py-1 text-right font-normal">FP</th>
            </tr>
          </thead>
          <tbody>
            {hist.tp.map((tp, i) => (
              <tr key={i} className="border-b border-line/50">
                <td className="value px-2 py-0.5 text-muted">
                  {fmt(hist.bins[i], 1)}-{fmt(hist.bins[i + 1], 1)}
                </td>
                <td className="value px-2 py-0.5 text-right text-text">{tp}</td>
                <td className="value px-2 py-0.5 text-right text-text">{hist.fp[i]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="relative w-full" onPointerLeave={() => setHover(null)}>
          <svg width={w} height={h} role="img" aria-label={`Confidence histogram: ${hist.tp.reduce((a, b) => a + b, 0)} true positives, ${hist.fp.reduce((a, b) => a + b, 0)} false positives.`}>
            {yt.map((v) => (
              <g key={v}>
                <line x1={M.left} x2={M.left + iw} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? AXIS : GRID} />
                <text x={M.left - 6} y={Y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill={TEXT_DIM} className="value">
                  {Number.isInteger(v) ? v : v.toFixed(1)}
                </text>
              </g>
            ))}
            {hist.bins.map((b, i) =>
              i % 2 === 0 || iw > 420 ? (
                <text key={i} x={M.left + band * i} y={M.top + ih + 14} textAnchor="middle" fontSize={10} fill={TEXT_DIM} className="value">
                  {b.toFixed(1)}
                </text>
              ) : null,
            )}
            <text x={M.left + iw / 2} y={h - 4} textAnchor="middle" fontSize={10} fill={TEXT_DIM} className="label">
              Confidence
            </text>
            {hist.tp.map((tp, i) => {
              const cx = M.left + band * i + band / 2;
              const fp = hist.fp[i];
              return (
                <g key={i}>
                  <path d={barPath(cx - bw - 1, Y(tp), bw, Y(0) - Y(tp))} fill={colors.tp} opacity={hover && hover.i !== i ? 0.45 : 1} />
                  <path d={barPath(cx + 1, Y(fp), bw, Y(0) - Y(fp))} fill={colors.fp} opacity={hover && hover.i !== i ? 0.45 : 1} />
                  <rect
                    x={M.left + band * i}
                    y={M.top}
                    width={band}
                    height={ih}
                    fill="transparent"
                    onPointerMove={(e) => {
                      const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                      setHover({ i, px: e.clientX - rect.left, py: e.clientY - rect.top });
                    }}
                  />
                </g>
              );
            })}
            {/* operating threshold */}
            <line x1={M.left + conf * iw} x2={M.left + conf * iw} y1={M.top} y2={M.top + ih} stroke="#e6edf3" strokeDasharray="3 3" opacity={0.7} pointerEvents="none" />
          </svg>
          {hover && (
            <Tooltip x={hover.px} y={hover.py} containerWidth={w}>
              <div className="label mb-1 text-[9px]">
                conf {fmt(hist.bins[hover.i], 1)} to {fmt(hist.bins[hover.i + 1], 1)}
              </div>
              <TipRow color={colors.tp} name="TP" value={String(hist.tp[hover.i])} />
              <TipRow color={colors.fp} name="FP" value={String(hist.fp[hover.i])} />
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

/** Confusion matrix heatmap, rows = ground truth, columns = prediction, with the background row and column. */
export function ConfusionHeatmap({ cm }: { cm: ConfusionMatrix }) {
  const [normalize, setNormalize] = useState(false);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const n = cm.labels.length;
  const rowSums = cm.matrix.map((r) => r.reduce((a, b) => a + b, 0));
  const vals = cm.matrix.map((r, i) => r.map((v) => (normalize ? (rowSums[i] ? v / rowSums[i] : 0) : v)));
  const max = Math.max(1e-9, ...vals.flat());
  const short = (l: string) => (l === "background" ? "BG" : l.length > 9 ? l.slice(0, 8) + "." : l);

  return (
    <div className="flex flex-col gap-2" data-testid="confusion-matrix">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] text-dim">
          {cm.axes} · same-class IoU {fmt(cm.iou_same_class, 2)} · confusion IoU {fmt(cm.iou_confusion, 2)} · conf {fmt(cm.conf, 2)}
        </span>
        <div className="inline-flex border border-line" role="group" aria-label="Cell values">
          {[false, true].map((nv) => (
            <button
              key={String(nv)}
              type="button"
              aria-pressed={normalize === nv}
              onClick={() => setNormalize(nv)}
              className={clsx("px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]", nv && "border-l border-line", normalize === nv ? "bg-panel-2 text-text" : "text-dim hover:text-text")}
            >
              {nv ? "Row %" : "Counts"}
            </button>
          ))}
        </div>
      </div>
      <div className="relative overflow-x-auto">
        <table className="border-separate border-spacing-[2px] text-[11px]" onPointerLeave={() => setHover(null)}>
          <thead>
            <tr>
              <th className="p-0" />
              <th className="label px-1 pb-1 text-left text-[9px] font-normal" colSpan={n}>
                Predicted
              </th>
            </tr>
            <tr>
              <th className="label pr-2 text-right text-[9px] font-normal">Ground truth</th>
              {cm.labels.map((l, j) => (
                <th key={l} scope="col" title={l} className={clsx("value h-7 min-w-[56px] px-1 text-center text-[10px] font-normal", hover?.[1] === j ? "text-text" : "text-muted")}>
                  {short(l)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cm.matrix.map((row, i) => (
              <tr key={cm.labels[i]}>
                <th scope="row" title={cm.labels[i]} className={clsx("value whitespace-nowrap pr-2 text-right text-[10px] font-normal", hover?.[0] === i ? "text-text" : "text-muted")}>
                  {cm.labels[i] === "background" ? "background" : cm.labels[i]}
                </th>
                {row.map((v, j) => {
                  const t = vals[i][j] / max;
                  const bg = v === 0 ? "transparent" : `rgba(${SEQ_HUE}, ${(0.12 + 0.88 * t).toFixed(3)})`;
                  const light = t > 0.55;
                  const diag = i === j && cm.labels[i] !== "background";
                  const label = normalize ? (rowSums[i] ? `${Math.round(vals[i][j] * 100)}%` : "-") : String(v);
                  return (
                    <td
                      key={j}
                      onPointerEnter={() => setHover([i, j])}
                      title={`GT ${cm.labels[i]} -> predicted ${cm.labels[j]}: ${v}${rowSums[i] ? ` (${Math.round((v / rowSums[i]) * 100)}% of row)` : ""}`}
                      className={clsx(
                        "value h-10 min-w-[56px] rounded-[3px] px-1 text-center",
                        v === 0 ? "bg-panel-2/50 text-dim" : light ? "text-white" : "text-text",
                        diag && "outline outline-1 -outline-offset-1 outline-line-strong",
                        hover && hover[0] === i && hover[1] === j && "outline outline-2 -outline-offset-2 outline-text",
                      )}
                      style={{ background: v === 0 ? undefined : bg }}
                    >
                      {label}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1.5 text-[10px] text-dim">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="value">0</span>
          <span className="h-2 w-28 rounded-[2px]" style={{ background: `linear-gradient(90deg, rgba(${SEQ_HUE},0.12), rgba(${SEQ_HUE},1))` }} aria-hidden />
          <span className="value">{normalize ? "100% of row" : `${Math.round(max)} objects`}</span>
        </div>
        <span className="leading-snug">Diagonal outlined. Background row: false positives with no matching object. Background column: missed objects.</span>
      </div>
    </div>
  );
}
