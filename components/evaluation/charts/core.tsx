"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Categorical slots, dark-surface steps of the reference palette, in fixed order.
 * Validated against the panel surface #101922 (validate_palette.js --mode dark): every check passes,
 * worst adjacent CVD delta E 8.4, worst adjacent normal-vision delta E 19.3, all >= 3:1 contrast.
 * Colour follows the entity (class index in the run's class list), never its rank.
 */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"];
export const seriesColor = (i: number) => SERIES[i % SERIES.length];

/** Sequential single-hue ramp (blue) for magnitude, near-zero recedes into the surface. */
export const SEQ_HUE = "57, 135, 229"; // #3987e5

export const GRID = "#1d2935";
export const AXIS = "#34465a";
export const TEXT_MUTED = "#8b98a5";
export const TEXT_DIM = "#738496";
export const SURFACE = "#101922";

export function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = Math.floor(entries[0].contentRect.width);
      if (cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function Tooltip({ x, y, containerWidth, children }: { x: number; y: number; containerWidth: number; children: ReactNode }) {
  const left = x > containerWidth - 200 ? undefined : x + 14;
  const right = x > containerWidth - 200 ? containerWidth - x + 14 : undefined;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-20 min-w-[140px] border border-line-strong bg-ground/95 px-2.5 py-1.5 text-[11px] shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
      style={{ left, right, top: Math.max(0, y - 10) }}
    >
      {children}
    </div>
  );
}

export function TipRow({ color, name, value }: { color?: string; name: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5">
        {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
        <span className="truncate text-muted">{name}</span>
      </span>
      <span className="value text-text">{value}</span>
    </div>
  );
}

export function LegendItem({
  color,
  label,
  sub,
  on = true,
  onToggle,
  line,
}: {
  color: string;
  label: string;
  sub?: string;
  on?: boolean;
  onToggle?: () => void;
  line?: boolean;
}) {
  const body = (
    <>
      <span
        className={clsx("shrink-0", line ? "h-[2px] w-3.5 rounded-full" : "h-2.5 w-2.5 rounded-[2px]")}
        style={{ background: on ? color : "transparent", outline: on ? undefined : `1px solid ${color}` }}
        aria-hidden
      />
      <span className={clsx("font-mono text-[11px]", on ? "text-text" : "text-dim line-through")}>{label}</span>
      {sub && <span className="value text-[10px] text-dim">{sub}</span>}
    </>
  );
  if (!onToggle) return <span className="inline-flex items-center gap-1.5">{body}</span>;
  return (
    <button type="button" onClick={onToggle} aria-pressed={on} className="inline-flex items-center gap-1.5 border border-transparent px-1 py-0.5 hover:border-line-strong">
      {body}
    </button>
  );
}

/** Rounded data-end (4 px) and square baseline, for a vertical bar. */
export function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function ticks01(n = 5) {
  return Array.from({ length: n + 1 }, (_, i) => i / n);
}

export function ChartTableToggle({ table, onChange }: { table: boolean; onChange: (t: boolean) => void }) {
  return (
    <div className="inline-flex border border-line" role="group" aria-label="View">
      <button type="button" aria-pressed={!table} onClick={() => onChange(false)} className={clsx("px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]", !table ? "bg-panel-2 text-text" : "text-dim hover:text-text")}>
        Chart
      </button>
      <button type="button" aria-pressed={table} onClick={() => onChange(true)} className={clsx("border-l border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]", table ? "bg-panel-2 text-text" : "text-dim hover:text-text")}>
        Table
      </button>
    </div>
  );
}
