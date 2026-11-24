"use client";

import Link from "next/link";
import { useState } from "react";
import { coverage, suggestClassMap } from "@/components/evaluation/ClassMapEditor";
import { modelClassNames } from "@/components/evaluation/ModelLab";
import { DEFAULT_SETTINGS } from "@/components/evaluation/RunLauncher";
import { EmptyState, ErrorNote, Field, Panel, StatusPill, inputCls } from "@/components/evaluation/ui";
import { api, isApiError, type ApiError } from "@/lib/api/client";
import { useResource } from "@/lib/api/hooks";
import type { Profiles } from "./useProfiles";

/** Evaluate several uploaded models on one dataset with identical settings, so the results are comparable. */
export function BatchEvaluate({ p }: { p: Profiles }) {
  const models = useResource(p.online ? "models" : null, (s) => api.listModels(s));
  const datasets = useResource(p.online ? "datasets" : null, (s) => api.listDatasets(s));
  const [picked, setPicked] = useState<string[]>([]);
  const [dsId, setDsId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ready = (models.data?.models ?? []).filter((m) => m.status === "ready");
  const ds = (datasets.data?.datasets ?? []).find((d) => d.id === dsId) ?? datasets.data?.datasets[0] ?? null;
  const running = (p.runs.data?.runs ?? []).filter((r) => r.status === "queued" || r.status === "running");
  const failed = (p.runs.data?.runs ?? []).filter((r) => r.status === "failed").slice(0, 3);

  const start = async () => {
    if (!ds) return;
    setBusy(true);
    setError(null);
    try {
      for (const id of picked) {
        const m = ready.find((x) => x.id === id);
        if (!m) continue;
        const { adapter, seed, ...cfg } = DEFAULT_SETTINGS;
        await api.createRun({ model_id: m.id, dataset_id: ds.id, adapter, seed, config: { ...cfg, class_map: suggestClassMap(modelClassNames(m), ds.classes), warmup_frames: null } });
      }
      setPicked([]);
      p.setSource("measured");
    } catch (e) {
      if (isApiError(e)) setError(e);
      else throw e;
    } finally {
      setBusy(false);
      p.runs.reload();
    }
  };

  return (
    <Panel id="evaluate" label="Your models" title="Evaluate several models together" note="Same dataset, same settings, real inference on the backend. Capture the dataset with the Condition grid preset so every water and light cell has frames.">
      {!p.online ? (
        <EmptyState title="Evaluation backend offline">
          Start it to test your own models (see <Link className="underline" href="/models">Model Lab</Link>). Until then this page runs on the simulated roster.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Dataset" htmlFor="batch-dataset">
            <select id="batch-dataset" className={inputCls} value={ds?.id ?? ""} onChange={(e) => setDsId(e.target.value)}>
              {(datasets.data?.datasets ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.n_frames} frames)
                </option>
              ))}
            </select>
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="label mb-1">Models</legend>
            {ready.length === 0 && (
              <p className="text-[12px] text-muted">
                No model is ready. Upload .pt or .onnx files in the <Link className="underline" href="/models">Model Lab</Link>.
              </p>
            )}
            {ready.map((m) => {
              const cov = ds ? coverage(suggestClassMap(modelClassNames(m), ds.classes), ds.classes) : null;
              return (
              <label key={m.id} className="flex items-center gap-2 text-[12px] text-text">
                <input type="checkbox" checked={picked.includes(m.id)} onChange={() => setPicked((s) => (s.includes(m.id) ? s.filter((x) => x !== m.id) : [...s, m.id]))} />
                {m.name} v{m.version}
                <span className="value text-[10px] text-dim">
                  {m.format} {m.inspection?.parameters ? `${(m.inspection.parameters / 1e6).toFixed(1)}M params` : ""}
                </span>
                {cov && <span className={cov.covered.length ? "text-[11px] text-dim" : "text-[11px] text-amber"}>{cov.covered.length ? `knows ${cov.covered.length} of ${ds!.classes.length} classes` : "none of its classes match this dataset"}</span>}
              </label>
              );
            })}
          </fieldset>
          <div>
            <button type="button" className="btn btn-primary" disabled={!picked.length || !ds || busy} onClick={start} data-testid="batch-run">
              Evaluate {picked.length || ""} {picked.length === 1 ? "model" : "models"}
            </button>
          </div>
          {error && <ErrorNote error={error} />}
          {running.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-[12px]">
              <StatusPill status={r.status} />
              <span className="text-text">{r.model.name}</span>
              <span className="value text-dim">
                {Math.round(r.progress * 100)}% {r.message}
              </span>
            </div>
          ))}
          {failed.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-[12px]">
              <StatusPill status={r.status} />
              <span className="text-text">{r.model.name}</span>
              <span className="text-muted">{r.error}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
