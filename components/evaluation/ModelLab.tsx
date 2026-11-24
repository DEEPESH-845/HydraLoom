"use client";

import { GitCompareArrows, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { readLocal, useInterval, useResource, writeLocal } from "@/lib/api/hooks";
import type { ModelRecord } from "@/lib/api/types";
import { ClassMapEditor, suggestClassMap, type ClassMap } from "./ClassMapEditor";
import { CompareView } from "./CompareView";
import { DatasetDetailView, DatasetPicker } from "./DatasetPanel";
import { HealthBanner } from "./HealthBanner";
import { ModelDetail, ModelList } from "./ModelRegistry";
import { ModelUpload } from "./ModelUpload";
import { DEFAULT_SETTINGS, InferenceConfigForm, RunLauncher, settingsErrors, type InferenceSettings } from "./RunLauncher";
import { RunsTable } from "./RunsTable";
import { BackendDown, ErrorNote, PageShell, Panel, Skeleton, SkeletonRows } from "./ui";
import { WorkspaceNav } from "./WorkspaceNav";

const LS_MODEL = "gantrylab.models.selectedModel";
const LS_DATASET = "gantrylab.models.selectedDataset";

export function modelClassNames(m: ModelRecord | null): string[] {
  const names = m?.inspection?.names ?? {};
  return Object.keys(names)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => names[k]);
}

export function ModelLab() {
  const health = useResource("health", (s) => api.health(s));
  const online = !!health.data && !health.error;
  const profiles = useResource(online ? "profiles" : null, (s) => api.computeProfiles(s));
  const models = useResource(online ? "models" : null, (s) => api.listModels(s));
  const datasets = useResource(online ? "datasets" : null, (s) => api.listDatasets(s));
  const runs = useResource(online ? "runs" : null, (s) => api.listRuns(s));

  const [modelSel, setModelSel] = useState<string | null>(() => (typeof window === "undefined" ? null : readLocal(LS_MODEL)));
  const [datasetSel, setDatasetSel] = useState<string | null>(() => (typeof window === "undefined" ? null : readLocal(LS_DATASET)));
  const [settings, setSettings] = useState<InferenceSettings>(DEFAULT_SETTINGS);
  const [mapState, setMapState] = useState<{ key: string; map: ClassMap } | null>(null);
  const [compareSel, setCompareSel] = useState<string[]>([]);
  const [comparePair, setComparePair] = useState<[string, string] | null>(null);

  const modelList = models.data?.models ?? [];
  const datasetList = datasets.data?.datasets ?? [];
  const runList = runs.data?.runs ?? [];
  const model = modelList.find((m) => m.id === modelSel) ?? modelList[0] ?? null;
  const dataset = datasetList.find((d) => d.id === datasetSel) ?? datasetList[0] ?? null;

  const modelClasses = useMemo(() => modelClassNames(model), [model]);
  const mapKey = `${model?.id ?? ""}|${dataset?.id ?? ""}`;
  const suggested = useMemo(() => suggestClassMap(modelClasses, dataset?.classes ?? []), [modelClasses, dataset]);
  const classMap = mapState?.key === mapKey ? mapState.map : suggested;

  // keep pending inspections and active runs fresh
  useInterval(models.reload, 1500, modelList.some((m) => m.status === "pending"));
  useInterval(runs.reload, 2000, runList.some((r) => r.status === "queued" || r.status === "running"));

  const selectModel = (id: string) => {
    setModelSel(id);
    writeLocal(LS_MODEL, id);
  };
  const selectDataset = (id: string) => {
    setDatasetSel(id);
    writeLocal(LS_DATASET, id);
  };

  if (health.error?.unreachable) {
    return (
      <PageShell testId="model-lab">
        <WorkspaceNav active="models" />
        <main className="flex flex-1 items-center justify-center px-4 py-10">
          <BackendDown onRetry={health.reload} checking={health.refreshing} />
        </main>
      </PageShell>
    );
  }

  const mock = settings.adapter === "mock";
  const blockers: string[] = [];
  if (!model) blockers.push("Upload or select a model");
  else if (model.status === "rejected") blockers.push("The selected model was rejected by inspection");
  else if (!mock && model.status !== "ready") blockers.push("Wait for inspection to finish (real adapters need a ready model)");
  if (!dataset) blockers.push("Capture a dataset in the 3D twin first");
  blockers.push(...settingsErrors(settings));

  return (
    <PageShell testId="model-lab">
      <WorkspaceNav active="models" />
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-6 py-5 max-[759px]:px-4 max-[479px]:px-2 max-[479px]:py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="label">Workspace 04</div>
            <h1 className="mt-1 text-[24px] font-medium leading-tight text-text max-[479px]:text-[20px]">Model Laboratory</h1>
            <p className="mt-1 max-w-[80ch] text-[13px] leading-relaxed text-muted">
              Evaluate a trained detector against synthetic ground truth captured from the digital twin. Every number comes from the backend metrics engine.
            </p>
          </div>
        </div>

        {health.loading ? (
          <Skeleton className="h-11 w-full" />
        ) : health.error ? (
          <ErrorNote error={health.error} onRetry={health.reload} />
        ) : (
          <HealthBanner health={health.data!} />
        )}

        <div className="grid grid-cols-[minmax(340px,5fr)_7fr] items-start gap-4 max-[1099px]:grid-cols-1">
          <div className="flex min-w-0 flex-col gap-4">
            <Panel id="upload" label="Step 1" title="Upload model">
              <ModelUpload
                maxMb={Number(health.data?.limits.max_model_mb ?? 512)}
                onChange={(m) => {
                  selectModel(m.id);
                  models.reload();
                }}
              />
            </Panel>
            <Panel
              id="models"
              label="Registry"
              title="Models"
              right={
                <button type="button" className="btn !px-2 !py-1" onClick={models.reload} aria-label="Refresh models" title="Refresh models">
                  <RefreshCw size={12} className={models.refreshing ? "animate-spin" : undefined} />
                </button>
              }
            >
              {models.loading ? (
                <SkeletonRows rows={3} />
              ) : models.error ? (
                <ErrorNote error={models.error} onRetry={models.reload} />
              ) : (
                <div className="flex flex-col gap-4">
                  <ModelList models={modelList} selectedId={model?.id ?? null} onSelect={selectModel} />
                  {model && (
                    <div className="border-t border-line pt-4">
                      <ModelDetail model={model} />
                    </div>
                  )}
                </div>
              )}
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Panel id="dataset" label="Step 2" title="Dataset" note="Synthetic frames with geometric ground truth, captured from the 3D twin.">
              {datasets.loading ? (
                <SkeletonRows rows={2} />
              ) : datasets.error ? (
                <ErrorNote error={datasets.error} onRetry={datasets.reload} />
              ) : (
                <div className="flex flex-col gap-4">
                  <DatasetPicker datasets={datasetList} selectedId={dataset?.id ?? null} onSelect={selectDataset} />
                  {dataset && (
                    <div className="border-t border-line pt-4">
                      <DatasetDetailView dataset={dataset} />
                    </div>
                  )}
                </div>
              )}
            </Panel>

            <Panel
              id="mapping"
              label="Step 3"
              title="Class mapping"
              note="Map each model class to a ground-truth class or ignore it. Exact and case-insensitive matches are suggested."
            >
              {!model || !dataset ? (
                <p className="text-[12px] text-muted">Select a model and a dataset to map classes.</p>
              ) : mock ? (
                <ClassMapEditor
                  modelClasses={modelClasses}
                  datasetClasses={dataset.classes}
                  value={classMap}
                  onChange={() => {}}
                  disabledReason="The mock adapter predicts the dataset classes directly, so no model class mapping is applied to mock runs."
                />
              ) : !modelClasses.length ? (
                <p className="text-[12px] text-muted">{model.status === "pending" ? "Class names appear once inspection finishes." : "This model reports no class names."}</p>
              ) : (
                <ClassMapEditor modelClasses={modelClasses} datasetClasses={dataset.classes} value={classMap} onChange={(m) => setMapState({ key: mapKey, map: m })} />
              )}
            </Panel>

            <Panel id="inference" label="Step 4" title="Inference and run">
              {health.data && (
                <div className="flex flex-col gap-4">
                  <InferenceConfigForm value={settings} onChange={setSettings} health={health.data} profiles={profiles.data?.profiles ?? []} model={model} />
                  {profiles.error && <ErrorNote error={profiles.error} onRetry={profiles.reload} />}
                  <div className="border-t border-line pt-4">
                    <RunLauncher
                      model={model}
                      dataset={dataset}
                      settings={settings}
                      classMap={classMap}
                      blockers={blockers}
                      onStarted={runs.reload}
                      onFinished={runs.reload}
                    />
                  </div>
                </div>
              )}
            </Panel>
          </div>
        </div>

        <Panel
          id="runs"
          label="History"
          title="Runs"
          note="Select two complete runs to compare models or environments side by side."
          right={
            <>
              <button
                type="button"
                className="btn inline-flex items-center gap-1.5 !py-1.5"
                disabled={compareSel.length !== 2}
                onClick={() => setComparePair([compareSel[0], compareSel[1]])}
                data-testid="compare-button"
              >
                <GitCompareArrows size={13} /> Compare {compareSel.length}/2
              </button>
              <button type="button" className="btn !px-2 !py-1.5" onClick={runs.reload} aria-label="Refresh runs" title="Refresh runs">
                <RefreshCw size={12} className={runs.refreshing ? "animate-spin" : undefined} />
              </button>
            </>
          }
        >
          {runs.loading ? (
            <SkeletonRows rows={3} />
          ) : runs.error ? (
            <ErrorNote error={runs.error} onRetry={runs.reload} />
          ) : (
            <RunsTable
              runs={runList}
              selected={compareSel}
              onToggle={(id) => setCompareSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)))}
            />
          )}
          {comparePair && (
            <div className="mt-5 border-t border-line pt-4">
              <CompareView a={comparePair[0]} b={comparePair[1]} />
            </div>
          )}
        </Panel>
      </main>
    </PageShell>
  );
}
