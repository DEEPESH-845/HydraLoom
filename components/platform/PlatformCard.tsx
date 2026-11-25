"use client";

import clsx from "clsx";
import Link from "next/link";
import { useShallow } from "zustand/react/shallow";
import type { BallastMode } from "@/lib/field/engine";
import { useFieldStore } from "@/lib/field/store";
import { G } from "@/lib/physics/seawater";
import { PLATFORMS, PLATFORM_ORDER, compatibility } from "@/lib/platforms";
import { ENVIRONMENT_LIBRARY } from "@/lib/world/environments";
import { CardHead, Row, Section, Segmented, SimTag, Slider, f0, f1, f2 } from "./ui";

export function PlatformCard() {
  const envId = useFieldStore((s) => s.envId);
  const platformId = useFieldStore((s) => s.platformId);
  const select = useFieldStore((s) => s.selectPlatform);
  const env = ENVIRONMENT_LIBRARY[envId];
  const p = PLATFORMS[platformId];
  return (
    <div>
      <CardHead index="02 Platform" title={p.name} note={p.summary} right={<SimTag />} />
      <div className="grid grid-cols-2 gap-1.5 min-[560px]:grid-cols-4" aria-label="Platforms">
        {PLATFORM_ORDER.map((id) => {
          const d = PLATFORMS[id];
          const c = compatibility(env, id);
          const on = id === platformId;
          const cls = clsx("flex min-h-[54px] flex-col items-start border px-2 py-1.5 text-left transition-colors duration-100", on ? "border-teal bg-panel-2" : "border-line hover:border-teal");
          if (id === "gantry")
            return (
              <Link key={id} href="/lab" prefetch={false} className={cls} title="The gantry camera rig runs in the Gantry Lab, the bench-top tank.">
                <span className="text-[12px] text-text">{d.name}</span>
                <span className="text-[10px] leading-tight text-dim">Lab only, opens /lab</span>
              </Link>
            );
          return (
            <button
              key={id}
              type="button"
             
              data-platform={id}
              aria-pressed={on}
              aria-disabled={!c.ok}
              disabled={!c.ok}
              title={c.ok ? d.summary : c.reason}
              onClick={() => select(id)}
              className={clsx(cls, !c.ok && "cursor-not-allowed opacity-45 hover:border-line")}
            >
              <span className={clsx("text-[12px]", on ? "text-teal" : "text-text")}>{d.name}</span>
              <span className="text-[10px] leading-tight text-dim">{c.ok ? (d.fixed ? "Fixed, pan and tilt" : d.vehicle?.kind === "auv" ? "Flies lines, cannot hover" : "Holds station") : c.reason}</span>
            </button>
          );
        })}
      </div>
      <Facts />
      <Settings />
    </div>
  );
}

function Facts() {
  const platformId = useFieldStore((s) => s.platformId);
  const engine = useFieldStore((s) => s.engine);
  const { net, rho, ballast } = useFieldStore(useShallow((s) => ({ net: s.telemetry.netBuoyancyN, rho: s.telemetry.densityKgM3, ballast: s.conditions.ballast })));
  const p = PLATFORMS[platformId];
  const v = engine.params ?? p.vehicle;
  const cam = p.camera;
  return (
    <Section title="Specification" right={<SimTag>REPRESENTATIVE</SimTag>}>
      <div className="grid grid-cols-1 gap-x-6 min-[560px]:grid-cols-2">
        {v ? (
          <>
            <Row k="Mass (as ballasted)" v={f2(v.mass)} unit="kg" />
            <Row k="Displacement" v={`${f1(v.volume * 1000)} L, ${f2(v.volume * rho)} kg`} />
            <Row
              k="Net buoyancy in this water"
              v={`${net >= 0 ? "+" : ""}${f1(net)} N`}
              unit={net >= 0 ? "floats" : "sinks"}
              tone={net < -0.5 ? "danger" : "teal"}
              title="Buoyancy minus weight. Positive floats up with the thrusters off."
            />
            <Row k="Max thrust surge / heave / sway" v={`${f0(v.maxForce[0])} / ${f0(v.maxForce[1])} / ${f0(v.maxForce[2])}`} unit="N" />
            <Row k="Rated depth" v={f0(v.maxDepthM)} unit="m" />
            <Row k="Ballast trimmed for" v={f1(v.trimDensity)} unit="kg/m³" />
          </>
        ) : (
          <>
            <Row k="Mounting" v="Tripod on the seabed" />
            <Row k="Net buoyancy" v="n/a (fixed)" />
          </>
        )}
        <Row k="Camera" v={`${cam.width}x${cam.height}, ${cam.hfovDeg}° HFOV, ${cam.fps} FPS`} />
        <Row k="Camera tilt / exposure" v={`${cam.tiltDeg}° down, 1/${Math.round(1 / cam.exposureS)} s`} />
        <Row k="Lamps" v={p.lamps.count ? `${p.lamps.count} x, ${p.lamps.lumens} lm total, ${p.lamps.beamDeg}° beam` : "none"} />
        <Row k="Compute profile" v={p.compute} />
      </div>
      <p className="mt-1 text-[10px] leading-snug text-dim">Sensors: {p.sensors.join(", ")}.</p>
      {v && <p className="mt-1 text-[10px] leading-snug text-dim">Source: {v.source}. Weight in water {f1(v.mass * G)} N.</p>}
      {v && ballast !== "auto" && <p className="mt-1 text-[10px] text-dim">Ballast is fixed ({ballast}); the vehicle is not re-trimmed for this water.</p>}
    </Section>
  );
}

function Settings() {
  const envId = useFieldStore((s) => s.envId);
  const platformId = useFieldStore((s) => s.platformId);
  const env = ENVIRONMENT_LIBRARY[envId];
  const c = useFieldStore(useShallow((s) => ({ ballast: s.conditions.ballast, lamps: s.conditions.lamps, speed: s.conditions.speedMps, alt: s.conditions.altitudeM, threshold: s.conditions.threshold })));
  const set = useFieldStore((s) => s.setConditions);
  const p = PLATFORMS[platformId];
  const vehicle = !!p.vehicle;
  return (
    <Section title="Settings">
      {vehicle && (
        <div className="py-1">
          <div className="mb-1 text-[11px] text-muted">Ballast</div>
          <Segmented<BallastMode>
            label="Ballast mode"
            testId="ballast"
            value={c.ballast}
            onChange={(v) => set({ ballast: v })}
            options={[
              { id: "auto", label: "Auto (this water)" },
              { id: "sea", label: "Sea (1025)" },
              { id: "fresh", label: "Fresh (999)" },
            ]}
          />
          <p className="mt-1 text-[10px] leading-snug text-dim">
            Fresh water is about 2.6 percent less dense than sea water: a vehicle trimmed for the sea sinks in a lake or river unless it is re-ballasted, and one trimmed for fresh water floats hard in the sea.
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-x-6 min-[560px]:grid-cols-2">
        {env.light.source === "surface" ? (
          <Slider label="Lamp power" testId="lamps" value={c.lamps} min={0} max={1} step={0.01} onChange={(v) => set({ lamps: v })} format={(v) => `${Math.round(v * 100)}%`} />
        ) : (
          <p className="py-1 text-[11px] text-muted">Lamp power is the lighting control in 01 Environment: the lamps are the only light here.</p>
        )}
        {vehicle && <Slider label="Cruise speed through water" testId="cruise" value={c.speed} min={0.1} max={platformId === "auv" ? 2.2 : 1.0} step={0.05} onChange={(v) => set({ speedMps: v })} format={(v) => `${f2(v)} m/s`} />}
        {vehicle && <Slider label="Survey altitude" testId="altitude" value={c.alt} min={0.5} max={platformId === "auv" ? 12 : 6} step={0.1} onChange={(v) => set({ altitudeM: v })} format={(v) => `${f1(v)} m`} />}
        <Slider label="Detection threshold" value={c.threshold} min={0.3} max={0.95} step={0.01} onChange={(v) => set({ threshold: v })} format={(v) => `${Math.round(v * 100)}%`} hint="Analytical detector confidence needed to report a detection." />
      </div>
    </Section>
  );
}
