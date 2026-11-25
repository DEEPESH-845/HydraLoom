"use client";

import { AlertTriangle, Info, RotateCcw } from "lucide-react";
import { useMemo } from "react";
import { useFieldStore } from "@/lib/field/store";
import { PRESETS, SITE_KEYS, SITE_SPEC, breakingHeight, checkConditions, defaultSite, effectiveEnv, freezingPoint, type SiteKey, type SiteParams } from "@/lib/field/site";
import { ENVIRONMENT_LIBRARY } from "@/lib/world/environments";
import { Btn, Section, SimTag, Slider } from "./ui";

const GROUPS = ["Water", "Particles", "Seabed and targets", "Sun and waves", "Turbid layer", "Camera"] as const;

const show = (k: SiteKey, v: number) => {
  if (k === "exposureS") return `1/${Math.round(1 / v)} s`;
  const s = SITE_SPEC[k];
  return `${v.toFixed(s.digits)}${s.unit ? ` ${s.unit}` : ""}`;
};

/** Named conditions of this place. Each starts from the environment's defaults, so presets never mix. */
export function Presets() {
  const envId = useFieldStore((s) => s.envId);
  const apply = (id: string | null) => {
    const st = useFieldStore.getState();
    st.resetConditions();
    const p = PRESETS[envId].find((x) => x.id === id);
    if (!p) return;
    st.setConditions({ turbidity: p.turbidity, lighting: p.lighting, lamps: p.lamps, current: p.current, site: p.site });
    st.setConditions({ altitudeM: st.engine.plannedAltitude() });
    st.reset();
  };
  return (
    <Section
      title="Conditions"
      right={
        <button type="button" onClick={() => apply(null)} className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-text" data-testid="conditions-default">
          <RotateCcw size={11} aria-hidden /> Defaults
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-1.5 min-[560px]:grid-cols-4" aria-label="Condition presets">
        {PRESETS[envId].map((p) => (
          <button key={p.id} type="button" onClick={() => apply(p.id)} data-preset={p.id} className="flex min-h-[46px] flex-col items-start border border-line px-2 py-1.5 text-left transition-colors duration-100 hover:border-teal">
            <span className="text-[12px] text-text">{p.name}</span>
            <span className="text-[10px] leading-tight text-dim">{p.note}</span>
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] text-dim">A preset restarts the run and plans the survey altitude for its water.</p>
    </Section>
  );
}

/** Every measured property of the place, grouped, with the limits that keep the set physically possible. */
export function SiteControls() {
  const envId = useFieldStore((s) => s.envId);
  const platformId = useFieldStore((s) => s.platformId);
  const site = useFieldStore((s) => s.conditions.site);
  const set = useFieldStore((s) => s.setConditions);
  const env = ENVIRONMENT_LIBRARY[envId];
  const base = useMemo(() => defaultSite(env, platformId), [env, platformId]);
  const limits = (k: SiteKey): [number, number] => {
    const s = SITE_SPEC[k];
    if (k === "waveHeightM") return [0, Math.max(0.1, Math.floor(Math.min(s.max, breakingHeight(site.wavePeriodS, env.geometry.terrain.depthM)) * 20) / 20)];
    if (k === "layerDepthM") return [0, Math.ceil(env.geometry.terrain.depthM)];
    if (k === "temperatureC") return [Math.max(s.min, Math.ceil(freezingPoint(site.salinityPsu) * 2) / 2), s.max];
    return [s.min, s.max];
  };
  return (
    <Section title="Site parameters" right={<SimTag />}>
      <div className="flex flex-col">
        {GROUPS.map((g) => {
          const keys = SITE_KEYS.filter((k) => SITE_SPEC[k].group === g && !(g === "Sun and waves" && k === "sunElevationDeg" && env.light.source === "lamp"));
          const changed = keys.filter((k) => Math.abs(site[k] - base[k]) > 1e-9);
          return (
            <details key={g} className="border-b border-line py-1.5 last:border-b-0" open={changed.length > 0 || undefined} data-group={g}>
              <summary className="flex cursor-pointer select-none items-center justify-between gap-2 text-[12px] text-text">
                <span>{g}</span>
                {changed.length > 0 && <span className="text-[10px] text-amber">{changed.length} changed</span>}
              </summary>
              <div className="mt-1 grid grid-cols-1 gap-x-6 min-[560px]:grid-cols-2">
                {keys.map((k) => {
                  const [lo, hi] = limits(k);
                  return <Slider key={k} testId={`site-${k}`} label={SITE_SPEC[k].label} hint={SITE_SPEC[k].effect} value={Math.min(hi, Math.max(lo, site[k]))} min={lo} max={hi} step={SITE_SPEC[k].step} onChange={(v) => set({ site: { [k]: v } as Partial<SiteParams> })} format={(v) => show(k, v)} />;
                })}
              </div>
              {changed.length > 0 && (
                <button type="button" className="mt-1 text-[11px] text-muted underline underline-offset-2 hover:text-text" onClick={() => set({ site: Object.fromEntries(keys.map((k) => [k, base[k]])) as Partial<SiteParams> })}>
                  Reset {g.toLowerCase()}
                </button>
              )}
            </details>
          );
        })}
      </div>
    </Section>
  );
}

/** What these conditions mean for the test, before running it. */
export function Checks() {
  const envId = useFieldStore((s) => s.envId);
  const platformId = useFieldStore((s) => s.platformId);
  const conditions = useFieldStore((s) => s.conditions);
  const issues = useMemo(() => checkConditions(effectiveEnv(ENVIRONMENT_LIBRARY[envId], conditions.site), conditions, platformId), [envId, conditions, platformId]);
  const planned = useFieldStore((s) => (s.engine.vehicle && s.conditions ? s.engine.plannedAltitude() : null));
  const off = planned !== null && Math.abs(planned - conditions.altitudeM) > 0.15;
  return (
    <Section title="Before you run">
      <ul className="flex flex-col gap-1.5" data-testid="checks">
        {issues.length === 0 && !off && <li className="text-[11px] text-muted">Nothing to flag: these conditions are inside the platform&apos;s envelope.</li>}
        {issues.map((i) => (
          <li key={i.text} className="flex items-start gap-2 text-[11px] leading-snug text-text">
            {i.level === "warn" ? <AlertTriangle size={13} className="mt-px shrink-0 text-amber" aria-label="Warning" /> : <Info size={13} className="mt-px shrink-0 text-muted" aria-label="Note" />}
            {i.text}
          </li>
        ))}
      </ul>
      {off && (
        <div className="mt-2">
          <Btn onClick={() => useFieldStore.getState().setConditions({ altitudeM: planned })}>Fly at {planned.toFixed(1)} m for this water</Btn>
        </div>
      )}
    </Section>
  );
}
