"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useSimStore } from "@/lib/sim/store";
import { saveJson, uploadDataset, type Manifest } from "@/components/capture/core";
import { runLabCapture, type LabCapturePreset } from "@/components/lab/capture";
import { Btn } from "./shared";

const PRESETS: { id: LabCapturePreset; label: string }[] = [
  { id: "jitter", label: "Current pose, jittered" },
  { id: "raster", label: "Raster over travel (15)" },
  { id: "turbidity", label: "Turbidity sweep (5)" },
  { id: "lighting", label: "Lighting sweep (5)" },
];

type Status =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "uploaded"; id: string; frames: number; boxes: number }
  | { kind: "error"; message: string; manifest: Manifest | null };

/**
 * Synthetic dataset capture from the gantry camera. Frames go through the same water as the live feed; labels come
 * from an instance-ID render of the same camera, never from the detector. Collapsed by default.
 */
export function LabCapturePanel() {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<LabCapturePreset>("jitter");
  const [count, setCount] = useState(8);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  const busyEngine = useSimStore((s) => s.demo.active || (s.phase !== "IDLE" && s.phase !== "COMPLETE"));
  const running = status.kind === "running";

  const start = async () => {
    const ac = new AbortController();
    abort.current = ac;
    setStatus({ kind: "running", done: 0, total: 1 });
    let manifest: Manifest | null = null;
    try {
      const seed = useSimStore.getState().engine.scenario.seed;
      const out = await runLabCapture({ preset, name: `Gantry Lab ${preset} ${new Date().toISOString().slice(0, 16)}`, seed, count }, (p) => setStatus({ kind: "running", ...p }), ac.signal);
      manifest = out.manifest;
      const { id } = await uploadDataset(out.manifest, out.frames);
      setStatus({ kind: "uploaded", id, frames: out.frames.length, boxes: out.manifest.frames.reduce((n, f) => n + f.annotations.length, 0) });
    } catch (e) {
      if ((e as Error).name === "AbortError") setStatus({ kind: "idle" });
      else setStatus({ kind: "error", message: (e as Error).message, manifest });
    } finally {
      abort.current = null;
    }
  };

  return (
    <div className="mt-2 border-t border-line pt-1.5">
      <button type="button" className="label flex items-center gap-1.5 hover:text-text" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="value text-[10px] text-dim">{open ? "-" : "+"}</span> Capture dataset
      </button>
      {open && (
        <div className="mt-1.5" data-testid="lab-capture">
          <p className="text-[12px] leading-snug text-muted">
            Ground-truth frames from the gantry camera, through the same water as the feed. Boxes come from an instance-ID render of the same camera, not from the detector.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <select
              aria-label="Capture preset"
              value={preset}
              disabled={running}
              onChange={(e) => setPreset(e.target.value as LabCapturePreset)}
              className="value border border-line-strong bg-panel-2 px-1.5 py-[3px] text-[11px] text-text outline-none focus:border-teal"
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {preset === "jitter" && (
              <label className="flex items-center gap-1">
                <span className="label">Frames</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={count}
                  disabled={running}
                  onChange={(e) => setCount(Math.max(1, Math.min(200, Math.round(Number(e.target.value)) || 1)))}
                  className="value w-14 border border-line-strong bg-panel-2 px-1 py-[2px] text-[11px] text-text outline-none focus:border-teal"
                />
              </label>
            )}
            {running ? (
              <Btn onClick={() => abort.current?.abort()}>Cancel</Btn>
            ) : (
              <Btn primary onClick={start} disabled={busyEngine} title={busyEngine ? "Wait for the demo or test to finish" : undefined}>
                Capture and upload
              </Btn>
            )}
          </div>
          <div className="value mt-1 text-[11px]" role="status">
            {status.kind === "running" && (
              <span className="text-teal">
                Frame {status.done} / {status.total}
              </span>
            )}
            {status.kind === "uploaded" && (
              <span className="text-text">
                Dataset {status.id}: {status.frames} frames, {status.boxes} boxes.{" "}
                <Link href="/models" className="underline decoration-line-strong underline-offset-2 hover:decoration-teal">
                  Evaluate a model in the Model Lab
                </Link>
              </span>
            )}
            {status.kind === "error" && (
              <span className="text-amber">
                {status.message}
                {status.manifest && (
                  <button type="button" className="ml-2 underline underline-offset-2" onClick={() => saveJson("gantrylab-dataset-manifest.json", status.manifest)}>
                    Save manifest JSON
                  </button>
                )}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
