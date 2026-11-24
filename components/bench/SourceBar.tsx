"use client";

import { inputCls } from "@/components/evaluation/ui";
import { Seg } from "./charts";
import type { Profiles } from "./useProfiles";

/** Where the numbers come from. Simulated numbers are never shown without saying so. */
export function SourceBar({ p }: { p: Profiles }) {
  const n = p.groups.reduce((s, g) => s + g.profiles.length, 0);
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="source-bar">
      <Seg
        label="Model source"
        value={p.source}
        onChange={p.setSource}
        options={[
          { id: "measured", label: `Measured (${n})`, disabled: n === 0, title: n ? "Completed evaluation runs" : p.online ? "No completed runs yet: evaluate models below" : "The evaluation backend is not running" },
          { id: "simulated", label: "Simulated roster" },
        ]}
      />
      {p.source === "measured" && p.groups.length > 1 && (
        <select aria-label="Dataset" className={`${inputCls} !w-auto`} value={p.group?.datasetId ?? ""} onChange={(e) => p.setDatasetId(e.target.value)}>
          {p.groups.map((g) => (
            <option key={g.datasetId} value={g.datasetId}>
              {g.datasetName} ({g.profiles.length} models)
            </option>
          ))}
        </select>
      )}
      <span className={`sim-tag ${p.source === "simulated" ? "!border-danger/70 !text-danger" : "!border-teal/70 !text-teal"}`}>{p.source === "simulated" ? "SIMULATED - NOT REAL MODELS" : "MEASURED ON THE BACKEND"}</span>
      {p.source === "simulated" && <span className="text-[12px] text-muted">{p.online ? "Four archetypes to demonstrate the analysis. Evaluate your own models below to replace them." : "The evaluation backend is offline, so the demonstration roster is shown."}</span>}
    </div>
  );
}
