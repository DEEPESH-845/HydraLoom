"use client";

import clsx from "clsx";
import { ArrowRight, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { api, isApiError, watchRun, type ApiError, type RunWatchSource } from "@/lib/api/client";
import type { AdapterChoice, ComputeProfile, DatasetRecord, DeviceChoice, HealthResponse, ModelRecord, RunConfig, RunRecord, RunStatus } from "@/lib/api/types";
import type { ClassMap } from "./ClassMapEditor";
import { ErrorNote, Field, inputCls, KindTag, ProgressBar, StatusPill } from "./ui";

export interface InferenceSettings {
  conf: number;
  iou: number;
  imgsz: number;
  max_det: number;
  device: DeviceChoice;
  compute_profile: string;
  budget_fps: number;
  adapter: AdapterChoice;
  seed: number;
}

export const DEFAULT_SETTINGS: InferenceSettings = {
  conf: 0.25,
  iou: 0.7,
  imgsz: 640,
  max_det: 300,
  device: "auto",
  compute_profile: "auto",
  budget_fps: 10,
  adapter: "auto",
  seed: 0,
};

export function settingsErrors(s: InferenceSettings): string[] {
  const e: string[] = [];
  if (!(s.conf >= 0 && s.conf <= 1)) e.push("conf must be between 0 and 1");
  if (!(s.iou > 0 && s.iou <= 1)) e.push("NMS IoU must be above 0 and at most 1");
  if (!(Number.isInteger(s.imgsz) && s.imgsz >= 32 && s.imgsz <= 4096 && s.imgsz % 32 === 0)) e.push("imgsz must be a multiple of 32 between 32 and 4096");
  if (!(Number.isInteger(s.max_det) && s.max_det >= 1 && s.max_det <= 3000)) e.push("max_det must be an integer from 1 to 3000");
  if (!(s.budget_fps > 0 && s.budget_fps <= 10000)) e.push("FPS budget must be above 0");
  if (!Number.isInteger(s.seed)) e.push("seed must be an integer");
  return e;
}

export function InferenceConfigForm({
  value,
  onChange,
  health,
  profiles,
  model,
}: {
  value: InferenceSettings;
  onChange: (s: InferenceSettings) => void;
  health: HealthResponse;
  profiles: ComputeProfile[];
  model: ModelRecord | null;
}) {
  const uid = useId();
  const set = <K extends keyof InferenceSettings>(k: K, v: InferenceSettings[K]) => onChange({ ...value, [k]: v });
  const num = (k: keyof InferenceSettings, raw: string) => set(k, (raw === "" ? NaN : Number(raw)) as never);
  const hasCuda = (health.devices.cuda ?? []).length > 0;
  const realAdapter = model?.format === "onnx" ? "onnx" : "ultralytics";
  const realAvailable = !!health.adapters[realAdapter];
  const profile = profiles.find((p) => p.id === value.compute_profile) ?? null;
  const errs = settingsErrors(value);

  return (
    <div className="flex flex-col gap-4" data-testid="inference-config">
      <fieldset className="flex flex-col gap-2">
        <legend className="label mb-1.5">Adapter</legend>
        <div className="grid grid-cols-2 gap-2 max-[479px]:grid-cols-1">
          <AdapterOption
            name={`${uid}-adapter`}
            checked={value.adapter === "auto"}
            onSelect={() => set("adapter", "auto")}
            title={`Auto (${model ? realAdapter : "by format"})`}
            text={realAvailable ? "Real inference in the sandbox worker. Requires an inspected (ready) model." : `${realAdapter} adapter not available on this backend.`}
            disabled={!realAvailable}
          />
          <AdapterOption
            name={`${uid}-adapter`}
            checked={value.adapter === "mock"}
            onSelect={() => set("adapter", "mock")}
            title="Mock"
            text="MOCK - not a real model evaluation. Deterministic fake detections for pipeline checks."
            danger
            disabled={!health.adapters.mock}
          />
        </div>
      </fieldset>

      <div className="grid grid-cols-4 gap-3 max-[759px]:grid-cols-2">
        <Field label="Confidence" htmlFor={`${uid}-conf`} hint="Operating threshold">
          <input id={`${uid}-conf`} type="number" step="0.01" min={0} max={1} className={inputCls} value={Number.isNaN(value.conf) ? "" : value.conf} onChange={(e) => num("conf", e.target.value)} />
        </Field>
        <Field label="NMS IoU" htmlFor={`${uid}-iou`} hint="Not the match IoU (0.5)">
          <input id={`${uid}-iou`} type="number" step="0.05" min={0.05} max={1} className={inputCls} value={Number.isNaN(value.iou) ? "" : value.iou} onChange={(e) => num("iou", e.target.value)} />
        </Field>
        <Field label="imgsz" htmlFor={`${uid}-imgsz`} hint="Multiple of 32">
          <input id={`${uid}-imgsz`} type="number" step={32} min={32} max={4096} className={inputCls} value={Number.isNaN(value.imgsz) ? "" : value.imgsz} onChange={(e) => num("imgsz", e.target.value)} />
        </Field>
        <Field label="max_det" htmlFor={`${uid}-maxdet`}>
          <input id={`${uid}-maxdet`} type="number" step={1} min={1} max={3000} className={inputCls} value={Number.isNaN(value.max_det) ? "" : value.max_det} onChange={(e) => num("max_det", e.target.value)} />
        </Field>
        <Field label="Device" htmlFor={`${uid}-device`} hint={hasCuda ? (health.devices.cuda ?? [])[0] : "No CUDA device on this backend"}>
          <select id={`${uid}-device`} className={inputCls} value={value.device} onChange={(e) => set("device", e.target.value as DeviceChoice)} disabled={value.adapter === "mock"}>
            <option value="auto">auto</option>
            <option value="cpu">cpu</option>
            <option value="cuda" disabled={!hasCuda}>
              cuda{hasCuda ? "" : " (unavailable)"}
            </option>
          </select>
        </Field>
        <Field label="FPS budget" htmlFor={`${uid}-fps`} hint="Required frame rate">
          <input id={`${uid}-fps`} type="number" step={1} min={1} className={inputCls} value={Number.isNaN(value.budget_fps) ? "" : value.budget_fps} onChange={(e) => num("budget_fps", e.target.value)} />
        </Field>
        <Field label="Seed" htmlFor={`${uid}-seed`}>
          <input id={`${uid}-seed`} type="number" step={1} className={inputCls} value={Number.isNaN(value.seed) ? "" : value.seed} onChange={(e) => num("seed", e.target.value)} />
        </Field>
        <Field label="Compute profile" htmlFor={`${uid}-profile`}>
          <select id={`${uid}-profile`} className={inputCls} value={value.compute_profile} onChange={(e) => set("compute_profile", e.target.value)}>
            <option value="auto">auto (device that ran)</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.id} - {p.kind}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="border border-line px-3 py-2" data-testid="profile-info">
        {profile ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <KindTag kind={profile.kind} />
              <span className="text-[12px] text-text">{profile.name}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted">{profile.method}</p>
            {profile.assumptions.length > 0 && (
              <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-snug text-dim">
                {profile.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-[11px] text-muted">
            <span className="text-text">auto</span> reports the measured block of the device that ran inference. Every profile block (measured host, estimated Raspberry Pi)
            is still computed and shown in the report.
          </p>
        )}
      </div>

      {errs.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[11px] text-danger" role="alert">
          {errs.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AdapterOption({
  name,
  checked,
  onSelect,
  title,
  text,
  danger,
  disabled,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  text: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <label
      className={clsx(
        "flex cursor-pointer items-start gap-2 border px-3 py-2 transition-colors duration-100",
        checked ? (danger ? "border-danger/80 bg-danger/5" : "border-teal bg-teal/5") : "border-line hover:border-line-strong",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} disabled={disabled} className={clsx("mt-0.5", danger ? "accent-danger" : "accent-teal")} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={clsx("label", danger ? "text-danger" : "text-text")}>{title}</span>
        <span className="text-[11px] leading-snug text-muted">{text}</span>
      </span>
    </label>
  );
}

interface LiveRun {
  id: string;
  status: RunStatus;
  progress: number;
  message: string;
  source: RunWatchSource | null;
  log: { ts: string; message: string }[];
  final: RunRecord | null;
  mock: boolean;
}

export function RunLauncher({
  model,
  dataset,
  settings,
  classMap,
  onStarted,
  onFinished,
  blockers,
}: {
  model: ModelRecord | null;
  dataset: DatasetRecord | null;
  settings: InferenceSettings;
  classMap: ClassMap;
  onStarted: () => void;
  onFinished: (run: RunRecord) => void;
  blockers: string[];
}) {
  const [live, setLive] = useState<LiveRun | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [starting, setStarting] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  const running = !!live && (live.status === "queued" || live.status === "running");
  const disabled = !!blockers.length || starting || running;

  const start = async () => {
    if (!model || !dataset) return;
    setError(null);
    setStarting(true);
    const mock = settings.adapter === "mock";
    const config: RunConfig = {
      conf: settings.conf,
      iou: settings.iou,
      imgsz: settings.imgsz,
      max_det: settings.max_det,
      device: mock ? "auto" : settings.device,
      // The mock adapter predicts dataset classes directly, so a model class map does not apply.
      class_map: mock ? {} : classMap,
      compute_profile: settings.compute_profile,
      budget_fps: settings.budget_fps,
      warmup_frames: null,
    };
    try {
      const created = await api.createRun({ model_id: model.id, dataset_id: dataset.id, adapter: settings.adapter, seed: settings.seed, config });
      setLive({ id: created.id, status: created.status, progress: 0, message: "queued", source: null, log: [], final: null, mock });
      onStarted();
      cancelRef.current?.();
      cancelRef.current = watchRun(created.id, {
        onSourceChange: (source) => setLive((l) => (l ? { ...l, source } : l)),
        onUpdate: (u) =>
          setLive((l) => {
            if (!l) return l;
            const last = l.log[l.log.length - 1];
            const log = !last || last.message !== u.message ? [...l.log, { ts: u.ts, message: u.message }].slice(-6) : l.log;
            return { ...l, status: u.status, progress: u.progress, message: u.message, log };
          }),
        onDone: (run) => {
          setLive((l) => (l ? { ...l, status: run.status, progress: run.progress, message: run.message, final: run } : l));
          onFinished(run);
        },
        onError: (e) => setError(e),
      });
    } catch (e) {
      if (isApiError(e)) setError(e);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="run-launcher">
      {blockers.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[11px] text-muted">
          {blockers.map((b) => (
            <li key={b} className="flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full bg-amber" aria-hidden />
              {b}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary inline-flex items-center gap-1.5" onClick={start} disabled={disabled} data-testid="start-run">
          <Play size={13} /> {starting ? "Starting" : settings.adapter === "mock" ? "Start mock run" : "Start evaluation"}
        </button>
        {settings.adapter === "mock" && <span className="sim-tag !border-danger/70 !text-danger">MOCK - not a real model evaluation</span>}
      </div>
      {error && <ErrorNote error={error} />}
      {live && (
        <div className="flex flex-col gap-2 border border-line px-3 py-2.5" data-testid="run-progress" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="value text-[12px] text-text">{live.id}</span>
            <span className="flex items-center gap-2">
              {live.source && <span className="label text-[9px] text-dim">via {live.source === "websocket" ? "live events" : "status polling"}</span>}
              <StatusPill status={live.status} />
            </span>
          </div>
          <ProgressBar value={live.progress} label="Run progress" tone={live.status === "failed" ? "amber" : "teal"} />
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate text-muted" data-testid="run-message">
              {live.message}
            </span>
            <span className="value text-muted">{Math.round(live.progress * 100)}%</span>
          </div>
          {live.final?.status === "failed" && <p className="text-[12px] text-danger">{live.final.error ?? "Run failed."}</p>}
          {live.final?.warnings.map((w) => (
            <p key={w} className="text-[11px] text-amber">
              {w}
            </p>
          ))}
          {live.final?.status === "complete" && (
            <Link href={`/reports/${live.id}`} className="btn inline-flex w-fit items-center gap-1.5" data-testid="run-result-link">
              Open analysis and report <ArrowRight size={13} />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
