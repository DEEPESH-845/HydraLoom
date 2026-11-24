"use client";

import clsx from "clsx";
import { useRef, useState } from "react";
import type { MissionResult } from "@/lib/field/engine";
import { useFieldStore } from "@/lib/field/store";
import { MISSIONS } from "@/lib/missions";
import { datasetApiBase, runCapture, saveJson, uploadDataset, type CapturePreset, type CapturedFrame, type Manifest } from "@/components/field/capture";
import { captureTarget } from "@/components/field/runtime";
import { CardHead, Btn, Row, Section, Segmented, SimTag, f1, f2, pct } from "./ui";

export function AnalysisCard() {
  return (
    <div>
      <CardHead index="05 Analysis" title="Live analysis" note="Detections come from the ANALYTICAL detector: a physically based confidence model, not a trained network." right={<SimTag />} />
      <Detections />
      <Result />
      <Events />
      <CaptureDataset />
    </div>
  );
}

function Detections() {
  const detections = useFieldStore((s) => s.detections);
  return (
    <Section title={`Detections (${detections.length})`} right={<SimTag>ANALYTICAL</SimTag>}>
      {detections.length === 0 ? (
        <p className="text-[11px] text-dim">Nothing above the threshold in the platform camera right now.</p>
      ) : (
        <ul className="space-y-0.5" data-testid="detections">
          {detections.map((d) => (
            <li key={d.targetId} className="value flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-amber">
                {d.class} <span className="text-dim">{d.targetId}</span>
              </span>
              <span className="text-text">
                {pct(d.confidence, 1)} <span className="text-dim">at {f1(d.distance)} m</span> <span className={d.correct ? "text-teal" : "text-danger"}>{d.correct ? "correct" : `true ${d.trueClass}`}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function delta(cur: number, prev: number | undefined, d = 2, unit = "", better: "up" | "down" = "up") {
  if (prev === undefined) return null;
  const v = cur - prev;
  if (Math.abs(v) < 10 ** -d / 2) return <span className="text-dim"> (same)</span>;
  const good = better === "up" ? v > 0 : v < 0;
  return (
    <span className={good ? "text-ok" : "text-danger"}>
      {" "}
      ({v > 0 ? "+" : ""}
      {v.toFixed(d)}
      {unit})
    </span>
  );
}

function Result() {
  const r = useFieldStore((s) => s.result);
  const p = useFieldStore((s) => s.previousResult);
  const phase = useFieldStore((s) => s.phase);
  if (!r) return <Section title="Mission result">{<p className="text-[11px] text-dim">{phase === "RUNNING" ? "Mission running; the result appears when it completes or is aborted." : "Start a mission in 03 Simulation to get a result."}</p>}</Section>;
  const P: Partial<MissionResult> = p ?? {};
  return (
    <Section title={`Mission result: ${MISSIONS[r.mission].name}`} right={<SimTag />}>
      <div className="grid grid-cols-1 gap-x-6 min-[560px]:grid-cols-2" data-testid="result">
        <Row k="Targets found" v={<>{`${r.targetsFound} / ${r.targetsTotal}`}{delta(r.targetsFound, P.targetsFound, 0)}</>} tone="amber" />
        <Row k="Correct class" v={<>{r.correctClass}{delta(r.correctClass, P.correctClass, 0)}</>} />
        <Row k="Coverage" v={<>{pct(r.coverage, 1)}{delta(r.coverage * 100, P.coverage === undefined ? undefined : P.coverage * 100, 1, " pt")}</>} />
        <Row k="Distance" v={<>{f1(r.distanceM)} m{delta(r.distanceM, P.distanceM, 1, " m", "down")}</>} />
        <Row k="Energy (thrusters)" v={<>{f1(r.energyJ)} J{delta(r.energyJ, P.energyJ, 1, " J", "down")}</>} />
        <Row k="Cross-track RMS" v={<>{f2(r.crossTrackRmsM)} m{delta(r.crossTrackRmsM, P.crossTrackRmsM, 2, " m", "down")}</>} />
        <Row k="Contacts" v={<>{r.contacts}{delta(r.contacts, P.contacts, 0, "", "down")}</>} tone={r.contacts ? "danger" : undefined} />
        <Row k="First-detection range" v={<>{f1(r.firstDetectionRangeM)} m{delta(r.firstDetectionRangeM, P.firstDetectionRangeM, 1, " m")}</>} />
        <Row k="Mean confidence" v={<>{pct(r.meanConfidence, 1)}{delta(r.meanConfidence * 100, P.meanConfidence === undefined ? undefined : P.meanConfidence * 100, 1, " pt")}</>} />
        <Row k="False positives" v={<>{r.falsePositives}{delta(r.falsePositives, P.falsePositives, 0, "", "down")}</>} />
        <Row k="Duration" v={`${f1(r.durationS)} s`} />
        <Row k="Conditions" v={`${f2(r.conditions.ntu)} NTU, ${f2(r.conditions.currentSpeedMps)} m/s`} />
      </div>
      <p className="mt-1 text-[10px] text-dim">{p ? "Bracketed values are the change from the previous run." : "Run again to compare against this result."} Detector: {r.detector}.</p>
    </Section>
  );
}

function Events() {
  const events = useFieldStore((s) => s.events);
  const last = events.slice(-40).reverse();
  return (
    <Section title="Events">
      <ul className="max-h-36 space-y-0.5 overflow-y-auto pr-1" data-testid="events">
        {last.map((e, i) => (
          <li key={`${e.t}-${i}`} className="value flex gap-2 text-[10px]">
            <span className="w-12 shrink-0 text-dim">{e.t.toFixed(1)} s</span>
            <span className={clsx("w-16 shrink-0", e.kind === "DETECT" ? "text-amber" : e.kind === "CONTACT" ? "text-danger" : "text-teal")}>{e.kind}</span>
            <span className="text-muted">{e.text}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ---------- dataset capture ---------- */

interface CaptureState {
  status: "idle" | "running" | "done" | "error";
  done: number;
  total: number;
  message: string;
  manifest: Manifest | null;
  frames: CapturedFrame[];
  datasetId: string | null;
  uploadError: string | null;
}

/** Last capture, for tests and for saving. */
export const lastCapture: { manifest: Manifest | null; frames: CapturedFrame[] } = { manifest: null, frames: [] };

function CaptureDataset() {
  const [preset, setPreset] = useState<CapturePreset>("jitter");
  const [frames, setFrames] = useState(8);
  const [every, setEvery] = useState(2);
  const [seed, setSeed] = useState(1337);
  const [name, setName] = useState("");
  const [st, setSt] = useState<CaptureState>({ status: "idle", done: 0, total: 0, message: "", manifest: null, frames: [], datasetId: null, uploadError: null });
  const abort = useRef<AbortController | null>(null);
  const vehicle = useFieldStore((s) => s.platformId !== "station");

  const start = async () => {
    const { gl, scene } = captureTarget;
    if (!gl || !scene) return;
    const engine = useFieldStore.getState().engine;
    abort.current = new AbortController();
    setSt({ status: "running", done: 0, total: 0, message: "", manifest: null, frames: [], datasetId: null, uploadError: null });
    try {
      const out = await runCapture(gl, scene, engine, { preset, name, seed, frames, everyS: every }, (p) => setSt((s) => ({ ...s, done: p.done, total: p.total })), abort.current.signal);
      lastCapture.manifest = out.manifest;
      lastCapture.frames = out.frames;
      useFieldStore.getState().publish();
      const n = out.manifest.frames.reduce((a, f) => a + f.annotations.length, 0);
      setSt((s) => ({ ...s, status: "done", manifest: out.manifest, frames: out.frames, message: `${out.frames.length} frames, ${n} annotations. Uploading...` }));
      try {
        const up = await uploadDataset(out.manifest, out.frames);
        setSt((s) => ({ ...s, datasetId: up.id || null, message: `${out.frames.length} frames, ${n} annotations. Stored by the backend${up.id ? ` as ${up.id}` : ""}.` }));
      } catch (e) {
        setSt((s) => ({ ...s, uploadError: (e as Error).message, message: `${out.frames.length} frames, ${n} annotations captured.` }));
      }
    } catch (e) {
      const cancelled = (e as Error).name === "AbortError";
      setSt((s) => ({ ...s, status: cancelled ? "idle" : "error", message: cancelled ? "Capture cancelled." : (e as Error).message }));
      useFieldStore.getState().publish();
    }
  };

  const running = st.status === "running";
  return (
    <Section title="Capture dataset" right={<SimTag>GROUND TRUTH</SimTag>}>
      <p className="mb-2 text-[11px] leading-snug text-muted">
        Renders the platform camera through the same water and labels every target from an instance-id render of the same camera (occlusion by terrain and structures included). Frames are seeded and reproducible.
      </p>
      <Segmented<CapturePreset>
        label="Capture preset"
        testId="capture-preset"
        value={preset}
        onChange={setPreset}
        options={[
          { id: "jitter", label: "Current pose x N" },
          { id: "mission", label: "Mission path", disabled: !vehicle, title: vehicle ? "" : "The station does not move" },
          { id: "turbidity", label: "Turbidity sweep" },
          { id: "lighting", label: "Lighting sweep" },
        ]}
      />
      <div className="mt-2 grid grid-cols-2 gap-2 min-[560px]:grid-cols-4">
        <NumField label="Frames" value={frames} min={1} max={200} onChange={setFrames} disabled={preset === "turbidity" || preset === "lighting"} testId="capture-frames" />
        <NumField label="Every (s)" value={every} min={0.5} max={60} step={0.5} onChange={setEvery} disabled={preset !== "mission"} />
        <NumField label="Seed" value={seed} min={0} max={2 ** 31} onChange={setSeed} />
        <label className="flex flex-col gap-0.5 text-[10px] text-muted">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="auto" className="border border-line-strong bg-panel-2 px-1.5 py-1 text-[12px] text-text" maxLength={120} />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {running ? (
          <Btn onClick={() => abort.current?.abort()}>Cancel</Btn>
        ) : (
          <Btn primary onClick={start}>
            Capture
          </Btn>
        )}
        {st.manifest && !running && (
          <Btn onClick={() => saveJson(`${st.manifest!.name}.manifest.json`, st.manifest)} title="Save the manifest JSON locally">
            Save manifest
          </Btn>
        )}
        {st.datasetId && (
          <a className="btn" href={`${datasetApiBase()}/api/v1/datasets/${encodeURIComponent(st.datasetId)}/export/yolo.zip`} target="_blank" rel="noreferrer">
            Download dataset
          </a>
        )}
      </div>
      {(running || st.total > 0) && (
        <div className="mt-2" role="status" aria-live="polite" data-testid="capture-status">
          <div className="h-1 w-full bg-panel-2">
            <div className="h-full bg-teal transition-[width] duration-150" style={{ width: `${st.total ? (st.done / st.total) * 100 : 0}%` }} />
          </div>
          <div className="value mt-1 text-[10px] text-muted">
            {running ? `Frame ${st.done} of ${st.total || "?"}` : st.message}
          </div>
        </div>
      )}
      {!running && st.status !== "running" && st.message && st.total === 0 && <p className="value mt-1 text-[10px] text-muted">{st.message}</p>}
      {st.uploadError && (
        <p className="mt-1 text-[11px] leading-snug text-danger" role="alert" data-testid="capture-upload-error">
          {st.uploadError}
        </p>
      )}
      {st.manifest && <AnnotationSummary manifest={st.manifest} />}
    </Section>
  );
}

function AnnotationSummary({ manifest }: { manifest: Manifest }) {
  const counts: Record<string, number> = {};
  for (const f of manifest.frames) for (const a of f.annotations) counts[a.class_name] = (counts[a.class_name] ?? 0) + 1;
  return (
    <div className="value mt-1 flex flex-wrap gap-x-3 text-[10px] text-muted">
      {Object.entries(counts).map(([k, v]) => (
        <span key={k}>
          <span className="text-amber">{k}</span> {v}
        </span>
      ))}
      {!Object.keys(counts).length && <span>No target visible in these frames (at least 12 pixels needed).</span>}
    </div>
  );
}

function NumField({ label, value, min, max, step = 1, onChange, disabled, testId }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; disabled?: boolean; testId?: string }) {
  return (
    <label className={clsx("flex flex-col gap-0.5 text-[10px] text-muted", disabled && "opacity-45")}>
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
        className="value border border-line-strong bg-panel-2 px-1.5 py-1 text-[12px] text-text"
      />
    </label>
  );
}
