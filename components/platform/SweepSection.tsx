"use client";

import { useRef, useState } from "react";
import { LineChart, download } from "@/components/bench/charts";
import { SWEEP_PARAMS, envelope, runSweep, sweepValues, type SweepParam, type SweepRow } from "@/lib/field/sweep";
import { useFieldStore } from "@/lib/field/store";
import { MISSIONS } from "@/lib/missions";
import { Btn, Section, SimTag } from "./ui";

const inputCls = "value w-full border border-line-strong bg-panel-2 px-1.5 py-1 text-[12px] text-text";
const fmt = (p: SweepParam, v: number) => (p.id === "site.exposureS" ? `1/${Math.round(1 / v)} s` : `${v.toFixed(Math.max(2, p.digits))}${p.unit ? ` ${p.unit}` : ""}`);

/** Same mission, one parameter varied: where the platform stops finding and classifying its targets. */
export function SweepSection() {
  const env = useFieldStore((s) => s.envId);
  const platform = useFieldStore((s) => s.platformId);
  const missionId = useFieldStore((s) => s.mission);
  const [id, setId] = useState("turbidity");
  const p = SWEEP_PARAMS.find((x) => x.id === id)!;
  const [lo, setLo] = useState(String(p.min));
  const [hi, setHi] = useState(String(p.max));
  const [steps, setSteps] = useState(7);
  const [seeds, setSeeds] = useState(1);
  const [replan, setReplan] = useState(true);
  const [state, setState] = useState<{ param: SweepParam; rows: SweepRow[]; total: number; running: boolean; label: string; error: string | null } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const a = Number(lo);
  const b = Number(hi);
  const valid = lo.trim() !== "" && hi.trim() !== "" && Number.isFinite(a) && Number.isFinite(b) && a !== b && [a, b].every((v) => v >= p.min - 1e-9 && v <= p.max + 1e-9);
  const choose = (next: string) => {
    const q = SWEEP_PARAMS.find((x) => x.id === next)!;
    setId(next);
    setLo(String(q.min));
    setHi(String(q.max));
  };
  const run = async () => {
    const s = useFieldStore.getState();
    const values = sweepValues(a, b, steps, p.digits + (p.id === "site.exposureS" ? 2 : 0));
    abort.current = new AbortController();
    const label = `${s.engine.env.name}, ${s.engine.platform.name}, ${MISSIONS[s.mission].name}`;
    setState({ param: p, rows: [], total: values.length, running: true, label, error: null });
    try {
      await runSweep({ env: s.envId, platform: s.platformId, mission: s.mission, base: s.conditions, param: p, values, seeds, replan }, (r) => setState((x) => x && { ...x, rows: [...x.rows, r] }), abort.current.signal);
      setState((x) => x && { ...x, running: false });
    } catch (e) {
      setState((x) => x && { ...x, running: false, error: (e as Error).name === "AbortError" ? null : (e as Error).message });
    }
  };
  const rows = state?.rows ?? [];
  const total = rows[0]?.total ?? 1;
  return (
    <Section title="Sensitivity test" right={<SimTag>ANALYTICAL</SimTag>}>
      <p className="mb-2 text-[11px] leading-snug text-muted">
        Repeats {MISSIONS[missionId].name.toLowerCase()} in {env} with the {platform.toUpperCase()}, changing one parameter and holding the rest. Runs beside the live simulation.
      </p>
      <div className="grid grid-cols-2 gap-2 min-[560px]:grid-cols-4">
        <label className="col-span-2 flex flex-col gap-0.5 text-[10px] text-muted">
          Parameter
          <select className={inputCls} value={id} onChange={(e) => choose(e.target.value)} disabled={state?.running} data-testid="sweep-param">
            {SWEEP_PARAMS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
                {x.unit ? ` (${x.unit})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-muted">
          From
          <input className={inputCls} value={lo} onChange={(e) => setLo(e.target.value)} inputMode="decimal" aria-invalid={!valid} data-testid="sweep-lo" />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-muted">
          To
          <input className={inputCls} value={hi} onChange={(e) => setHi(e.target.value)} inputMode="decimal" aria-invalid={!valid} data-testid="sweep-hi" />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-muted">
          Steps
          <input className={inputCls} type="number" min={3} max={15} value={steps} onChange={(e) => setSteps(Math.min(15, Math.max(3, Math.round(Number(e.target.value) || 3))))} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] text-muted">
          Seeds per step
          <input className={inputCls} type="number" min={1} max={5} value={seeds} onChange={(e) => setSeeds(Math.min(5, Math.max(1, Math.round(Number(e.target.value) || 1))))} />
        </label>
        <label className="col-span-2 flex items-end gap-2 pb-1 text-[11px] text-muted">
          <input type="checkbox" checked={replan} onChange={(e) => setReplan(e.target.checked)} className="accent-teal" />
          Re-plan the altitude at every step
        </label>
      </div>
      {!valid && (
        <p className="mt-1 text-[11px] text-danger" role="alert">
          Use two different values between {p.min} and {p.max}.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {state?.running ? (
          <Btn onClick={() => abort.current?.abort()}>Cancel</Btn>
        ) : (
          <Btn primary onClick={run} disabled={!valid}>
            Run test
          </Btn>
        )}
        {rows.length > 0 && !state?.running && <Btn onClick={() => download(`sensitivity-${env}-${state!.param.id}.csv`, ["value,ntu,visibility_m,altitude_m,found,classified,total,wreck_rate,mean_confidence,contacts,duration_s,finished", ...rows.map((r) => [r.value, r.ntu, r.visibilityM, r.altitudeM, r.found, r.classified, r.total, r.wreck, r.meanConfidence, r.contacts, r.durationS, r.finished].map((v) => Number(v.toFixed(4))).join(","))].join("\n") + "\n", "text/csv")}>CSV</Btn>}
        {state?.running && (
          <span className="value text-[11px] text-muted" role="status">
            {rows.length} of {state.total}
          </span>
        )}
      </div>
      {state?.error && <p className="mt-1 text-[11px] text-danger">{state.error}</p>}
      {rows.length > 1 && state && (
        <div className="mt-3" data-testid="sweep-result">
          <p className="mb-2 text-[12px] leading-snug text-text">{envelope(rows).text((v) => fmt(state.param, v))}</p>
          <LineChart
            label={`Targets against ${state.param.label}`}
            xLabel={`${state.param.label}${state.param.unit ? `, ${state.param.unit}` : ""}`}
            yLabel="share of targets"
            yRange={[0, 1]}
            height={190}
            series={[
              { name: "Classified", color: "#3987e5", points: rows.map((r) => [r.value, r.classified / total]) },
              { name: "Found", color: "#d95926", points: rows.map((r) => [r.value, r.found / total]) },
              { name: "Mean confidence", color: "#199e70", points: rows.map((r) => [r.value, r.meanConfidence]) },
            ]}
          />
          <p className="mt-1 text-[10px] text-dim">
            {state.label}. {rows.some((r) => r.contacts > 0) ? `Contacts in ${rows.filter((r) => r.contacts > 0).length} of ${rows.length} steps. ` : ""}
            {rows.some((r) => r.finished < 1) ? "Some runs hit the time limit. " : ""}Altitude {Math.min(...rows.map((r) => r.altitudeM)).toFixed(1)} to {Math.max(...rows.map((r) => r.altitudeM)).toFixed(1)} m.
          </p>
        </div>
      )}
    </Section>
  );
}
