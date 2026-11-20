"use client";

import clsx from "clsx";
import { ArrowLeft, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, watchRun } from "@/lib/api/client";
import { useResource } from "@/lib/api/hooks";
import type { EngineeringReport } from "@/lib/api/types";
import { ConfidenceHistogramChart, ConfusionHeatmap } from "../charts/DistributionCharts";
import { ConfSweepChart, PRCurveChart } from "../charts/PRCharts";
import { SliceSensitivity } from "../charts/SliceCharts";
import { BackendDown, EmptyState, ErrorNote, fmtDate, PageShell, Panel, ProgressBar, Skeleton, SkeletonRows, StatusPill } from "../ui";
import { WorkspaceNav } from "../WorkspaceNav";
import { AskAssistant } from "./AskAssistant";
import { ReportExports, ReportGenerator, ReportView } from "./AiReport";
import { FailureAnalysis } from "./FailureAnalysis";
import { HardwarePanel, OverviewTiles, PerClassTable, RunHeader } from "./Overview";

const SECTIONS = [
  ["overview", "Overview"],
  ["curves", "Curves"],
  ["confusion", "Confusion"],
  ["sensitivity", "Sensitivity"],
  ["failures", "Failures"],
  ["hardware", "Hardware"],
  ["report", "AI report"],
  ["assistant", "Assistant"],
] as const;

export function RunReport({ runId, initialReportId = null }: { runId: string; initialReportId?: string | null }) {
  const health = useResource("health", (s) => api.health(s));
  const run = useResource(`run:${runId}`, (s) => api.getRun(runId, s));
  const complete = run.data?.status === "complete";
  const metrics = useResource(complete ? `metrics:${runId}` : null, (s) => api.getMetrics(runId, s));
  const reports = useResource(complete ? `reports:${runId}` : null, (s) => api.listReports(runId, s));
  const [reportSel, setReportSel] = useState<string | null>(initialReportId);
  const [created, setCreated] = useState<EngineeringReport | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);
  const [live, setLive] = useState<{ progress: number; message: string } | null>(null);

  const reportList = reports.data?.reports ?? [];
  const reportId = reportSel ?? reportList[0]?.id ?? null;
  const report = useResource(reportId && created?.id !== reportId ? `report:${reportId}` : null, (s) => api.getReport(reportId!, s));
  const currentReport = created && created.id === reportId ? created : (report.data ?? null);

  const status = run.data?.status;
  const reloadRun = run.reload;
  useEffect(() => {
    if (status !== "queued" && status !== "running") return;
    return watchRun(runId, {
      onUpdate: (u) => setLive({ progress: u.progress, message: u.message }),
      onDone: () => reloadRun(),
    });
  }, [status, runId, reloadRun]);

  const unreachable = health.error?.unreachable || run.error?.unreachable;
  if (unreachable) {
    return (
      <PageShell testId="run-report">
        <WorkspaceNav active={["analysis", "reports"]} />
        <main className="flex flex-1 items-center justify-center px-4 py-10">
          <BackendDown
            onRetry={() => {
              health.reload();
              run.reload();
            }}
            checking={health.refreshing || run.refreshing}
          />
        </main>
      </PageShell>
    );
  }

  const m = metrics.data;
  const r = run.data;

  return (
    <PageShell testId="run-report">
      <WorkspaceNav active={["analysis", "reports"]} />
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-6 py-5 max-[759px]:px-4 max-[479px]:px-2 max-[479px]:py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <Link href="/reports" className="label inline-flex items-center gap-1 hover:text-text">
              <ArrowLeft size={11} /> Workspaces 05 and 06
            </Link>
            <h1 className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[24px] font-medium leading-tight text-text max-[479px]:text-[19px]">
              <span>Performance analysis</span>
              <span className="value text-[15px] text-muted">{runId}</span>
              {r && <StatusPill status={r.status} />}
            </h1>
          </div>
          {currentReport && <ReportExports reportId={currentReport.id} />}
        </div>

        {complete && (
          <nav aria-label="Sections" className="sticky top-12 z-20 -mx-1 flex gap-1 overflow-x-auto border-b border-line bg-ground/95 px-1 py-1.5 [scrollbar-width:none]">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="whitespace-nowrap border border-transparent px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted hover:border-line-strong hover:text-text">
                {label}
              </a>
            ))}
          </nav>
        )}

        {run.loading ? (
          <div className="flex flex-col gap-4" role="status" aria-label="Loading run">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
            <div className="grid grid-cols-2 gap-4 max-[899px]:grid-cols-1">
              <Skeleton className="h-72" />
              <Skeleton className="h-72" />
            </div>
          </div>
        ) : run.error ? (
          <ErrorNote error={run.error} onRetry={run.reload} />
        ) : (
          r && (
            <>
              <Panel id="run" label="Run" title={`${r.model.name} v${r.model.version} on ${r.dataset.name}`}>
                <RunHeader run={r} metrics={m ?? null} />
              </Panel>

              {(r.status === "queued" || r.status === "running") && (
                <Panel title="Run in progress" testId="run-live">
                  <div className="flex flex-col gap-2">
                    <ProgressBar value={live?.progress ?? r.progress} label="Run progress" />
                    <span className="text-[12px] text-muted">{live?.message ?? r.message}</span>
                  </div>
                </Panel>
              )}
              {r.status === "failed" && (
                <Panel title="Run failed">
                  <p className="text-[13px] text-danger">{r.error ?? r.message}</p>
                  <p className="mt-2 text-[12px] text-muted">
                    Finished {fmtDate(r.finished_at)}. Start a new run from the{" "}
                    <Link href="/models" className="text-text underline decoration-line-strong underline-offset-2">
                      Model Lab
                    </Link>
                    .
                  </p>
                </Panel>
              )}

              {complete && metrics.error && <ErrorNote error={metrics.error} onRetry={metrics.reload} />}
              {complete && metrics.loading && <SkeletonRows rows={6} />}

              {m && (
                <>
                  <Panel id="overview" label="05 Performance analysis" title="Performance overview">
                    <OverviewTiles metrics={m} />
                  </Panel>

                  <div id="curves" className="grid scroll-mt-28 grid-cols-2 gap-4 max-[1099px]:grid-cols-1">
                    <Panel title="Precision-recall per class" note={`101-point interpolated, IoU ${m.pr.iou_threshold}. Click a legend entry to hide a class.`}>
                      <PRCurveChart pr={m.pr} classes={m.classes} />
                    </Panel>
                    <Panel title="Confidence threshold" note="Micro precision, recall and F1 across thresholds. Dot: F1-optimal threshold.">
                      <ConfSweepChart pr={m.pr} conf={m.conf_threshold} />
                    </Panel>
                  </div>

                  <div id="confusion" className="grid scroll-mt-28 grid-cols-[5fr_6fr] gap-4 max-[1099px]:grid-cols-1">
                    <Panel title="Confidence of true and false positives" note="Every prediction above the 0.001 inference floor, by confidence bin.">
                      <ConfidenceHistogramChart hist={m.confidence_histogram} conf={m.conf_threshold} />
                    </Panel>
                    <Panel title="Confusion matrix">
                      <ConfusionHeatmap cm={m.confusion_matrix} />
                    </Panel>
                  </div>

                  <Panel title="Per class" id="per-class">
                    <PerClassTable metrics={m} />
                  </Panel>

                  <Panel
                    id="sensitivity"
                    title="Environmental sensitivity"
                    note="Each condition bucket of the dataset, with its ground-truth support. Faded bars have too few objects to rank. BEST and WORST come from the backend ranking."
                  >
                    <SliceSensitivity slices={m.slices} ranking={m.slice_ranking} sensitivity={m.sensitivity} />
                  </Panel>

                  <Panel id="failures" title="Failure analysis" note="False negatives and false positives at the operating threshold, on the frames where they happened.">
                    <FailureAnalysis metrics={m} runId={runId} datasetId={r.dataset.id} />
                  </Panel>

                  <Panel id="hardware" title="Hardware suitability" note="Measured on this host, or estimated from a labelled throughput model. Estimates are never measurements.">
                    <HardwarePanel metrics={m} />
                  </Panel>

                  <Panel
                    id="report"
                    label="06 AI engineering report"
                    title="Engineering report"
                    right={
                      <>
                        {reportList.length > 1 && (
                          <select
                            aria-label="Report"
                            className="border border-line-strong bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-text"
                            value={reportId ?? ""}
                            onChange={(e) => {
                              setReportSel(e.target.value);
                              setShowGenerator(false);
                            }}
                          >
                            {reportList.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.id} · {x.provider}
                                {x.fallback ? " (fallback)" : ""} · {fmtDate(x.created_at)}
                              </option>
                            ))}
                          </select>
                        )}
                        {currentReport && (
                          <button type="button" className={clsx("btn inline-flex items-center gap-1.5 !py-1.5", showGenerator && "btn-active")} onClick={() => setShowGenerator((v) => !v)} aria-expanded={showGenerator}>
                            <Plus size={12} /> New report
                          </button>
                        )}
                      </>
                    }
                  >
                    <div className="flex flex-col gap-5">
                      {(showGenerator || (!reports.loading && !reportId)) && (
                        <div className={clsx(currentReport && "border border-line p-3")}>
                          <ReportGenerator
                            runId={runId}
                            health={health.data}
                            onCreated={(rep) => {
                              setCreated(rep);
                              setReportSel(rep.id);
                              setShowGenerator(false);
                              reports.reload();
                            }}
                          />
                        </div>
                      )}
                      {reports.error && <ErrorNote error={reports.error} onRetry={reports.reload} />}
                      {(reports.loading || (reportId && !currentReport && report.loading)) && <SkeletonRows rows={5} />}
                      {report.error && <ErrorNote error={report.error} onRetry={report.reload} />}
                      {currentReport && <ReportView report={currentReport} />}
                    </div>
                  </Panel>

                  <Panel id="assistant" title="Follow-up assistant" note="Answers use only the stored evidence of the selected report and state their uncertainty.">
                    {currentReport ? (
                      <AskAssistant key={currentReport.id} reportId={currentReport.id} />
                    ) : (
                      <EmptyState title="Generate a report first">The assistant answers from the evidence payload of a report.</EmptyState>
                    )}
                  </Panel>
                </>
              )}
            </>
          )
        )}
      </main>
    </PageShell>
  );
}
