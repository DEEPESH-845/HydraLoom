"use client";

import clsx from "clsx";
import { useState } from "react";
import type { ModelRecord } from "@/lib/api/types";
import { CopyButton, EmptyState, fmt, fmtBytes, fmtCompact, fmtDate, KV, NA, shortSha, StatusPill } from "./ui";

export function ModelList({ models, selectedId, onSelect }: { models: ModelRecord[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!models.length)
    return (
      <EmptyState title="No models yet">
        Upload a trained detector above. YOLO checkpoints (<span className="value">best.pt</span>) and ONNX exports are supported.
      </EmptyState>
    );
  return (
    <ul className="flex flex-col gap-1" role="listbox" aria-label="Models" data-testid="model-list">
      {models.map((m) => {
        const on = m.id === selectedId;
        return (
          <li key={m.id} role="option" aria-selected={on}>
            <button
              type="button"
              onClick={() => onSelect(m.id)}
              className={clsx(
                "grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border px-3 py-2 text-left transition-colors duration-100",
                on ? "border-teal bg-teal/5" : "border-line hover:border-line-strong",
              )}
            >
              <span className="min-w-0 truncate text-[13px] text-text">
                {m.name} <span className="value text-[11px] text-muted">v{m.version}</span>
              </span>
              <StatusPill status={m.status} />
              <span className="value min-w-0 truncate text-[11px] text-dim">
                {m.format.toUpperCase()} · {fmtBytes(m.size_bytes)} · {shortSha(m.sha256)}
              </span>
              <span className="value text-[10px] text-dim">{fmtDate(m.uploaded_at).slice(0, 10)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ModelDetail({ model }: { model: ModelRecord }) {
  const ins = model.inspection;
  const names = ins ? Object.entries(ins.names).sort((a, b) => Number(a[0]) - Number(b[0])) : [];
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? names : names.slice(0, 24);
  return (
    <div className="flex flex-col gap-4" data-testid="model-detail">
      {model.status === "rejected" && (
        <div role="alert" className="border border-danger/60 bg-danger/5 px-3 py-2 text-[12px]">
          <span className="label mr-2 text-danger">Rejected</span>
          <span className="text-text">{model.status_reason ?? "Rejected by inspection."}</span>
        </div>
      )}
      {model.status === "pending" && <p className="text-[12px] text-amber">Inspection running in the sandbox worker.</p>}
      <div className="flex min-w-0 items-center gap-2 border border-line bg-ground px-2 py-1.5">
        <span className="label shrink-0 text-[9px]">SHA-256</span>
        <span className="value min-w-0 flex-1 truncate text-[11px] text-text" title={model.sha256} data-testid="model-sha">
          {model.sha256}
        </span>
        <CopyButton text={model.sha256} label="Copy SHA-256" compact />
      </div>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-3 max-[479px]:grid-cols-2">
        <KV k="Name" v={model.name} mono={false} />
        <KV k="Version" v={`v${model.version}`} />
        <KV k="Format" v={model.format.toUpperCase()} />
        <KV k="Size" v={fmtBytes(model.size_bytes)} />
        <KV k="Task" v={ins?.task ?? NA} />
        <KV k="Classes (nc)" v={ins?.nc ?? NA} />
        <KV k="imgsz" v={ins?.imgsz ?? NA} />
        <KV k="Params" v={fmtCompact(ins?.parameters)} />
        <KV k={`GFLOPs${ins?.gflops_imgsz ? ` @${ins.gflops_imgsz}` : ""}`} v={fmt(ins?.gflops, 2)} />
        <KV k="Architecture" v={ins?.architecture ?? NA} />
        <KV k="Forward check" v={ins?.forward_check ?? NA} />
        <KV k="Uploaded" v={fmtDate(model.uploaded_at)} />
      </dl>
      {ins?.format === "onnx" && (
        <dl className="grid grid-cols-3 gap-x-4 gap-y-3 max-[479px]:grid-cols-2">
          <KV k="ONNX producer" v={String(ins.onnx_producer ?? NA)} />
          <KV k="Opset" v={String(ins.onnx_opset ?? NA)} />
        </dl>
      )}
      {names.length > 0 && (
        <div>
          <div className="label mb-1.5">Class names ({names.length})</div>
          <div className="flex flex-wrap gap-1" data-testid="model-classes">
            {visible.map(([id, n]) => (
              <span key={id} className="border border-line px-1.5 py-[1px] font-mono text-[10px] text-muted">
                <span className="text-dim">{id}</span> {n}
              </span>
            ))}
            {names.length > 24 && (
              <button type="button" className="border border-line-strong px-1.5 py-[1px] font-mono text-[10px] text-text hover:border-teal" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "show fewer" : `+${names.length - 24} more`}
              </button>
            )}
          </div>
        </div>
      )}
      {model.versions.length > 1 && (
        <div>
          <div className="label mb-1.5">Versions</div>
          <table className="w-full text-[11px]">
            <tbody>
              {model.versions
                .slice()
                .sort((a, b) => b.version - a.version)
                .map((v) => (
                  <tr key={v.id} className="border-t border-line">
                    <td className="value py-1 pr-2 text-text">v{v.version}</td>
                    <td className="value py-1 pr-2 text-muted">{shortSha(v.sha256)}</td>
                    <td className="value py-1 pr-2 text-dim">{fmtDate(v.uploaded_at)}</td>
                    <td className="py-1 text-right">
                      <StatusPill status={v.status} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {ins && (ins.checkpoint_ultralytics_version || ins.checkpoint_date) && (
        <p className="text-[11px] text-dim">
          Checkpoint written by Ultralytics {ins.checkpoint_ultralytics_version ?? NA}
          {ins.checkpoint_date ? ` on ${ins.checkpoint_date.slice(0, 10)}` : ""}. Inspected with torch {ins.worker_versions?.torch ?? NA}, ultralytics{" "}
          {ins.worker_versions?.ultralytics ?? NA}.
        </p>
      )}
    </div>
  );
}
