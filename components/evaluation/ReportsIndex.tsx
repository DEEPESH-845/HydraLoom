"use client";

import { ArrowRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, urls } from "@/lib/api/client";
import { useInterval, useResource } from "@/lib/api/hooks";
import type { RunRecord } from "@/lib/api/types";
import { CompareView } from "./CompareView";
import { environmentsOf } from "./DatasetPanel";
import { RunsTable } from "./RunsTable";
import { BackendDown, EmptyState, ErrorNote, fmtDate, inputCls, PageShell, Panel, shortSha, SkeletonRows } from "./ui";
import { WorkspaceNav } from "./WorkspaceNav";

function runLabel(r: RunRecord) {
  return `${r.id} · ${r.dataset.name}${r.mock ? " · MOCK" : ""} · ${fmtDate(r.created_at).slice(0, 16)}`;
}

export function ReportsIndex() {
  const health = useResource("health", (s) => api.health(s));
  const online = !!health.data;
  const runs = useResource(online ? "runs" : null, (s) => api.listRuns(s));
  const reports = useResource(online ? "reports" : null, (s) => api.listReports(undefined, s));
  const datasets = useResource(online ? "datasets" : null, (s) => api.listDatasets(s));
  const runList = useMemo(() => runs.data?.runs ?? [], [runs.data]);
  const runById = useMemo(() => new Map(runList.map((r) => [r.id, r])), [runList]);
  const dsById = useMemo(() => new Map((datasets.data?.datasets ?? []).map((d) => [d.id, d])), [datasets.data]);
  useInterval(runs.reload, 2000, runList.some((r) => r.status === "queued" || r.status === "running"));

  const complete = runList.filter((r) => r.status === "complete");
  const modelsWithRuns = useMemo(() => {
    const m = new Map<string, { id: string; label: string; n: number }>();
    for (const r of complete) {
      const e = m.get(r.model.id) ?? { id: r.model.id, label: `${r.model.name} v${r.model.version} (${shortSha(r.model.sha256, 8)})`, n: 0 };
      e.n++;
      m.set(r.model.id, e);
    }
    return [...m.values()];
  }, [complete]);

  const [envModel, setEnvModel] = useState<string>("");
  const modelId = envModel || modelsWithRuns[0]?.id || "";
  const modelRuns = complete.filter((r) => r.model.id === modelId);
  const [pick, setPick] = useState<{ a: string; b: string } | null>(null);
  const a = pick?.a && modelRuns.some((r) => r.id === pick.a) ? pick.a : (modelRuns[1]?.id ?? "");
  const b = pick?.b && modelRuns.some((r) => r.id === pick.b) ? pick.b : (modelRuns[0]?.id ?? "");
  const [compare, setCompare] = useState<[string, string] | null>(null);

  if (health.error?.unreachable) {
    return (
      <PageShell testId="reports-index">
        <WorkspaceNav active={["analysis", "reports"]} />
        <main className="flex flex-1 items-center justify-center px-4 py-10">
          <BackendDown onRetry={health.reload} checking={health.refreshing} />
        </main>
      </PageShell>
    );
  }

  const reportList = reports.data?.reports ?? [];

  return (
    <PageShell testId="reports-index">
      <WorkspaceNav active={["analysis", "reports"]} />
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-6 py-5 max-[759px]:px-4 max-[479px]:px-2 max-[479px]:py-3">
        <div>
          <div className="label">Workspaces 05 and 06</div>
          <h1 className="mt-1 text-[24px] font-medium leading-tight text-text max-[479px]:text-[20px]">Analysis and engineering reports</h1>
          <p className="mt-1 max-w-[80ch] text-[13px] leading-relaxed text-muted">
            Open a run for its full performance analysis, compare one model across environments, and read the AI engineering reports written over the metrics evidence.
          </p>
        </div>
        {health.error && <ErrorNote error={health.error} onRetry={health.reload} />}

        <Panel
          id="runs"
          label="05 Performance analysis"
          title="Evaluation runs"
          right={
            <button type="button" className="btn !px-2 !py-1.5" onClick={runs.reload} aria-label="Refresh runs" title="Refresh runs">
              <RefreshCw size={12} className={runs.refreshing ? "animate-spin" : undefined} />
            </button>
          }
        >
          {runs.loading || health.loading ? (
            <SkeletonRows rows={3} />
          ) : runs.error ? (
            <ErrorNote error={runs.error} onRetry={runs.reload} />
          ) : (
            <RunsTable
              runs={runList}
              emptyHint={
                <>
                  Runs are started in the{" "}
                  <Link href="/models" className="text-text underline decoration-line-strong underline-offset-2">
                    Model Lab
                  </Link>
                  .
                </>
              }
            />
          )}
        </Panel>

        <Panel
          id="environment-comparison"
          title="Environment comparison"
          note="Same model, different environments or datasets. Deltas are B - A from the backend compare endpoint; low-support slices are flagged."
        >
          {runs.loading || health.loading ? (
            <SkeletonRows rows={2} />
          ) : modelsWithRuns.length === 0 ? (
            <EmptyState title="Nothing to compare yet">Complete at least two runs of one model, ideally on datasets captured in different environments.</EmptyState>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-[1.2fr_1fr_1fr_auto] items-end gap-3 max-[899px]:grid-cols-1">
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="label">Model</span>
                  <select
                    className={inputCls}
                    value={modelId}
                    onChange={(e) => {
                      setEnvModel(e.target.value);
                      setPick(null);
                      setCompare(null);
                    }}
                  >
                    {modelsWithRuns.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} - {m.n} complete run{m.n === 1 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                </label>
                {(["a", "b"] as const).map((side) => (
                  <label key={side} className="flex min-w-0 flex-col gap-1">
                    <span className="label">Run {side.toUpperCase()}</span>
                    <select className={inputCls} value={side === "a" ? a : b} onChange={(e) => setPick({ a, b, [side]: e.target.value })} data-testid={`compare-${side}`}>
                      {modelRuns.map((r) => {
                        const envs = dsById.get(r.dataset.id) ? environmentsOf(dsById.get(r.dataset.id)!) : [];
                        return (
                          <option key={r.id} value={r.id}>
                            {runLabel(r)}
                            {envs.length ? ` · ${envs.join("/")}` : ""}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                ))}
                <button type="button" className="btn btn-primary" disabled={!a || !b || a === b} onClick={() => setCompare([a, b])} data-testid="env-compare">
                  Compare
                </button>
              </div>
              {modelRuns.length < 2 && <p className="text-[12px] text-muted">This model has one complete run. Run it on another dataset to compare environments.</p>}
              {a && b && a === b && <p className="text-[12px] text-muted">Pick two different runs.</p>}
              {compare && <CompareView a={compare[0]} b={compare[1]} />}
            </div>
          )}
        </Panel>

        <Panel id="engineering-reports" label="06 AI engineering reports" title="Reports">
          {reports.loading || health.loading ? (
            <SkeletonRows rows={3} />
          ) : reports.error ? (
            <ErrorNote error={reports.error} onRetry={reports.reload} />
          ) : !reportList.length ? (
            <EmptyState title="No reports yet">Open a complete run and generate an engineering report from its metrics.</EmptyState>
          ) : (
            <div className="relative overflow-x-auto" data-testid="reports-table">
              <table className="w-full min-w-[720px] text-[12px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    {["Report", "Run", "Model", "Provider", "Flags", "Created", ""].map((h, i) => (
                      <th key={i} scope="col" className="label px-2 py-1.5 font-normal">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reportList.map((rep) => {
                    const run = runById.get(rep.run_id);
                    return (
                      <tr key={rep.id} className="border-b border-line/60">
                        <td className="value px-2 py-1.5 text-text">{rep.id}</td>
                        <td className="value px-2 py-1.5 text-muted">{rep.run_id}</td>
                        <td className="px-2 py-1.5 text-text">{run ? `${run.model.name} v${run.model.version} on ${run.dataset.name}` : <span className="text-dim">run not listed</span>}</td>
                        <td className="value px-2 py-1.5 text-muted">{rep.provider}</td>
                        <td className="px-2 py-1.5">
                          <span className="flex gap-1">
                            {rep.mock && <span className="sim-tag !border-danger/70 !text-danger">MOCK</span>}
                            {rep.fallback && <span className="sim-tag !border-amber/70 !text-amber">FALLBACK</span>}
                            {!rep.mock && !rep.fallback && <span className="text-dim">-</span>}
                          </span>
                        </td>
                        <td className="value whitespace-nowrap px-2 py-1.5 text-muted">{fmtDate(rep.created_at)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right">
                          <a href={urls.reportHtml(rep.id)} target="_blank" rel="noreferrer" className="mr-3 font-mono text-[11px] uppercase tracking-[0.08em] text-muted hover:text-text">
                            HTML
                          </a>
                          <Link href={`/reports/${rep.run_id}?report=${rep.id}#report`} className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.08em] text-teal hover:text-text">
                            Open <ArrowRight size={12} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </main>
    </PageShell>
  );
}
