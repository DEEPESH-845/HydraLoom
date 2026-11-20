"use client";

import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api/client";
import { useResource } from "@/lib/api/hooks";
import type { RunRecord } from "@/lib/api/types";
import { EmptyState, fmt, fmtDate, ProgressBar, shortSha, StatusPill } from "./ui";

/** mAP50 is not on the run record; fetch it from the metrics of the newest complete runs. */
export function useRunMap50(runs: RunRecord[]) {
  const ids = runs
    .filter((r) => r.status === "complete" && r.metrics_available)
    .slice(0, 30)
    .map((r) => r.id);
  return useResource(ids.length ? `map50:${ids.join(",")}` : null, async (signal) => {
    const out: Record<string, number | null> = {};
    await Promise.all(
      ids.map(async (id) => {
        try {
          out[id] = (await api.getMetrics(id, signal)).overall.map50;
        } catch {
          out[id] = null;
        }
      }),
    );
    return out;
  });
}

export function RunsTable({
  runs,
  selected,
  onToggle,
  emptyHint,
}: {
  runs: RunRecord[];
  selected?: string[];
  onToggle?: (id: string) => void;
  emptyHint?: React.ReactNode;
}) {
  const map50 = useRunMap50(runs);
  if (!runs.length) return <EmptyState title="No runs yet">{emptyHint ?? "Start an evaluation to see it here."}</EmptyState>;
  const selectable = !!onToggle;
  return (
    <div className="relative overflow-x-auto" data-testid="runs-table">
      <table className="w-full min-w-[760px] text-[12px]">
        <thead>
          <tr className="border-b border-line text-left">
            {selectable && (
              <th scope="col" className="w-8 px-2 py-1.5">
                <span className="sr-only">Compare</span>
              </th>
            )}
            <th scope="col" className="label px-2 py-1.5 font-normal">
              Run
            </th>
            <th scope="col" className="label px-2 py-1.5 font-normal">
              Status
            </th>
            <th scope="col" className="label px-2 py-1.5 font-normal">
              Model
            </th>
            <th scope="col" className="label px-2 py-1.5 font-normal">
              Dataset
            </th>
            <th scope="col" className="label px-2 py-1.5 font-normal">
              Adapter
            </th>
            <th scope="col" className="label px-2 py-1.5 text-right font-normal">
              mAP50
            </th>
            <th scope="col" className="label px-2 py-1.5 font-normal">
              Created
            </th>
            <th scope="col" className="px-2 py-1.5">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const sel = selected?.includes(r.id) ?? false;
            const canSelect = r.status === "complete" && (sel || (selected?.length ?? 0) < 2);
            const live = r.status === "queued" || r.status === "running";
            return (
              <tr key={r.id} className={clsx("border-b border-line/60", sel && "bg-teal/5")} data-run-id={r.id}>
                {selectable && (
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      className="accent-teal"
                      checked={sel}
                      disabled={!canSelect}
                      onChange={() => onToggle!(r.id)}
                      aria-label={`Select ${r.id} for comparison`}
                      title={r.status !== "complete" ? "Only complete runs can be compared" : undefined}
                    />
                  </td>
                )}
                <td className="value px-2 py-1.5 text-text">{r.id}</td>
                <td className="px-2 py-1.5">
                  <div className="flex min-w-[96px] flex-col items-start gap-1">
                    <StatusPill status={r.status} />
                    {live && <ProgressBar value={r.progress} label={`Progress of ${r.id}`} />}
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <span className="text-text">{r.model.name}</span> <span className="value text-muted">v{r.model.version}</span>
                  <div className="value text-[10px] text-dim">{shortSha(r.model.sha256)}</div>
                </td>
                <td className="px-2 py-1.5 text-text">
                  {r.dataset.name}
                  <div className="value text-[10px] text-dim">{r.dataset.n_frames} frames</div>
                </td>
                <td className="px-2 py-1.5">
                  {r.mock ? <span className="sim-tag !border-danger/70 !text-danger">MOCK</span> : <span className="value text-muted">{r.adapter}</span>}
                </td>
                <td className="value px-2 py-1.5 text-right text-text">
                  {r.status !== "complete" ? <span className="text-dim">-</span> : map50.loading ? <span className="text-dim">...</span> : fmt(map50.data?.[r.id] ?? null)}
                </td>
                <td className="value whitespace-nowrap px-2 py-1.5 text-muted">{fmtDate(r.created_at)}</td>
                <td className="px-2 py-1.5 text-right">
                  {r.status === "complete" ? (
                    <Link href={`/reports/${r.id}`} className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.08em] text-teal hover:text-text">
                      Report <ArrowRight size={12} />
                    </Link>
                  ) : r.status === "failed" ? (
                    <span className="block max-w-[220px] truncate text-[11px] text-danger" title={r.error ?? ""}>
                      {r.error ?? "failed"}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
