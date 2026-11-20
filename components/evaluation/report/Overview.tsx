"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import type { HardwareBlock, RunMetrics, RunRecord } from "@/lib/api/types";
import { CopyButton, fmt, fmtDate, fmtInt, KindTag, KV, MockBanner, NA, shortSha } from "../ui";

export function RunHeader({ run, metrics }: { run: RunRecord; metrics: RunMetrics | null }) {
  const c = run.config;
  const mapped = Object.entries(run.resolved_class_map).filter(([, v]) => v);
  const banner = metrics?.banner ?? "MOCK ADAPTER - not a real model evaluation";
  // the mock banner above already says this; do not repeat it as a warning
  const warnings = run.mock ? run.warnings.filter((w) => w !== banner) : run.warnings;
  return (
    <div className="flex flex-col gap-3" data-testid="run-header">
      {run.mock && <MockBanner text={metrics?.banner} />}
      <dl className="grid grid-cols-6 gap-x-5 gap-y-3 max-[1279px]:grid-cols-3 max-[599px]:grid-cols-2">
        <KV
          k="Model"
          mono={false}
          v={
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="break-words">
                {run.model.name} <span className="value text-muted">v{run.model.version}</span>
              </span>
              <span className="value text-[11px] text-dim" title={run.model.sha256}>
                {shortSha(run.model.sha256)}
              </span>
              <CopyButton text={run.model.sha256} label="Copy model SHA-256" compact />
            </span>
          }
        />
        <KV k="Dataset" mono={false} v={<span>{run.dataset.name} <span className="value text-muted">{run.dataset.n_frames} frames</span></span>} />
        <KV k="Adapter" v={run.mock ? <span className="text-danger">mock (MOCK)</span> : run.adapter} />
        <KV k="Device" v={String(run.runtime.device_name ?? run.runtime.device ?? c.device)} />
        <KV k="Compute profile" v={c.compute_profile} />
        <KV k="Created" v={fmtDate(run.created_at)} />
      </dl>
      <div className="flex flex-wrap gap-1.5" aria-label="Run configuration">
        {[
          ["conf", c.conf],
          ["NMS iou", c.iou],
          ["imgsz", c.imgsz],
          ["max_det", c.max_det],
          ["device", c.device],
          ["budget", `${c.budget_fps} FPS`],
          ["seed", run.seed],
          ["classes mapped", run.mock ? "n/a (mock)" : `${mapped.length}`],
        ].map(([k, v]) => (
          <span key={String(k)} className="border border-line px-1.5 py-[2px] font-mono text-[10px] text-muted">
            {k} <span className="text-text">{String(v)}</span>
          </span>
        ))}
      </div>
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {warnings.map((w) => (
            <li key={w} className="border-l-2 border-amber bg-amber/5 px-2 py-1 text-[11px] text-muted">
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Tile({ label, value, unit, sub, tag, testId, children }: { label: string; value: string; unit?: string; sub?: ReactNode; tag?: ReactNode; testId?: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border border-line bg-ground/40 px-3 py-2.5" data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] leading-tight text-muted">{label}</span>
        {tag}
      </div>
      <span className={clsx("text-[22px] font-semibold leading-none", value === NA ? "text-dim" : "text-text")}>
        {value}
        {unit && value !== NA && <span className="ml-1 text-[12px] font-normal text-muted">{unit}</span>}
      </span>
      {sub && <span className="text-[10px] leading-snug text-dim">{sub}</span>}
      {children}
    </div>
  );
}

function Assumptions({ block }: { block: HardwareBlock }) {
  if (!block.assumptions.length) return null;
  return (
    <details className="text-[10px] text-dim">
      <summary className="cursor-pointer select-none text-muted hover:text-text">Assumptions</summary>
      <ul className="mt-1 list-disc pl-3.5 leading-snug">
        {block.assumptions.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
    </details>
  );
}

export function OverviewTiles({ metrics }: { metrics: RunMetrics }) {
  const o = metrics.overall;
  const lat = metrics.latency;
  const res = metrics.resources;
  const hw = metrics.hardware;
  const accTag = metrics.mock ? <KindTag kind="simulated" /> : null;
  const latTag = <KindTag kind={lat.kind} />;
  const resTag = <KindTag kind={res.kind} />;
  return (
    <div className="flex flex-col gap-3" data-testid="overview-tiles">
      <div>
        <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3">
          <span className="label">Detection quality</span>
          <span className="text-[11px] text-dim">
            {fmtInt(o.n_gt)} ground-truth objects in {fmtInt(metrics.n_frames)} frames · match IoU 0.5 · conf {fmt(metrics.conf_threshold, 2)}
          </span>
        </div>
        <div className="grid grid-cols-7 gap-2 max-[1279px]:grid-cols-4 max-[599px]:grid-cols-2">
          <Tile label="Precision" value={fmt(o.precision)} tag={accTag} testId="tile-precision" sub={`TP ${o.tp} / ${o.tp + o.fp} predictions`} />
          <Tile label="Recall" value={fmt(o.recall)} tag={accTag} testId="tile-recall" sub={`TP ${o.tp} / ${o.n_gt} objects`} />
          <Tile label="F1" value={fmt(o.f1)} tag={accTag} />
          <Tile label="mAP@50" value={fmt(o.map50)} tag={accTag} testId="tile-map50" sub={`${o.n_classes_evaluated} classes`} />
          <Tile label="mAP@50:95" value={fmt(o.map50_95)} tag={accTag} />
          <Tile label="False positives" value={fmtInt(o.fp)} tag={accTag} sub={Object.entries(metrics.fp_types).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"} />
          <Tile label="False negatives" value={fmtInt(o.fn)} tag={accTag} sub={Object.entries(metrics.fn_types).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"} />
        </div>
      </div>
      <div>
        <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3">
          <span className="label">Runtime</span>
          <span className="text-[11px] text-dim">{lat.note || "Per-frame latency excludes image decoding."}</span>
        </div>
        <div className="grid grid-cols-5 gap-2 max-[1279px]:grid-cols-3 max-[599px]:grid-cols-2">
          <Tile label="Latency p50" value={fmt(lat.total_ms.p50, 1)} unit="ms" tag={latTag} testId="tile-latency" sub={lat.kind === "measured" ? `${lat.total_ms.n} frames, ${lat.n_warmup_excluded} warm-up excluded` : "no inference timed"} />
          <Tile label="Latency p95" value={fmt(lat.total_ms.p95, 1)} unit="ms" tag={latTag} sub={lat.kind === "measured" ? `inference p50 ${fmt(lat.inference_ms.p50, 1)} ms` : undefined} />
          <Tile label={`FPS (${hw.profile})`} value={fmt(hw.fps, 1)} tag={<KindTag kind={hw.kind} />} testId="tile-fps" sub={hw.meets_budget === null ? `budget ${hw.budget_fps_required} FPS` : hw.meets_budget ? `meets ${hw.budget_fps_required} FPS budget` : `misses ${hw.budget_fps_required} FPS budget`}>
            {hw.kind === "estimated" && <Assumptions block={hw} />}
          </Tile>
          <Tile label="Peak memory (RSS)" value={fmt(res.peak_rss_mb, 0)} unit="MB" tag={resTag} sub={res.cpu_percent_mean !== null ? `CPU mean ${fmt(res.cpu_percent_mean, 0)}%` : res.device_name ?? undefined} />
          <Tile
            label="GPU memory"
            value={fmt(res.gpu_max_memory_allocated_mb, 1)}
            unit="MB"
            tag={resTag}
            sub={res.gpu_util_mean !== null ? `util mean ${fmt(res.gpu_util_mean, 0)}%, max ${fmt(res.gpu_util_max, 0)}% (device-wide)` : res.device === "cuda" ? undefined : "no GPU used"}
          />
        </div>
      </div>
    </div>
  );
}

export function PerClassTable({ metrics }: { metrics: RunMetrics }) {
  const rows = metrics.classes.map((c) => [c, metrics.per_class[c]] as const).filter(([, v]) => !!v);
  return (
    <div className="relative overflow-x-auto" data-testid="per-class-table">
      <table className="w-full min-w-[640px] text-[12px]">
        <thead>
          <tr className="border-b border-line">
            {["Class", "Support", "Pred", "TP", "FP", "FN", "Precision", "Recall", "F1", "AP50", "AP50:95"].map((h, i) => (
              <th key={h} scope="col" className={clsx("label px-2 py-1.5 font-normal", i === 0 ? "text-left" : "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([c, m]) => (
            <tr key={c} className="border-b border-line/60">
              <th scope="row" className="value px-2 py-1.5 text-left font-normal text-text">
                {c}
              </th>
              {[m.support, m.n_pred, m.tp, m.fp, m.fn].map((v, i) => (
                <td key={i} className="value px-2 py-1.5 text-right text-muted">
                  {v}
                </td>
              ))}
              {[m.precision, m.recall, m.f1, m.ap50, m.ap50_95].map((v, i) => (
                <td key={i} className={clsx("value px-2 py-1.5 text-right", v === null ? "text-dim" : "text-text")}>
                  {fmt(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {metrics.confused_pairs.length > 0 && (
        <p className="mt-2 text-[11px] text-muted">
          Most confused:{" "}
          {metrics.confused_pairs.slice(0, 4).map((p, i) => (
            <span key={i} className="value mr-3 text-text">
              {p.gt_class} -&gt; {p.pred_class} ({p.count})
            </span>
          ))}
        </p>
      )}
      {metrics.tp_below_conf_threshold > 0 && (
        <p className="mt-1 text-[11px] text-muted">{metrics.tp_below_conf_threshold} correct detections were dropped by the operating confidence threshold.</p>
      )}
    </div>
  );
}

export function HardwarePanel({ metrics }: { metrics: RunMetrics }) {
  return (
    <div className="grid grid-cols-4 gap-2 max-[1279px]:grid-cols-2 max-[599px]:grid-cols-1" data-testid="hardware-panel">
      {metrics.hardware_profiles.map((b) => {
        const selected = b.profile === metrics.hardware.profile;
        return (
          <div key={b.profile} className={clsx("flex min-w-0 flex-col gap-2 border px-3 py-2.5", selected ? "border-teal/70" : "border-line")} data-profile={b.profile}>
            <div className="flex items-start justify-between gap-2">
              <span className="value text-[12px] text-text">{b.profile}</span>
              <span className="flex items-center gap-1">
                {selected && <span className="sim-tag !text-teal">SELECTED</span>}
                <KindTag kind={b.kind} />
              </span>
            </div>
            <span className="text-[11px] leading-snug text-muted">{b.name}</span>
            <div className="flex items-baseline gap-4">
              <span>
                <span className={clsx("text-[18px] font-semibold", b.latency_ms_p50 === null ? "text-dim" : "text-text")}>{fmt(b.latency_ms_p50, 1)}</span>
                {b.latency_ms_p50 !== null && <span className="ml-1 text-[11px] text-muted">ms p50</span>}
              </span>
              <span>
                <span className={clsx("text-[18px] font-semibold", b.fps === null ? "text-dim" : "text-text")}>{fmt(b.fps, 1)}</span>
                {b.fps !== null && <span className="ml-1 text-[11px] text-muted">FPS</span>}
              </span>
            </div>
            <span
              className={clsx(
                "sim-tag w-fit",
                b.meets_budget === true ? "!border-teal/70 !text-teal" : b.meets_budget === false ? "!border-danger/70 !text-danger" : "!text-dim",
              )}
            >
              {b.meets_budget === true ? `MEETS ${b.budget_fps_required} FPS` : b.meets_budget === false ? `MISSES ${b.budget_fps_required} FPS` : "BUDGET N/A"}
            </span>
            <span className="text-[10px] leading-snug text-dim">{b.method}</span>
            {b.assumptions.length > 0 && (
              <details className="text-[10px] text-dim" open={b.kind === "estimated" && selected}>
                <summary className="cursor-pointer select-none text-muted hover:text-text">{b.kind === "estimated" ? "Assumptions (estimate, never measured)" : "Notes"}</summary>
                <ul className="mt-1 list-disc pl-3.5 leading-snug">
                  {b.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
