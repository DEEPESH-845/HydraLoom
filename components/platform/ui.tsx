"use client";

import clsx from "clsx";
import { useId, type ReactNode } from "react";

/* Small primitives of the platform shell, in the design language of docs/BLUEPRINT.md section 6. */

export const f0 = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "-");
export const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "-");
export const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "-");
export const pct = (n: number, d = 0) => (Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : "-");
export const signed = (n: number, d = 2) => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(d)}` : "-");
export const deg = (n: number) => `${String(Math.round(((n % 360) + 360) % 360)).padStart(3, "0")}°`;

export function Btn({
  children,
  onClick,
  primary,
  active,
  disabled,
  className,
  title,
  ariaLabel,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={clsx("btn inline-flex items-center justify-center gap-1.5", primary && "btn-primary", active && "btn-active", className)}
    >
      {children}
    </button>
  );
}

export function SimTag({ children = "SIMULATED", className }: { children?: ReactNode; className?: string }) {
  return <span className={clsx("sim-tag whitespace-nowrap", className)}>{children}</span>;
}

export function CardHead({ index, title, note, right }: { index: string; title: string; note?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="label text-teal">{index}</div>
        <h2 className="font-sans text-lg leading-tight text-text">{title}</h2>
        {note && <p className="mt-1 text-[12px] leading-snug text-muted">{note}</p>}
      </div>
      {right}
    </div>
  );
}

export function Section({ title, children, right, className }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={clsx("mt-3 border-t border-line pt-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="label">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Key-value row in mono. */
export function Row({ k, v, unit, tone, title }: { k: ReactNode; v: ReactNode; unit?: string; tone?: "teal" | "amber" | "danger"; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]" title={title}>
      <span className="text-[11px] text-muted">{k}</span>
      <span className={clsx("value text-[12px]", tone === "teal" ? "text-teal" : tone === "amber" ? "text-amber" : tone === "danger" ? "text-danger" : "text-text")}>
        {v}
        {unit && <span className="ml-1 text-[10px] text-dim">{unit}</span>}
      </span>
    </div>
  );
}

/** Labelled range input with a live value. Fully keyboard operable (native range). */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: string;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[11px] text-muted">
          {label}
        </label>
        <span className="value text-[12px] text-text">{format ? format(value) : value}</span>
      </div>
      <input id={id} data-testid={testId} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 block" />
      {hint && <p className="mt-0.5 text-[10px] leading-snug text-dim">{hint}</p>}
    </div>
  );
}

/** Segmented choice. */
export function Segmented<T extends string>({ options, value, onChange, label, testId }: { options: { id: T; label: string; title?: string; disabled?: boolean }[]; value: T; onChange: (v: T) => void; label: string; testId?: string }) {
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={clsx(
            "border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40",
            o.id === value ? "border-teal text-teal" : "border-line-strong text-muted hover:border-teal hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Horizontal bar for -1..1 values (thrust). */
export function Bar({ label, value }: { label: string; value: number }) {
  const v = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className="flex items-center gap-2 py-[2px]">
      <span className="value w-10 text-[10px] text-muted">{label}</span>
      <div className="relative h-1.5 flex-1 bg-panel-2">
        <div className="absolute top-0 h-full w-px bg-line-strong" style={{ left: "50%" }} />
        <div className="absolute top-0 h-full bg-teal" style={{ left: v >= 0 ? "50%" : `${50 + v * 50}%`, width: `${Math.abs(v) * 50}%` }} />
      </div>
      <span className="value w-11 text-right text-[10px] text-text">{signed(v * 100, 0)}%</span>
    </div>
  );
}
