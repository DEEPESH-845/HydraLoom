"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api/client";
import { useInterval, useResource } from "@/lib/api/hooks";
import { comparableGroups } from "@/lib/bench/compare";
import { SIMULATED_ROSTER, profileFromRun, type ModelProfile } from "@/lib/bench/profile";

export type Source = "measured" | "simulated";
const MAX_RUNS = 16;
const never = () => () => {};

/**
 * The models on the bench. Measured: the latest complete, non-mock run of each model on each dataset. Simulated: the
 * demonstration roster. Measured data is the default as soon as two models share a dataset.
 */
export function useProfiles() {
  // analysis and training run in the browser only: the server would spend CPU on numbers the client recomputes
  const mounted = useSyncExternalStore(never, () => true, () => false);
  const health = useResource("health", (s) => api.health(s));
  const online = !!health.data && !health.error;
  const runs = useResource(online ? "runs" : null, (s) => api.listRuns(s));
  const active = runs.data?.runs.some((r) => r.status === "queued" || r.status === "running") ?? false;
  useInterval(runs.reload, 2000, active);

  const latest = useMemo(() => {
    const seen = new Set<string>();
    return (runs.data?.runs ?? [])
      .filter((r) => r.status === "complete" && r.metrics_available && !r.mock)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .filter((r) => {
        const k = `${r.model.sha256}|${r.dataset.id}`;
        return seen.has(k) ? false : (seen.add(k), true);
      })
      .slice(0, MAX_RUNS);
  }, [runs.data]);
  const ids = latest.map((r) => r.id).join(",");
  const metrics = useResource(ids ? `bench-metrics:${ids}` : null, (s) => Promise.all(latest.map(async (r) => profileFromRun(r, await api.getMetrics(r.id, s)))));

  const groups = useMemo(() => comparableGroups(metrics.data ?? []), [metrics.data]);
  const [chosen, setChosen] = useState<Source | null>(null);
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const source: Source = chosen ?? ((groups[0]?.profiles.length ?? 0) >= 2 ? "measured" : "simulated");
  const group = groups.find((g) => g.datasetId === datasetId) ?? groups[0] ?? null;
  const profiles: ModelProfile[] = source === "simulated" ? SIMULATED_ROSTER : (group?.profiles ?? []);
  return { health, online, runs, active, groups, group, source, setSource: setChosen, setDatasetId, profiles, loading: !mounted || (online && (runs.loading || metrics.loading)), error: metrics.error ?? runs.error };
}

export type Profiles = ReturnType<typeof useProfiles>;
