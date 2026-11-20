"use client";

import { useState } from "react";
import type { PRCurves } from "@/lib/api/types";
import { fmt } from "../ui";
import { AXIS, ChartTableToggle, GRID, LegendItem, seriesColor, SURFACE, TEXT_DIM, ticks01, TipRow, Tooltip, useWidth } from "./core";

const M = { top: 12, right: 18, bottom: 34, left: 40 };

function Axes({ w, h, xLabel, yLabel }: { w: number; h: number; xLabel: string; yLabel: string }) {
  const iw = w - M.left - M.right;
  const ih = h - M.top - M.bottom;
  return (
    <g>
      {ticks01(5).map((t) => (
        <g key={t}>
          <line x1={M.left} x2={M.left + iw} y1={M.top + ih * (1 - t)} y2={M.top + ih * (1 - t)} stroke={t === 0 ? AXIS : GRID} strokeWidth={1} />
          <text x={M.left - 6} y={M.top + ih * (1 - t)} dy="0.32em" textAnchor="end" fontSize={10} fill={TEXT_DIM} className="value">
            {t.toFixed(1)}
          </text>
          <text x={M.left + iw * t} y={M.top + ih + 14} textAnchor="middle" fontSize={10} fill={TEXT_DIM} className="value">
            {t.toFixed(1)}
          </text>
        </g>
      ))}
      <text x={M.left + iw / 2} y={h - 4} textAnchor="middle" fontSize={10} fill={TEXT_DIM} className="label">
        {xLabel}
      </text>
      <text transform={`translate(10 ${M.top + ih / 2}) rotate(-90)`} textAnchor="middle" fontSize={10} fill={TEXT_DIM} className="label">
        {yLabel}
      </text>
    </g>
  );
}

/** Per-class precision-recall curves (101-point interpolated, IoU 0.5). */
export function PRCurveChart({ pr, classes }: { pr: PRCurves; classes: string[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null);
  const [table, setTable] = useState(false);
  const names = classes.filter((c) => pr.per_class[c]);
  const h = Math.max(220, Math.min(320, w * 0.62));
  const iw = w - M.left - M.right;
  const ih = h - M.top - M.bottom;
  const X = (r: number) => M.left + r * iw;
  const Y = (p: number) => M.top + (1 - p) * ih;
  const n = names.length ? pr.per_class[names[0]].recall.length : 0;

  if (!names.length) return <p className="text-[12px] text-muted">No class has ground truth, so there are no PR curves.</p>;

  return (
    <div ref={ref} className="flex flex-col gap-2" data-testid="pr-chart">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-x-1 gap-y-0.5">
          {names.map((c) => (
            <LegendItem
              key={c}
              line
              color={seriesColor(classes.indexOf(c))}
              label={c}
              sub={`AP50 ${fmt(pr.per_class[c].ap50)}`}
              on={!hidden.has(c)}
              onToggle={() =>
                setHidden((s) => {
                  const n2 = new Set(s);
                  if (n2.has(c)) n2.delete(c);
                  else n2.add(c);
                  return n2;
                })
              }
            />
          ))}
        </div>
        <ChartTableToggle table={table} onChange={setTable} />
      </div>
      {table ? (
        <div className="relative max-h-[320px] overflow-auto border border-line">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-line">
                <th className="label px-2 py-1 text-left font-normal">Recall</th>
                {names.map((c) => (
                  <th key={c} className="label px-2 py-1 text-right font-normal">
                    P {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: n }, (_, i) => i)
                .filter((i) => i % 5 === 0)
                .map((i) => (
                  <tr key={i} className="border-b border-line/50">
                    <td className="value px-2 py-0.5 text-muted">{fmt(pr.per_class[names[0]].recall[i], 2)}</td>
                    {names.map((c) => (
                      <td key={c} className="value px-2 py-0.5 text-right text-text">
                        {fmt(pr.per_class[c].precision[i])}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative w-full" onPointerLeave={() => setHover(null)}>
          <svg
            width={w}
            height={h}
            role="img"
            aria-label={`Precision-recall curves for ${names.join(", ")}`}
            onPointerMove={(e) => {
              const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const px = e.clientX - rect.left;
              const py = e.clientY - rect.top;
              const r = Math.min(1, Math.max(0, (px - M.left) / iw));
              setHover({ i: Math.round(r * (n - 1)), px, py });
            }}
          >
            <Axes w={w} h={h} xLabel="Recall" yLabel="Precision" />
            {names.map((c) => {
              if (hidden.has(c)) return null;
              const cur = pr.per_class[c];
              const d = cur.recall.map((r, i) => `${i ? "L" : "M"}${X(r).toFixed(1)},${Y(cur.precision[i]).toFixed(1)}`).join("");
              return <path key={c} d={d} fill="none" stroke={seriesColor(classes.indexOf(c))} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
            })}
            {hover && (
              <g pointerEvents="none">
                <line x1={X(hover.i / (n - 1))} x2={X(hover.i / (n - 1))} y1={M.top} y2={M.top + ih} stroke={AXIS} />
                {names
                  .filter((c) => !hidden.has(c))
                  .map((c) => (
                    <circle key={c} cx={X(pr.per_class[c].recall[hover.i])} cy={Y(pr.per_class[c].precision[hover.i])} r={4} fill={seriesColor(classes.indexOf(c))} stroke={SURFACE} strokeWidth={2} />
                  ))}
              </g>
            )}
          </svg>
          {hover && (
            <Tooltip x={hover.px} y={hover.py} containerWidth={w}>
              <div className="label mb-1 text-[9px]">Recall {fmt(pr.per_class[names[0]].recall[hover.i], 2)}</div>
              {names
                .filter((c) => !hidden.has(c))
                .map((c) => (
                  <TipRow key={c} color={seriesColor(classes.indexOf(c))} name={c} value={`P ${fmt(pr.per_class[c].precision[hover.i])}`} />
                ))}
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

/** Micro precision, recall and F1 across confidence thresholds, with the operating and F1-optimal thresholds marked. */
export function ConfSweepChart({ pr, conf }: { pr: PRCurves; conf: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null);
  const s = pr.conf_sweep;
  const h = Math.max(220, Math.min(320, w * 0.62));
  const iw = w - M.left - M.right;
  const ih = h - M.top - M.bottom;
  const X = (t: number) => M.left + t * iw;
  const Y = (v: number) => M.top + (1 - v) * ih;
  const series: { key: "precision" | "recall" | "f1"; label: string; color: string }[] = [
    { key: "precision", label: "Precision", color: seriesColor(0) },
    { key: "recall", label: "Recall", color: seriesColor(1) },
    { key: "f1", label: "F1", color: seriesColor(2) },
  ];
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${X(s.thresholds[i]).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const best = pr.best_f1;
  return (
    <div ref={ref} className="flex flex-col gap-2" data-testid="conf-sweep">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {series.map((se) => (
          <LegendItem key={se.key} line color={se.color} label={se.label} />
        ))}
        <span className="ml-2 inline-flex items-center gap-1.5 text-[10px] text-dim">
          <span className="h-3 w-0 border-l border-dashed border-text" aria-hidden /> operating conf {fmt(conf, 2)}
        </span>
        {best && <span className="ml-2 text-[10px] text-dim">best F1 {fmt(best.f1)} at conf {fmt(best.conf, 2)}</span>}
      </div>
      <div className="relative w-full" onPointerLeave={() => setHover(null)}>
        <svg
          width={w}
          height={h}
          role="img"
          aria-label={`Precision, recall and F1 against confidence threshold. Best F1 ${fmt(best?.f1 ?? null)} at ${fmt(best?.conf ?? null, 2)}.`}
          onPointerMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = e.clientX - rect.left;
            const t = Math.min(1, Math.max(0, (px - M.left) / iw));
            let i = 0;
            let bestD = Infinity;
            s.thresholds.forEach((th, k) => {
              const d = Math.abs(th - t);
              if (d < bestD) {
                bestD = d;
                i = k;
              }
            });
            setHover({ i, px, py: e.clientY - rect.top });
          }}
        >
          <Axes w={w} h={h} xLabel="Confidence threshold" yLabel="Score" />
          <line x1={X(conf)} x2={X(conf)} y1={M.top} y2={M.top + ih} stroke="#e6edf3" strokeDasharray="3 3" strokeWidth={1} opacity={0.7} />
          {series.map((se) => (
            <path key={se.key} d={path(s[se.key])} fill="none" stroke={se.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {best && <circle cx={X(best.conf)} cy={Y(best.f1)} r={4.5} fill={seriesColor(2)} stroke={SURFACE} strokeWidth={2} />}
          {hover && (
            <g pointerEvents="none">
              <line x1={X(s.thresholds[hover.i])} x2={X(s.thresholds[hover.i])} y1={M.top} y2={M.top + ih} stroke={AXIS} />
              {series.map((se) => {
                const v = s[se.key][hover.i];
                return v === null ? null : <circle key={se.key} cx={X(s.thresholds[hover.i])} cy={Y(v)} r={4} fill={se.color} stroke={SURFACE} strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
        {hover && (
          <Tooltip x={hover.px} y={hover.py} containerWidth={w}>
            <div className="label mb-1 text-[9px]">conf {fmt(s.thresholds[hover.i], 2)}</div>
            {series.map((se) => (
              <TipRow key={se.key} color={se.color} name={se.label} value={fmt(s[se.key][hover.i])} />
            ))}
          </Tooltip>
        )}
      </div>
    </div>
  );
}
