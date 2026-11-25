"use client";

import clsx from "clsx";
import { Download } from "lucide-react";
import Link from "next/link";
import { api, urls } from "@/lib/api/client";
import { useResource } from "@/lib/api/hooks";
import type { DatasetRecord } from "@/lib/api/types";
import { FrameView, xywhToXyxy } from "./FrameView";
import { EmptyState, ErrorNote, fmtBytes, fmtDate, fmtInt, Skeleton } from "./ui";

export function environmentsOf(ds: DatasetRecord): string[] {
  const env = ds.conditions.environment;
  return env?.values ?? [];
}

export function DatasetPicker({
  datasets,
  selectedId,
  onSelect,
}: {
  datasets: DatasetRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!datasets.length)
    return (
      <EmptyState title="No datasets captured yet" icon={<span className="h-2 w-2 rounded-full bg-amber" aria-hidden />}>
        Datasets are captured from the 3D digital twin, not uploaded by hand. Open the{" "}
        <Link href="/lab" prefetch={false} className="text-text underline decoration-line-strong underline-offset-2 hover:decoration-teal">
          Gantry Lab
        </Link>{" "}
        or the field{" "}
        <Link href="/?ws=simulation" className="text-text underline decoration-line-strong underline-offset-2 hover:decoration-teal">
          Analysis workspace
        </Link>{" "}
        and use <span className="value text-text">Capture dataset</span>. Each frame ships with ground truth from the instance-ID render pass and its water, light and
        current conditions.
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-1" role="listbox" aria-label="Datasets" data-testid="dataset-list">
      {datasets.map((d) => {
        const on = d.id === selectedId;
        const envs = environmentsOf(d);
        return (
          <button
            key={d.id}
            type="button"
            role="option"
            aria-selected={on}
            onClick={() => onSelect(d.id)}
            className={clsx(
              "grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border px-3 py-2 text-left transition-colors duration-100",
              on ? "border-teal bg-teal/5" : "border-line hover:border-line-strong",
            )}
          >
            <span className="min-w-0 truncate text-[13px] text-text">{d.name}</span>
            <span className="value text-[11px] text-muted">{fmtInt(d.n_frames)} frames</span>
            <span className="value min-w-0 truncate text-[11px] text-dim">
              {envs.length ? envs.join(", ") : "environment not recorded"} · {d.classes.length} classes
            </span>
            <span className="value text-[10px] text-dim">{fmtDate(d.created_at).slice(0, 10)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function DatasetDetailView({ dataset }: { dataset: DatasetRecord }) {
  const manifest = useResource(`manifest:${dataset.id}`, (s) => api.getManifest(dataset.id, s));
  const envs = environmentsOf(dataset);
  const frames = manifest.data?.frames.slice(0, 8) ?? [];
  return (
    <div className="flex flex-col gap-3" data-testid="dataset-detail">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <span className="value text-muted">
          <span className="text-text">{fmtInt(dataset.n_frames)}</span> frames
        </span>
        <span className="value text-muted">
          <span className="text-text">{fmtInt(dataset.n_annotations)}</span> objects
        </span>
        <span className="value text-muted">{fmtBytes(dataset.total_bytes)}</span>
        <span className="value text-muted">seed {dataset.seed ?? "n/a"}</span>
        <span className="value text-dim">{fmtDate(dataset.created_at)}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {envs.map((e) => (
          <span key={e} className="sim-tag !text-text">
            {e.toUpperCase()}
          </span>
        ))}
        {dataset.classes.map((c) => (
          <span key={c} className="border border-amber/40 px-1.5 py-[1px] font-mono text-[10px] text-text">
            {c} <span className="text-dim">{dataset.class_counts[c] ?? 0}</span>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <a className="btn inline-flex items-center gap-1.5 !py-1.5" href={urls.yoloZip(dataset.id)} download>
          <Download size={12} /> YOLO zip
        </a>
        <a className="btn inline-flex items-center gap-1.5 !py-1.5" href={urls.cocoJson(dataset.id)} download>
          <Download size={12} /> COCO json
        </a>
      </div>
      <div>
        <div className="label mb-1.5">Frames with ground truth</div>
        {manifest.error && <ErrorNote error={manifest.error} onRetry={manifest.reload} />}
        <div className="grid grid-cols-4 gap-1.5 max-[599px]:grid-cols-2" data-testid="frame-strip">
          {manifest.loading
            ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="aspect-[4/3] w-full" />)
            : frames.map((f) => (
                <figure key={f.file} className="min-w-0">
                  <FrameView
                    src={urls.frame(dataset.id, f.file)}
                    width={f.width}
                    height={f.height}
                    alt={`Frame ${f.file}`}
                    showLabels={false}
                    boxes={f.annotations.map((a) => ({ xyxy: xywhToXyxy(a.bbox_xywh), kind: "gt" as const, label: a.class_name }))}
                    className="border border-line"
                  />
                  <figcaption className="value mt-0.5 truncate text-[10px] text-dim">
                    {f.file} · {String(f.conditions.environment ?? "")} · {f.annotations.length} GT
                  </figcaption>
                </figure>
              ))}
        </div>
      </div>
    </div>
  );
}
