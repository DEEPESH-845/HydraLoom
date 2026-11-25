"use client";

import clsx from "clsx";
import { useState, type ReactNode } from "react";
import { AXIS, ChartTableToggle, GRID, SEQ_HUE, TEXT_DIM, TipRow, Tooltip, useWidth } from "@/components/evaluation/charts/core";

/** Chart pieces shared by the Benchmark, Autonomy and Hardware workspaces. Colours come from the validated core palette. */

export interface Series {
  name: string;
  color: string;
  points: [number, number][];
  dashed?: boolean;
}

const niceTicks = (lo: number, hi: number, n: number) => {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return out;
};

const num = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : Number(v.toFixed(3)).toString());

export function LineChart({ series, xLabel, yLabel, height = 200, marker, yRange, digits = 2, label }: { series: Series[]; xLabel: string; yLabel: string; height?: number; marker?: { x: number; label: string }; yRange?: [number, number]; digits?: number; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>(560);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const all = series.flatMap((s) => s.points);
  if (!all.length) return <div ref={ref} className="text-[12px] text-dim">No data yet.</div>;
  const m = { l: 46, r: 12, t: 10, b: 34 };
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const pad = (Math.max(...ys) - Math.min(...ys)) * 0.08 || 0.1;
  const [y0, y1] = yRange ?? [Math.min(...ys) - pad, Math.max(...ys) + pad];
  const sx = (x: number) => m.l + ((x - x0) / (x1 - x0 || 1)) * (w - m.l - m.r);
  const sy = (y: number) => m.t + (1 - (y - y0) / (y1 - y0 || 1)) * (height - m.t - m.b);
  const axis = [...new Set(series[0].points.map((p) => p[0]))];
  const near = hover === null ? null : axis.reduce((b, x) => (Math.abs(sx(x) - hover) < Math.abs(sx(b) - hover) ? x : b), axis[0]);
  const at = (s: Series, x: number) => s.points.reduce((b, p) => (Math.abs(p[0] - x) < Math.abs(b[0] - x) ? p : b), s.points[0]);
  return (
    <div ref={ref} className="relative">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {series.length > 1 &&
            series.map((s) => (
              <span key={s.name} className="inline-flex items-center gap-1.5 font-mono text-[11px] text-text">
                <span className="h-0 w-3.5 border-t-2" style={{ borderColor: s.color, borderStyle: s.dashed ? "dashed" : "solid" }} aria-hidden />
                {s.name}
              </span>
            ))}
        </div>
        <ChartTableToggle table={table} onChange={setTable} />
      </div>
      {table ? (
        <div className="max-h-56 overflow-auto">
          <table className="value w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-panel text-dim">
              <tr>
                <th className="py-1 pr-3 font-normal">{xLabel}</th>
                {series.map((s) => (
                  <th key={s.name} className="py-1 pr-3 font-normal">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {axis.map((x) => (
                <tr key={x} className="border-t border-line text-text">
                  <td className="py-0.5 pr-3">{num(x)}</td>
                  {series.map((s) => (
                    <td key={s.name} className="py-0.5 pr-3">
                      {at(s, x)?.[1].toFixed(digits)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg width={w} height={height} role="img" aria-label={label} onPointerMove={(e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)} onPointerLeave={() => setHover(null)} className="block max-w-full touch-pan-y">
          {niceTicks(y0, y1, 4).map((v) => (
            <g key={v}>
              <line x1={m.l} x2={w - m.r} y1={sy(v)} y2={sy(v)} stroke={GRID} />
              <text x={m.l - 6} y={sy(v) + 3} textAnchor="end" fontSize={10} fill={TEXT_DIM} className="value">
                {num(v)}
              </text>
            </g>
          ))}
          {niceTicks(x0, x1, Math.max(3, Math.floor(w / 110))).map((v) => (
            <text key={v} x={sx(v)} y={height - m.b + 14} textAnchor="middle" fontSize={10} fill={TEXT_DIM} className="value">
              {num(v)}
            </text>
          ))}
          <line x1={m.l} x2={w - m.r} y1={height - m.b} y2={height - m.b} stroke={AXIS} />
          <text x={(m.l + w - m.r) / 2} y={height - 4} textAnchor="middle" fontSize={10} fill={TEXT_DIM}>
            {xLabel}
          </text>
          <text x={-(m.t + (height - m.t - m.b) / 2)} y={11} transform="rotate(-90)" textAnchor="middle" fontSize={10} fill={TEXT_DIM}>
            {yLabel}
          </text>
          {marker && (
            <g>
              <line x1={sx(marker.x)} x2={sx(marker.x)} y1={m.t} y2={height - m.b} stroke="#f2a93b" strokeDasharray="3 3" />
              <text x={Math.min(sx(marker.x) + 4, w - 90)} y={m.t + 10} fontSize={10} fill="#e6edf3">
                {marker.label}
              </text>
            </g>
          )}
          {series.map((s) => (
            <polyline key={s.name} points={s.points.map((p) => `${sx(p[0])},${sy(p[1])}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "5 4" : undefined} />
          ))}
          {near !== null && (
            <g>
              <line x1={sx(near)} x2={sx(near)} y1={m.t} y2={height - m.b} stroke={AXIS} />
              {series.map((s) => {
                const p = at(s, near);
                return <circle key={s.name} cx={sx(p[0])} cy={sy(p[1])} r={4} fill={s.color} stroke="#101922" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
      )}
      {near !== null && !table && (
        <Tooltip x={sx(near)} y={40} containerWidth={w}>
          <div className="value mb-0.5 text-dim">
            {xLabel} {num(near)}
          </div>
          {series.map((s) => (
            <TipRow key={s.name} color={s.color} name={s.name} value={at(s, near)[1].toFixed(digits)} />
          ))}
        </Tooltip>
      )}
    </div>
  );
}

/** Ranked horizontal bars with the value printed on each row. The reference, if any, is drawn as a tick. */
export function RankBars({ rows, format, max, min = 0 }: { rows: { name: string; value: number; color: string; note?: string; strong?: boolean }[]; format: (v: number) => string; max?: number; min?: number }) {
  const top = max ?? Math.max(...rows.map((r) => r.value), 1e-9);
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <li key={r.name} title={`${r.name}: ${format(r.value)}${r.note ? ` (${r.note})` : ""}`} className="grid grid-cols-[minmax(120px,170px)_1fr_auto] items-center gap-2 max-[479px]:grid-cols-[110px_1fr_auto]">
          <span className={clsx("truncate text-[12px]", r.strong ? "font-medium text-text" : "text-muted")}>{r.name}</span>
          <span className="h-3 bg-panel-2">
            <span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(0, Math.min(1, (r.value - min) / (top - min || 1))) * 100}%`, background: r.color }} />
          </span>
          <span className="value min-w-[84px] text-right text-[11px] text-text">
            {format(r.value)}
            {r.note && <span className="text-dim"> {r.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One heat cell: magnitude as a single-hue ramp, the number always printed. */
export function HeatCell({ value, onClick, selected, title, best, low }: { value: number | null; onClick?: () => void; selected?: boolean; title: string; best?: boolean; low?: boolean }) {
  const a = value === null ? 0 : 0.08 + 0.82 * Math.max(0, Math.min(1, value));
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={selected}
      className={clsx("value relative flex h-10 w-full min-w-[52px] items-center justify-center border text-[12px]", selected ? "border-amber" : "border-line hover:border-line-strong", value === null ? "text-dim" : "text-text", low && "opacity-60")}
      style={{ background: value === null ? undefined : `rgba(${SEQ_HUE}, ${a})` }}
    >
      {value === null ? "-" : value.toFixed(2)}
      {best && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber" aria-label="best here" />}
    </button>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "teal" | "amber" | "danger" }) {
  return (
    <div className="panel min-w-0 px-4 py-3">
      <div className="label">{label}</div>
      <div className={clsx("value mt-1 text-[22px] leading-tight", tone === "teal" ? "text-teal" : tone === "amber" ? "text-amber" : tone === "danger" ? "text-danger" : "text-text")}>{value}</div>
      {sub && <div className="mt-1 text-[12px] leading-snug text-muted">{sub}</div>}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full flex-wrap border border-line">
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} disabled={o.disabled} title={o.title} onClick={() => onChange(o.id)} className={clsx("border-r border-line px-2.5 py-1.5 font-mono text-[11px] last:border-r-0 disabled:opacity-40", value === o.id ? "bg-panel-2 text-teal" : "text-muted hover:text-text")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(d)}%`);
