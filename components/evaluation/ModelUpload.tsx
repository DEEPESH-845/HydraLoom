"use client";

import clsx from "clsx";
import { FileUp, ShieldCheck, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { isApiError, uploadModel, validateModelFile, waitForInspection, type ApiError } from "@/lib/api/client";
import type { ModelRecord } from "@/lib/api/types";
import { CopyButton, ErrorNote, fmtBytes, inputCls, ProgressBar, shortSha, StatusPill } from "./ui";

type Phase =
  | { k: "idle" }
  | { k: "invalid"; message: string }
  | { k: "uploading"; file: File; fraction: number; loaded: number }
  | { k: "inspecting"; record: ModelRecord; deduplicated: boolean }
  | { k: "done"; record: ModelRecord; deduplicated: boolean }
  | { k: "error"; error: ApiError };

export function ModelUpload({ maxMb, onChange }: { maxMb: number; onChange: (m: ModelRecord) => void }) {
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [drag, setDrag] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const busy = phase.k === "uploading" || phase.k === "inspecting";

  const start = async (file: File) => {
    const bad = validateModelFile(file, maxMb);
    if (bad) {
      setPhase({ k: "invalid", message: bad });
      return;
    }
    const trimmed = name.trim();
    if (trimmed && !/^[A-Za-z0-9 ._()+-]{1,120}$/.test(trimmed)) {
      setPhase({ k: "invalid", message: "Display name: 1 to 120 characters from A-Z a-z 0-9 space . _ ( ) + -" });
      return;
    }
    setPhase({ k: "uploading", file, fraction: 0, loaded: 0 });
    const handle = uploadModel(file, {
      name: trimmed || undefined,
      onProgress: (p) => setPhase((cur) => (cur.k === "uploading" ? { ...cur, fraction: p.fraction, loaded: p.loaded } : cur)),
    });
    abortRef.current = handle.abort;
    try {
      const { record, created } = await handle.promise;
      abortRef.current = null;
      const deduplicated = !created || record.deduplicated;
      onChange(record);
      if (record.status !== "pending") {
        setPhase({ k: "done", record, deduplicated });
        return;
      }
      setPhase({ k: "inspecting", record, deduplicated });
      const final = await waitForInspection(record.id, {
        onUpdate: (m) => setPhase((cur) => (cur.k === "inspecting" ? { ...cur, record: m } : cur)),
      });
      onChange(final);
      setPhase({ k: "done", record: final, deduplicated });
    } catch (e) {
      abortRef.current = null;
      if (isApiError(e) && e.kind === "aborted") {
        setPhase({ k: "idle" });
        return;
      }
      if (isApiError(e)) setPhase({ k: "error", error: e });
      else setPhase({ k: "invalid", message: String(e) });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (busy) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length !== 1) {
      setPhase({ k: "invalid", message: "Drop exactly one .pt or .onnx file." });
      return;
    }
    start(files[0]);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="model-upload">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={clsx(
          "flex flex-col items-center justify-center gap-2 border border-dashed px-4 py-6 text-center transition-colors duration-100",
          drag ? "border-teal bg-teal/5" : "border-line-strong",
          busy && "opacity-60",
        )}
      >
        <FileUp size={20} className={drag ? "text-teal" : "text-muted"} aria-hidden />
        <p className="text-[13px] text-text">
          Drop a <span className="value">.pt</span> or <span className="value">.onnx</span> detector here
        </p>
        <p className="text-[11px] text-dim">One file, up to {maxMb} MB</p>
        <button type="button" className="btn mt-1" onClick={() => inputRef.current?.click()} disabled={busy}>
          Choose file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pt,.onnx"
          className="sr-only"
          tabIndex={-1}
          aria-label="Model file"
          data-testid="model-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) start(f);
          }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="model-name" className="label">
          Display name (optional)
        </label>
        <input id="model-name" className={inputCls} placeholder="defaults to the file name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={120} />
      </div>

      <div aria-live="polite" className="flex flex-col gap-2">
        {phase.k === "invalid" && (
          <div role="alert" className="border border-danger/60 bg-danger/5 px-3 py-2 text-[12px] text-text" data-testid="upload-invalid">
            {phase.message}
          </div>
        )}
        {phase.k === "error" && <ErrorNote error={phase.error} />}
        {phase.k === "uploading" && (
          <div className="flex flex-col gap-1.5" data-testid="upload-progress">
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="truncate text-text">Uploading {phase.file.name}</span>
              <span className="flex items-center gap-2">
                <span className="value text-muted">
                  {fmtBytes(phase.loaded)} / {fmtBytes(phase.file.size)}
                </span>
                <button type="button" className="text-muted hover:text-text" onClick={() => abortRef.current?.()} aria-label="Cancel upload" title="Cancel upload">
                  <X size={14} />
                </button>
              </span>
            </div>
            <ProgressBar value={phase.fraction} label="Upload progress" tone="amber" />
          </div>
        )}
        {(phase.k === "inspecting" || phase.k === "done") && (
          <div className="flex flex-col gap-2 border border-line px-3 py-2" data-testid="upload-result">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="truncate text-[13px] text-text">
                {phase.record.name} <span className="value text-muted">v{phase.record.version}</span>
              </span>
              <StatusPill status={phase.record.status} />
            </div>
            {phase.k === "inspecting" && (
              <>
                <ProgressBar value={1} label="Inspection" tone="amber" />
                <p className="text-[11px] text-muted">Inspecting in the sandbox worker. This can take a few seconds for a large checkpoint.</p>
              </>
            )}
            {phase.deduplicated && <p className="text-[11px] text-muted">Same SHA-256 already registered; the existing record is shown unchanged.</p>}
            {phase.record.status === "rejected" && (
              <p className="text-[12px] text-danger" data-testid="rejection-reason">
                {phase.record.status_reason ?? "Rejected by inspection."}
              </p>
            )}
            <div className="flex items-center gap-2">
              <span className="label text-[9px]">SHA-256</span>
              <span className="value truncate text-[11px] text-muted" title={phase.record.sha256}>
                {shortSha(phase.record.sha256, 24)}...
              </span>
              <CopyButton text={phase.record.sha256} label="Copy SHA-256" compact />
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2 border-l-2 border-teal/60 bg-panel-2/60 px-3 py-2">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-teal" aria-hidden />
        <p className="text-[11px] leading-relaxed text-muted">
          A <span className="value text-text">.pt</span> file is a pickle and can run code when loaded. Uploads are only opened inside a sandboxed worker process
          with a restricted, allowlisting unpickler, never in the API process. Originals are stored by SHA-256, made read-only and never rewritten.
        </p>
      </div>
    </div>
  );
}
