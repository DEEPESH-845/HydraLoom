"use client";

import clsx from "clsx";
import { useMemo, useState } from "react";
import { api, urls } from "@/lib/api/client";
import { useResource } from "@/lib/api/hooks";
import type { ConditionValue, FalseNegative, FalsePositive, RunMetrics } from "@/lib/api/types";
import { BoxLegend, FrameView, xywhToXyxy, type FrameBox } from "../FrameView";
import { EmptyState, ErrorNote, fmt, inputCls, Skeleton } from "../ui";

type Item = { id: string; kind: "FP"; d: FalsePositive } | { id: string; kind: "FN"; d: FalseNegative };

const PAGE = 12;

function condStr(v: ConditionValue | undefined) {
  if (v === null || v === undefined) return "n/a";
  return typeof v === "number" ? String(Number(v.toFixed(3))) : String(v);
}

export function FailureAnalysis({ metrics, runId, datasetId }: { metrics: RunMetrics; runId: string; datasetId: string }) {
  const manifest = useResource(`manifest:${datasetId}`, (s) => api.getManifest(datasetId, s));
  const preds = useResource(`predictions:${runId}`, (s) => api.getPredictions(runId, s));
  const [kind, setKind] = useState<"all" | "FP" | "FN">("all");
  const [cls, setCls] = useState("");
  const [condKey, setCondKey] = useState("");
  const [condVal, setCondVal] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const items: Item[] = useMemo(
    () => [
      ...metrics.false_negatives.map((d, i) => ({ id: `fn-${i}`, kind: "FN" as const, d })),
      ...metrics.false_positives.map((d, i) => ({ id: `fp-${i}`, kind: "FP" as const, d })),
    ],
    [metrics],
  );
  const condKeys = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) Object.keys(it.d.conditions).forEach((k) => s.add(k));
    return [...s].sort();
  }, [items]);
  const condValues = useMemo(() => {
    if (!condKey) return [];
    const s = new Set<string>();
    for (const it of items) s.add(condStr(it.d.conditions[condKey]));
    return [...s].sort((a, b) => (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) - Number(b) : a.localeCompare(b)));
  }, [items, condKey]);
  const classes = useMemo(() => [...new Set(items.map((i) => i.d.class_name))].sort(), [items]);

  const filtered = items.filter(
    (it) =>
      (kind === "all" || it.kind === kind) &&
      (!cls || it.d.class_name === cls) &&
      (!condKey || !condVal || condStr(it.d.conditions[condKey]) === condVal),
  );

  const frames = useMemo(() => new Map((manifest.data?.frames ?? []).map((f) => [f.file, f])), [manifest.data]);
  const predFrames = useMemo(() => new Map((preds.data?.frames ?? []).map((f) => [f.file, f])), [preds.data]);

  const capped = metrics.false_positives.length >= metrics.failure_cap || metrics.false_negatives.length >= metrics.failure_cap;

  if (!items.length) return <EmptyState title="No failures">Every ground-truth object was found and no false positive was produced at the operating threshold.</EmptyState>;

  return (
    <div className="flex flex-col gap-3" data-testid="failure-analysis">
      <div className="flex flex-wrap items-end gap-2">
        <div className="inline-flex border border-line" role="group" aria-label="Failure type">
          {(["all", "FN", "FP"] as const).map((k, i) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                setLimit(PAGE);
              }}
              className={clsx("px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em]", i > 0 && "border-l border-line", kind === k ? "bg-panel-2 text-text" : "text-dim hover:text-text")}
            >
              {k === "all" ? `All ${items.length}` : k === "FN" ? `Missed ${metrics.false_negatives.length}` : `False pos ${metrics.false_positives.length}`}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1">
          <span className="label text-[9px]">Class</span>
          <select className={clsx(inputCls, "!w-auto")} value={cls} onChange={(e) => { setCls(e.target.value); setLimit(PAGE); }} aria-label="Filter by class">
            <option value="">all classes</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label text-[9px]">Condition</span>
          <select
            className={clsx(inputCls, "!w-auto")}
            value={condKey}
            onChange={(e) => {
              setCondKey(e.target.value);
              setCondVal("");
              setLimit(PAGE);
            }}
            aria-label="Filter by condition"
          >
            <option value="">any condition</option>
            {condKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {condKey && (
          <label className="flex flex-col gap-1">
            <span className="label text-[9px]">Value</span>
            <select className={clsx(inputCls, "!w-auto")} value={condVal} onChange={(e) => { setCondVal(e.target.value); setLimit(PAGE); }} aria-label="Condition value">
              <option value="">any value</option>
              {condValues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        <BoxLegend className="ml-auto pb-1.5" />
      </div>
      <p className="text-[11px] text-dim">
        {filtered.length} of {items.length} shown{capped ? ` · lists are capped at ${metrics.failure_cap} per type by the backend` : ""}. Predictions at or above conf{" "}
        {fmt(metrics.conf_threshold, 2)} are drawn; the highlighted box is the failure.
      </p>
      {manifest.error && <ErrorNote error={manifest.error} onRetry={manifest.reload} />}
      {preds.error && <ErrorNote error={preds.error} onRetry={preds.reload} />}
      <div className="grid grid-cols-3 gap-3 max-[1279px]:grid-cols-2 max-[599px]:grid-cols-1">
        {filtered.slice(0, limit).map((it) => {
          const f = it.d.file ? frames.get(it.d.file) : undefined;
          const pf = it.d.file ? predFrames.get(it.d.file) : undefined;
          const boxes: FrameBox[] = [];
          if (f)
            for (const a of f.annotations) {
              const isFocus = it.kind === "FN" && (it.d as FalseNegative).object_id === a.object_id;
              if (!isFocus) boxes.push({ xyxy: xywhToXyxy(a.bbox_xywh), kind: "gt", label: a.class_name });
            }
          if (pf)
            for (const d of pf.detections)
              if (d.conf >= metrics.conf_threshold && !(it.kind === "FP" && sameBox(d.bbox_xyxy, it.d.bbox_xyxy))) boxes.push({ xyxy: d.bbox_xyxy, kind: "pred", label: `${d.class_name} ${d.conf.toFixed(2)}` });
          boxes.push({
            xyxy: it.d.bbox_xyxy,
            kind: it.kind === "FN" ? "focus-gt" : "focus-pred",
            label: it.kind === "FN" ? `MISSED ${it.d.class_name}` : `${it.d.class_name} ${(it.d as FalsePositive).conf.toFixed(2)}`,
          });
          const c = it.d.conditions;
          return (
            <figure key={it.id} className="flex min-w-0 flex-col border border-line" data-failure={it.kind}>
              {it.d.file && f ? (
                <FrameView src={urls.frame(datasetId, it.d.file)} width={f.width} height={f.height} boxes={boxes} alt={`${it.kind} on ${it.d.file}`} />
              ) : manifest.loading ? (
                <Skeleton className="aspect-[4/3] w-full" />
              ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-ground text-[11px] text-dim">Frame not in manifest</div>
              )}
              <figcaption className="flex flex-col gap-1 border-t border-line px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <span className={clsx("sim-tag", it.kind === "FN" ? "!border-teal/70 !text-teal" : "!border-amber/70 !text-amber")}>{it.kind === "FN" ? "MISSED" : "FALSE POS"}</span>
                    <span className="value text-[12px] text-text">{it.d.class_name}</span>
                  </span>
                  <span className="value text-[10px] text-dim">{it.d.file}</span>
                </div>
                <span className="text-[11px] text-muted">
                  {it.kind === "FN" ? (
                    <>
                      reason <span className="value text-text">{(it.d as FalseNegative).reason}</span>
                      {(it.d as FalseNegative).distance_m != null && <> · {fmt((it.d as FalseNegative).distance_m!, 1)} m</>}
                      {(it.d as FalseNegative).occluded_fraction != null && <> · occluded {fmt((it.d as FalseNegative).occluded_fraction!, 2)}</>}
                    </>
                  ) : (
                    <>
                      type <span className="value text-text">{(it.d as FalsePositive).type}</span> · conf {fmt((it.d as FalsePositive).conf, 2)} · best IoU {fmt((it.d as FalsePositive).best_iou, 2)}
                      {(it.d as FalsePositive).gt_class && <> · GT {(it.d as FalsePositive).gt_class}</>}
                    </>
                  )}
                </span>
                <span className="value truncate text-[10px] text-dim" title={Object.entries(c).map(([k, v]) => `${k}=${condStr(v)}`).join(", ")}>
                  {["environment", "turbidity", "lighting", "current_speed_mps", "depth_m"]
                    .filter((k) => k in c)
                    .map((k) => `${k}=${condStr(c[k])}`)
                    .join(" · ")}
                </span>
              </figcaption>
            </figure>
          );
        })}
      </div>
      {!filtered.length && <p className="text-[12px] text-muted">No failure matches these filters.</p>}
      {filtered.length > limit && (
        <button type="button" className="btn w-fit self-center" onClick={() => setLimit((l) => l + PAGE)}>
          Show {Math.min(PAGE, filtered.length - limit)} more
        </button>
      )}
    </div>
  );
}

function sameBox(a: number[], b: number[]) {
  return a.every((v, i) => Math.abs(v - b[i]) < 0.6);
}
