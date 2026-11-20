"use client";

import clsx from "clsx";
import { AlertTriangle, Check, Copy, RefreshCw, ServerOff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { API_ORIGIN, BACKEND_START_COMMAND, type ApiError } from "@/lib/api/client";
import { MOCK_BANNER, type ValueKind } from "@/lib/api/types";

// ---------------------------------------------------------------------------
// Formatting. `null` means "not available" and is shown as such, never as zero.
// ---------------------------------------------------------------------------

export const NA = "n/a";

export function fmt(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  return v.toFixed(digits);
}

export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  return Math.round(v).toLocaleString("en-US");
}

export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return (v / 1e3).toFixed(1) + "K";
  return fmtInt(v);
}

export function fmtBytes(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + " GB";
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + " MB";
  if (v >= 1024) return (v / 1024).toFixed(1) + " KB";
  return `${v} B`;
}

export function fmtSigned(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  return (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v).toFixed(digits);
}

/** UTC timestamps from the backend, shown in UTC so every viewer sees the same value. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export const shortSha = (sha: string, n = 12) => sha.slice(0, n);

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return NA;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Panel({
  title,
  label,
  note,
  right,
  children,
  className,
  id,
  bodyClassName,
  testId,
}: {
  title?: ReactNode;
  label?: string;
  note?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  bodyClassName?: string;
  testId?: string;
}) {
  return (
    <section id={id} data-testid={testId} className={clsx("panel min-w-0 scroll-mt-16", className)} aria-labelledby={id && title ? `${id}-title` : undefined}>
      {(title || label || right) && (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3 max-[479px]:px-3">
          <div className="min-w-0">
            {label && <div className="label mb-1">{label}</div>}
            {title && (
              <h2 id={id ? `${id}-title` : undefined} className="text-[15px] font-medium leading-tight text-text">
                {title}
              </h2>
            )}
            {note && <p className="mt-1 max-w-[72ch] text-[12px] leading-snug text-muted">{note}</p>}
          </div>
          {right && <div className="flex flex-wrap items-center gap-1.5">{right}</div>}
        </div>
      )}
      <div className={clsx("p-4 max-[479px]:p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx("animate-pulse bg-panel-2", className)} />;
}

export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx("flex flex-col gap-2", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 border border-dashed border-line-strong px-4 py-5">
      <div className="flex items-center gap-2">
        {icon}
        <span className="label text-text">{title}</span>
      </div>
      {children && <div className="max-w-[64ch] text-[12px] leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-1 flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}

/** Inline error for one panel. Backend-down errors get the start command. */
export function ErrorNote({ error, onRetry, className }: { error: ApiError; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={clsx("flex flex-wrap items-start gap-2 border border-danger/60 bg-danger/5 px-3 py-2 text-[12px]", className)}>
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="label mr-2 text-danger">{error.title}</span>
        <span className="break-words text-text">{error.message}</span>
      </div>
      {onRetry && (
        <button type="button" className="btn inline-flex items-center gap-1.5 !py-1" onClick={onRetry}>
          <RefreshCw size={12} /> Retry
        </button>
      )}
    </div>
  );
}

export function BackendDown({ onRetry, checking }: { onRetry: () => void; checking?: boolean }) {
  return (
    <div data-testid="backend-down" role="alert" className="panel mx-auto w-full max-w-[760px] p-6 max-[479px]:p-4">
      <div className="flex items-center gap-2">
        <ServerOff size={16} className="text-danger" aria-hidden />
        <span className="label text-danger">Backend unreachable</span>
      </div>
      <h2 className="mt-3 text-[20px] font-medium leading-tight text-text">The model-evaluation service is not running</h2>
      <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-muted">
        Nothing answered at <span className="value text-text">{API_ORIGIN}/api/v1/health</span>. Models, datasets, runs and reports
        live in the FastAPI backend. Start it from the repository root, then retry.
      </p>
      <div className="mt-4 flex items-stretch border border-line bg-ground">
        <pre className="value min-w-0 flex-1 overflow-x-auto px-3 py-3 text-[12px] leading-relaxed text-text">{BACKEND_START_COMMAND}</pre>
        <CopyButton text={BACKEND_START_COMMAND} label="Copy start command" className="border-0 border-l border-line" />
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Set <span className="value text-text">NEXT_PUBLIC_GANTRYLAB_API</span> if the backend runs on another host or port. Install steps are in{" "}
        <span className="value text-text">backend/README_GANTRYLAB.md</span>.
      </p>
      <div className="mt-4">
        <button type="button" className="btn btn-primary inline-flex items-center gap-1.5" onClick={onRetry} disabled={checking}>
          <RefreshCw size={13} className={clsx(checking && "animate-spin")} /> {checking ? "Checking" : "Retry connection"}
        </button>
      </div>
    </div>
  );
}

export function CopyButton({ text, label = "Copy", className, compact }: { text: string; label?: string; className?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the value stays selectable */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-1 border border-line-strong bg-panel-2 text-muted transition-colors duration-100 hover:border-teal hover:text-text",
        compact ? "h-6 w-6" : "px-3",
        className,
      )}
    >
      {copied ? <Check size={12} className="text-teal" /> : <Copy size={12} />}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Provenance and mock labelling
// ---------------------------------------------------------------------------

const KIND_STYLE: Record<ValueKind | "not_measured", string> = {
  measured: "!border-teal/70 !text-teal",
  estimated: "!border-amber/70 !text-amber",
  simulated: "!border-danger/70 !text-danger",
  not_measured: "!border-line-strong !text-dim",
};

export function KindTag({ kind, className }: { kind: ValueKind | "not_measured"; className?: string }) {
  const text = kind === "not_measured" ? "NOT MEASURED" : kind.toUpperCase();
  return (
    <span data-kind={kind} className={clsx("sim-tag whitespace-nowrap", KIND_STYLE[kind], className)}>
      {text}
    </span>
  );
}

export function MockBanner({ text, className }: { text?: string | null; className?: string }) {
  return (
    <div data-testid="mock-banner" role="note" className={clsx("flex items-center gap-2 border border-danger/70 bg-danger/10 px-3 py-2", className)}>
      <AlertTriangle size={14} className="shrink-0 text-danger" aria-hidden />
      <span className="font-mono text-[11px] font-semibold tracking-[0.12em] text-danger">{text || MOCK_BANNER}</span>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === "ready" || status === "complete"
      ? "!border-teal/70 !text-teal"
      : status === "rejected" || status === "failed"
        ? "!border-danger/70 !text-danger"
        : "!border-amber/70 !text-amber";
  const live = status === "pending" || status === "queued" || status === "running";
  return (
    <span data-status={status} className={clsx("sim-tag inline-flex items-center gap-1.5 whitespace-nowrap", tone)}>
      <span className={clsx("h-1.5 w-1.5 rounded-full bg-current", live && "animate-pulse")} aria-hidden />
      {status.toUpperCase()}
    </span>
  );
}

export function Evidence({ refs: raw }: { refs: string[] }) {
  // the backend can repeat a ref when two findings cite the same slice; show each once
  const refs = [...new Set(raw)];
  if (!refs.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" aria-label="Evidence references">
      <span className="label mr-0.5 text-[9px] text-dim">Evidence</span>
      {refs.map((r) => (
        <code key={r} className="border border-line bg-ground px-1.5 py-[1px] font-mono text-[10px] text-muted">
          {r}
        </code>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export const inputCls =
  "w-full min-w-0 border border-line-strong bg-ground px-2 py-1.5 font-mono text-[12px] text-text placeholder:text-dim hover:border-teal/60 focus-visible:border-teal disabled:opacity-50";

export function Field({ label, htmlFor, hint, children, className }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
      {hint && <span className="text-[11px] leading-snug text-dim">{hint}</span>}
    </div>
  );
}

export function KV({ k, v, mono = true, className }: { k: string; v: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={clsx("flex min-w-0 flex-col gap-0.5", className)}>
      <dt className="label text-[9px]">{k}</dt>
      <dd className={clsx("min-w-0 break-words text-[12px] text-text", mono && "value")}>{v}</dd>
    </div>
  );
}

export function ProgressBar({ value, label, tone = "teal" }: { value: number; label: string; tone?: "teal" | "amber" }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="h-1.5 w-full bg-panel-2">
      <div className={clsx("h-full transition-[width] duration-200", tone === "teal" ? "bg-teal" : "bg-amber")} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Scroll container for a workspace page; the global body does not scroll. */
export function PageShell({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="relative flex h-full flex-col overflow-y-auto overflow-x-hidden">
      {children}
    </div>
  );
}
