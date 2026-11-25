"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useFieldStore } from "@/lib/field/store";
import { waterDensity } from "@/lib/physics/seawater";
import { ENVIRONMENT_LIBRARY, ENVIRONMENT_ORDER, ntuAt } from "@/lib/world/environments";
import type { FieldEnvironmentId } from "@/lib/world/schema";
import { effectiveEnv } from "@/lib/field/site";
import { Checks, Presets, SiteControls } from "./SiteControls";
import { CardHead, Row, Section, SimTag, Slider, deg, f1, f2 } from "./ui";

const SHORT: Record<string, string> = {
  "gantry-lab": "Bench-top tank",
  harbor: "Quay, pilings, hull",
  river: "Bridge piers, strong flow",
  deepsea: "Abyssal, lamps only",
  reef: "Sunlit coral clutter",
  lake: "Fresh, stratified",
  ocean: "Wide shelf survey",
};

export function EnvironmentCard() {
  const envId = useFieldStore((s) => s.envId);
  const select = useFieldStore((s) => s.selectEnvironment);
  const env = ENVIRONMENT_LIBRARY[envId];
  return (
    <div>
      <CardHead index="01 Environment" title={env.name} note={env.purpose} right={<SimTag />} />
      <div className="grid grid-cols-2 gap-1.5 min-[560px]:grid-cols-4" aria-label="Environments">
        {ENVIRONMENT_ORDER.map((id) => {
          const e = ENVIRONMENT_LIBRARY[id];
          const on = id === envId;
          const cls = clsx("flex min-h-[54px] flex-col items-start border px-2 py-1.5 text-left transition-colors duration-100", on ? "border-teal bg-panel-2" : "border-line hover:border-teal");
          if (id === "gantry-lab")
            return (
              <Link key={id} href="/lab" prefetch={false} className={cls} title="The Gantry Lab is the bench-top tank with the XY gantry rig. It opens in its own page.">
                <span className="text-[12px] text-text">{e.name}</span>
                <span className="text-[10px] leading-tight text-dim">Bench-top rig, opens /lab</span>
              </Link>
            );
          return (
            <button key={id} type="button" aria-pressed={on} data-env={id} onClick={() => select(id as FieldEnvironmentId)} className={cls}>
              <span className={clsx("text-[12px]", on ? "text-teal" : "text-text")}>{e.name}</span>
              <span className="text-[10px] leading-tight text-dim">{SHORT[id]}</span>
            </button>
          );
        })}
      </div>
      <Presets />
      <WaterFacts />
      <Conditions />
      <CurrentControls />
      <SiteControls />
      <Checks />
      <details className="mt-3 border-t border-line pt-3">
        <summary className="label cursor-pointer select-none">Assumptions ({env.assumptions.length})</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-snug text-muted">
          {env.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function WaterFacts() {
  const envId = useFieldStore((s) => s.envId);
  const site = useFieldStore((s) => s.conditions.site);
  const env = effectiveEnv(ENVIRONMENT_LIBRARY[envId], site);
  const { turbidity, vis, density } = useFieldStore(useShallow((s) => ({ turbidity: s.conditions.turbidity, vis: s.telemetry.visibilityM, density: s.telemetry.densityKgM3 })));
  const ntu = ntuAt(env, turbidity);
  const rhoSurface = waterDensity({ temperatureC: env.water.temperatureC, salinityPsu: env.water.salinityPsu, depthM: 0 });
  const [lo, hi] = env.water.ntuRange;
  return (
    <Section title="Water" right={<SimTag />}>
      <div className="grid grid-cols-1 gap-x-6 min-[560px]:grid-cols-2">
        <Row k="Type" v={env.water.type === "sea" ? "Sea water" : env.water.type === "fresh" ? "Fresh water" : "Brackish"} />
        <Row k="Temperature" v={f1(env.water.temperatureC)} unit="°C" />
        <Row k="Salinity" v={f1(env.water.salinityPsu)} unit="PSU" />
        <Row k="Density surface / vehicle" v={`${f1(rhoSurface)} / ${f1(density)}`} unit="kg/m³" />
        <Row k={`Turbidity (range ${lo} to ${hi})`} v={f2(ntu)} unit="NTU" tone="teal" />
        <Row k="Visibility (2% contrast)" v={f1(vis)} unit="m" tone="teal" />
        <Row k="Light source" v={env.light.source === "lamp" ? "Vehicle lamps only" : "Daylight from the surface"} />
        <Row k="Depth (seabed / operating)" v={`${f1(env.geometry.terrain.depthM)} / ${f1(env.operatingDepthM)}`} unit="m" />
        {env.water.stratification && env.water.stratification.extraNtu > 0 && <Row k="Turbid layer" v={`${f1(env.water.stratification.depthM)} m, +${env.water.stratification.extraNtu} NTU`} />}
      </div>
    </Section>
  );
}

function Conditions() {
  const envId = useFieldStore((s) => s.envId);
  const env = ENVIRONMENT_LIBRARY[envId];
  const { turbidity, lighting } = useFieldStore(useShallow((s) => ({ turbidity: s.conditions.turbidity, lighting: s.conditions.lighting })));
  const set = useFieldStore((s) => s.setConditions);
  const thinning = useFieldStore((s) => s.overviewThinning);
  const setThinning = useFieldStore((s) => s.setOverviewThinning);
  return (
    <Section title="Turbidity and light">
      <div className="grid grid-cols-1 gap-x-6 min-[560px]:grid-cols-2">
        <Slider label="Turbidity" testId="turbidity" value={turbidity} min={0} max={1} step={0.01} onChange={(v) => set({ turbidity: v })} format={(v) => `${f2(v)} (${f2(ntuAt(env, v))} NTU)`} />
        <Slider label={env.light.label} testId="lighting" value={lighting} min={0} max={1} step={0.01} onChange={(v) => set({ lighting: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </div>
      <label className="mt-1 flex cursor-pointer items-center gap-2 text-[11px] text-muted">
        <input type="checkbox" checked={thinning} onChange={(e) => setThinning(e.target.checked)} className="accent-teal" />
        Thin the water in the main view so the whole site reads (the platform camera always sees true water)
      </label>
    </Section>
  );
}

function CurrentControls() {
  const c = useFieldStore(useShallow((s) => s.conditions.current));
  const set = useFieldStore((s) => s.setConditions);
  const showFlow = useFieldStore((s) => s.showFlow);
  const setShowFlow = useFieldStore((s) => s.setShowFlow);
  const setCur = (patch: Partial<typeof c>) => set({ current: patch });
  return (
    <Section
      title="Water current (not vehicle velocity)"
      right={
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
          <input type="checkbox" checked={showFlow} onChange={(e) => setShowFlow(e.target.checked)} className="accent-teal" />
          Show flow
        </label>
      }
    >
      <div className="flex flex-wrap items-start gap-4">
        <Dial value={c.headingDeg} onChange={(v) => setCur({ headingDeg: v })} />
        <div className="min-w-[200px] flex-1">
          <div className="flex items-center justify-between gap-2 py-1">
            <label htmlFor="current-dir" className="text-[11px] text-muted">
              Flows toward
            </label>
            <span className="flex items-center gap-1">
              <input
                id="current-dir"
                data-testid="current-dir"
                type="number"
                min={0}
                max={359}
                step={1}
                value={Math.round(c.headingDeg)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setCur({ headingDeg: ((v % 360) + 360) % 360 });
                }}
                className="value w-16 border border-line-strong bg-panel-2 px-1.5 py-0.5 text-right text-[12px] text-text"
              />
              <span className="text-[10px] text-dim">° true</span>
            </span>
          </div>
          <Slider label="Speed at reference height" testId="current-speed" value={c.speedMps} min={0} max={2} step={0.01} onChange={(v) => setCur({ speedMps: v })} format={(v) => `${f2(v)} m/s`} />
          <Slider label="Vertical (upwelling +)" value={c.verticalMps} min={-0.2} max={0.2} step={0.005} onChange={(v) => setCur({ verticalMps: v })} format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} m/s`} />
          <Slider label="Variability" value={c.variability} min={0} max={1} step={0.01} onChange={(v) => setCur({ variability: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Turbulence intensity" testId="current-turbulence" value={c.turbulence} min={0} max={0.5} step={0.01} onChange={(v) => setCur({ turbulence: v })} format={(v) => `${Math.round(v * 100)}%`} />
        </div>
      </div>
      <p className="mt-1 text-[10px] leading-snug text-dim">
        Direction is where the water flows toward ({deg(c.headingDeg)}), clockwise from north. Speed applies {f1(c.referenceHeightM)} m above the bed with a log-law boundary layer; the vehicle feels only its velocity relative to the water.
      </p>
    </Section>
  );
}

/** Draggable compass dial for the current direction. Keyboard: arrows turn 5 degrees (Shift 1). */
function Dial({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const fromEvent = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    onChange(Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360));
  };
  const a = (value * Math.PI) / 180;
  return (
    <svg
      ref={ref}
      viewBox="-50 -50 100 100"
      className="h-24 w-24 shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
      role="slider"
      tabIndex={0}
      aria-label="Current direction, degrees true"
      aria-valuemin={0}
      aria-valuemax={359}
      aria-valuenow={Math.round(value)}
      data-testid="current-dial"
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        fromEvent(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) fromEvent(e);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 1 : 5;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange((value + step) % 360);
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange((value - step + 360) % 360);
        else return;
        e.preventDefault();
      }}
    >
      <circle r="46" fill="var(--color-panel-2)" stroke="var(--color-line-strong)" />
      {Array.from({ length: 36 }, (_, i) => {
        const t = (i * 10 * Math.PI) / 180;
        const major = i % 9 === 0;
        return <line key={i} x1={Math.sin(t) * (major ? 36 : 40)} y1={-Math.cos(t) * (major ? 36 : 40)} x2={Math.sin(t) * 44} y2={-Math.cos(t) * 44} stroke="var(--color-line-strong)" strokeWidth={major ? 1.5 : 0.8} />;
      })}
      {(["N", "E", "S", "W"] as const).map((n, i) => (
        <text key={n} x={[0, 29, 0, -29][i]} y={[-25, 3.5, 32, 3.5][i]} textAnchor="middle" fontSize="9" fill="var(--color-muted)" fontFamily="var(--font-mono)">
          {n}
        </text>
      ))}
      <line x1={-Math.sin(a) * 18} y1={Math.cos(a) * 18} x2={Math.sin(a) * 30} y2={-Math.cos(a) * 30} stroke="var(--color-teal)" strokeWidth="2.5" />
      <polygon points={`${Math.sin(a) * 38},${-Math.cos(a) * 38} ${Math.sin(a + 0.35) * 27},${-Math.cos(a + 0.35) * 27} ${Math.sin(a - 0.35) * 27},${-Math.cos(a - 0.35) * 27}`} fill="var(--color-teal)" />
      <circle r="3" fill="var(--color-teal)" />
    </svg>
  );
}
