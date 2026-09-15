"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import { useSimStore } from "@/lib/sim/store";
import type { DetectedClass } from "@/lib/sim/types";

export const f1 = (n: number) => n.toFixed(1);
export const f2 = (n: number) => n.toFixed(2);
export const pct = (n: number, d = 1) => (n * 100).toFixed(d) + "%";
export const signed = (n: number, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d);
export const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, "0");
export const clampNum = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Amber for objects the policy cares about, teal for everything else. */
export const isTargetClass = (c: DetectedClass) => c === "SHIPWRECK" || c === "MINE";

/** Object list reference is stable across publishes; positions are read with primitive selectors elsewhere. */
export const useObjects = () => useSimStore((s) => s.scenario.objects);

export function CardHead({ title, note, right }: { title: string; note?: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="font-sans text-xl leading-tight text-text">{title}</h2>
        {note && <p className="mt-1 text-[12px] leading-snug text-muted">{note}</p>}
      </div>
      {right}
    </div>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("label", className)}>{children}</div>;
}

type ChipTone = "neutral" | "teal" | "amber";

export function Chip({
  children,
  tone = "neutral",
  active,
  onClick,
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  tone?: ChipTone;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const toneCls =
    tone === "teal" ? "border-teal text-teal" : tone === "amber" ? "border-amber text-amber" : "border-line-strong text-muted";
  const cls = clsx(
    "font-mono text-[10px] tracking-[0.1em] uppercase px-2 py-[3px] border whitespace-nowrap",
    active ? toneCls : "border-line text-muted",
    onClick && !disabled && "cursor-pointer hover:border-teal hover:text-text transition-colors duration-100",
    disabled && "opacity-50 cursor-not-allowed",
    className,
  );
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled} title={title}>
        {children}
      </button>
    );
  }
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

/** Arrow-separated chain of mono chips: FRAME -> PREPROCESS -> ... */
export function Chain({ items, activeIndex, tone = "teal" }: { items: string[]; activeIndex?: number; tone?: ChipTone }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map((it, i) => (
        <div key={it} className="flex items-center gap-1">
          <Chip tone={tone} active={activeIndex === undefined ? true : activeIndex === i}>
            {it}
          </Chip>
          {i < items.length - 1 && <span className="font-mono text-[10px] text-dim">-&gt;</span>}
        </div>
      ))}
    </div>
  );
}

/** Six object chips. Used by VISION, GANTRY and CONTROL cards to point the camera at any object. */
export function ObjectChips({ onPick, activeId, label }: { onPick: (id: string) => void; activeId: string | null; label?: string }) {
  const objects = useObjects();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {label && <span className="label mr-1">{label}</span>}
      {objects.map((o) => (
        <Chip key={o.id} tone={isTargetClass(o.type) ? "amber" : "teal"} active={activeId === o.id} onClick={() => onPick(o.id)} title={o.id}>
          {o.label}
        </Chip>
      ))}
    </div>
  );
}

export function Btn({
  children,
  onClick,
  primary,
  active,
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx("btn inline-flex items-center gap-1.5", primary && "btn-primary", active && "btn-active", className)}
    >
      {children}
    </button>
  );
}
