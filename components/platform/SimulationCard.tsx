"use client";

import clsx from "clsx";
import { HelpCircle, Pause, Play, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { MISSIONS, type MissionId } from "@/lib/missions";
import type { PilotMode, Stick } from "@/lib/physics/autopilot";
import { useFieldStore, type ViewMode } from "@/lib/field/store";
import { ENVIRONMENT_LIBRARY } from "@/lib/world/environments";
import { Bar, Btn, CardHead, Row, Section, Segmented, SimTag, deg, f1, f2 } from "./ui";

export const VIEWS: { id: ViewMode; label: string; title: string }[] = [
  { id: "overview", label: "Overview", title: "Orbit around the whole site" },
  { id: "follow", label: "Follow", title: "Chase camera behind the platform" },
  { id: "pilot", label: "Pilot", title: "Through the platform camera, true water" },
  { id: "free", label: "Free", title: "Orbit, pan and zoom; double-click to focus a point" },
];

/** Takes manual control (switching the pilot to MANUAL first) and sets the stick. */
export function drive(stick: Partial<Stick>) {
  const s = useFieldStore.getState();
  if (!s.engine.vehicle) return;
  if (s.engine.pilotTarget.mode !== "MANUAL") s.setPilotMode("MANUAL");
  s.setStick(stick);
}

export function SimulationCard() {
  const { paused, timeScale, phase, mission, envId, platformId, mode } = useFieldStore(
    useShallow((s) => ({ paused: s.paused, timeScale: s.timeScale, phase: s.phase, mission: s.mission, envId: s.envId, platformId: s.platformId, mode: s.telemetry.pilot.mode })),
  );
  const view = useFieldStore((s) => s.view);
  const st = useFieldStore.getState();
  const env = ENVIRONMENT_LIBRARY[envId];
  const missions = env.missions.filter((m) => MISSIONS[m as MissionId]?.platforms.includes(platformId)) as MissionId[];
  const station = platformId === "station";
  return (
    <div>
      <CardHead index="03 Simulation" title="Simulation control" note={MISSIONS[mission]?.objective} right={<SimTag />} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn onClick={() => st.setPaused(!paused)} active={!paused} ariaLabel={paused ? "Play" : "Pause"} title={paused ? "Play (Space)" : "Pause (Space)"}>
          {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Play" : "Pause"}
        </Btn>
        <label className="flex items-center gap-1.5 text-[11px] text-muted">
          Time
          <select
            value={timeScale}
            onChange={(e) => st.setTimeScale(Number(e.target.value))}
            className="value border border-line-strong bg-panel-2 px-1.5 py-1 text-[12px] text-text"
            aria-label="Time scale"
            data-testid="time-scale"
          >
            {[0.25, 0.5, 1, 2, 4, 8].map((v) => (
              <option key={v} value={v}>
                {v}x
              </option>
            ))}
          </select>
        </label>
        <Btn onClick={() => st.reset()} title="Reset the run (keeps the environment and platform)">
          <RotateCcw size={14} /> Reset
        </Btn>
      </div>
      <Section title="View">
        <Segmented<ViewMode> label="View" testId="view" value={view} onChange={(v) => st.setView(v)} options={VIEWS.map((v) => ({ id: v.id, label: v.label, title: v.title }))} />
      </Section>
      <Section title="Mission" right={<span className={clsx("label", phase === "RUNNING" ? "text-teal" : "text-dim")}>{phase}</span>}>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={mission}
            onChange={(e) => st.setMission(e.target.value as MissionId)}
            disabled={phase === "RUNNING"}
            className="border border-line-strong bg-panel-2 px-2 py-1.5 text-[12px] text-text"
            aria-label="Mission"
            data-testid="mission"
          >
            {missions.map((m) => (
              <option key={m} value={m}>
                {MISSIONS[m].name}
              </option>
            ))}
          </select>
          {phase === "RUNNING" ? (
            <Btn onClick={() => st.abortMission()}>
              <Square size={13} /> Abort
            </Btn>
          ) : (
            <Btn primary onClick={() => st.startMission()}>
              <Play size={13} /> Start mission
            </Btn>
          )}
        </div>
        <p className="mt-1 text-[10px] text-dim">Guidance is a hand-tuned PID and line-of-sight autopilot, not a trained policy.</p>
      </Section>
      {station ? <StationControls /> : <PilotControls mode={mode} />}
      <TelemetryGrid />
    </div>
  );
}

function PilotControls({ mode }: { mode: PilotMode }) {
  const st = useFieldStore.getState();
  const [help, setHelp] = useState(false);
  const pad = (label: string, stick: Partial<Stick>, aria: string) => (
    <button
      type="button"
      aria-label={aria}
      className="btn h-9 w-12 select-none px-0 py-0 text-[11px] touch-none"
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drive(stick);
      }}
      onPointerUp={() => drive(Object.fromEntries(Object.keys(stick).map((k) => [k, 0])))}
      onPointerCancel={() => drive(Object.fromEntries(Object.keys(stick).map((k) => [k, 0])))}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          drive(stick);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") drive(Object.fromEntries(Object.keys(stick).map((k) => [k, 0])));
      }}
    >
      {label}
    </button>
  );
  return (
    <Section
      title="Pilot"
      right={
        <span className="relative">
          <button type="button" className="flex items-center gap-1 text-[11px] text-muted hover:text-text" aria-expanded={help} onClick={() => setHelp(!help)}>
            <HelpCircle size={13} /> Keys
          </button>
          {help && (
            <div role="dialog" aria-label="Keyboard controls" className="panel absolute right-0 top-6 z-10 w-64 p-3 text-[11px] leading-relaxed text-muted">
              <div className="label mb-1 text-text">Manual control</div>
              <div className="value">W / S surge forward / back</div>
              <div className="value">A / D yaw port / starboard</div>
              <div className="value">Q / E sway port / starboard</div>
              <div className="value">R / F heave up / down</div>
              <div className="value">Space pause / play</div>
              <p className="mt-1">Keys work when no text field has focus. Taking manual control switches the pilot to MANUAL and ends a running mission.</p>
              <button type="button" className="btn mt-2" onClick={() => setHelp(false)}>
                Close
              </button>
            </div>
          )}
        </span>
      }
    >
      <Segmented<PilotMode>
        label="Pilot mode"
        testId="pilot-mode"
        value={mode}
        onChange={(m) => st.setPilotMode(m)}
        options={[
          { id: "MANUAL", label: "Manual" },
          { id: "HOLD", label: "Hold" },
          { id: "WAYPOINTS", label: "Waypoints", disabled: mode !== "WAYPOINTS", title: "Start a mission to fly waypoints" },
        ]}
      />
      <div className="mt-2 flex flex-wrap items-center gap-4">
        <div className="grid grid-cols-3 gap-1" aria-label="Surge and yaw pad">
          <span />
          {pad("W", { surge: 1 }, "Surge forward")}
          <span />
          {pad("A", { yaw: -1 }, "Yaw to port")}
          {pad("S", { surge: -1 }, "Surge back")}
          {pad("D", { yaw: 1 }, "Yaw to starboard")}
        </div>
        <div className="grid grid-cols-2 gap-1" aria-label="Sway and heave pad">
          {pad("Q", { sway: -1 }, "Sway to port")}
          {pad("E", { sway: 1 }, "Sway to starboard")}
          {pad("R", { heave: 1 }, "Heave up")}
          {pad("F", { heave: -1 }, "Heave down")}
        </div>
      </div>
    </Section>
  );
}

function StationControls() {
  const { pan, tilt } = useFieldStore(useShallow((s) => ({ pan: s.engine.station.panDeg, tilt: s.engine.station.tiltDeg, t: s.telemetry.time })));
  const aim = useFieldStore((s) => s.aimStation);
  return (
    <Section title="Pan and tilt head">
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn onClick={() => aim(pan + 10, tilt)} ariaLabel="Pan left 10 degrees">
          Pan L
        </Btn>
        <Btn onClick={() => aim(pan - 10, tilt)} ariaLabel="Pan right 10 degrees">
          Pan R
        </Btn>
        <Btn onClick={() => aim(pan, tilt - 5)} ariaLabel="Tilt up 5 degrees">
          Tilt up
        </Btn>
        <Btn onClick={() => aim(pan, tilt + 5)} ariaLabel="Tilt down 5 degrees">
          Tilt down
        </Btn>
        <Btn onClick={() => aim(0, 0)}>Centre</Btn>
      </div>
      <p className="value mt-1 text-[11px] text-muted">
        Pan {pan >= 0 ? "+" : ""}
        {f1(pan)}° (port +) tilt {tilt >= 0 ? "+" : ""}
        {f1(tilt)}° beyond the mount
      </p>
    </Section>
  );
}

function TelemetryGrid() {
  const t = useFieldStore((s) => s.telemetry);
  const vehicle = useFieldStore((s) => !!s.engine.vehicle);
  return (
    <Section title="Telemetry" right={<SimTag />}>
      <div className="grid grid-cols-1 gap-x-6 min-[560px]:grid-cols-2">
        <div>
          <div className="label mb-1 text-[9px] text-dim">Vehicle</div>
          <Row k="Depth / altitude" v={`${f2(t.depthM)} / ${f2(t.altitudeM)}`} unit="m" />
          <Row k="Heading / pitch / roll" v={`${deg(t.headingDeg)} ${f1(t.pitchDeg)}° ${f1(t.rollDeg)}°`} />
          <Row k="Speed over ground" v={f2(t.speedOverGround)} unit="m/s" tone="teal" />
          <Row k="Speed through water" v={f2(t.speedThroughWater)} unit="m/s" tone="teal" />
          <Row k="Net buoyancy" v={`${t.netBuoyancyN >= 0 ? "+" : ""}${f1(t.netBuoyancyN)}`} unit="N" />
          <Row k="Reynolds number (hull)" v={t.reynolds > 0 ? t.reynolds.toExponential(2) : "0"} />
          {vehicle && <Row k="Pilot" v={`${t.pilot.mode}${t.pilot.waypoints ? ` ${Math.min(t.pilot.waypoint, t.pilot.waypoints)}/${t.pilot.waypoints}` : ""}`} />}
          {t.contact && <Row k="Contact" v="hull touching" tone="danger" />}
          {t.guarded && !t.contact && <Row k="Guard" v="holding off an edge or obstacle" tone="amber" />}
        </div>
        <div>
          <div className="label mb-1 text-[9px] text-dim">Water at the vehicle</div>
          <Row k="Water current" v={`${f2(t.currentSpeed)} m/s toward ${deg(t.currentHeadingDeg)}`} tone="teal" />
          <Row k="Density" v={f1(t.densityKgM3)} unit="kg/m³" />
          <Row k="Pressure" v={f1(t.pressureKPa)} unit="kPa" />
          <Row k="Temperature" v={f1(t.temperatureC)} unit="°C" />
          <Row k="Turbidity / visibility" v={`${f2(t.ntu)} NTU / ${f1(t.visibilityM)} m`} />
        </div>
      </div>
      {vehicle && (
        <div className="mt-2">
          <div className="label mb-1 text-[9px] text-dim">Thrust (fraction of maximum)</div>
          <Bar label="Surge" value={t.thrustFraction[0]} />
          <Bar label="Heave" value={t.thrustFraction[1]} />
          <Bar label="Sway" value={t.thrustFraction[2]} />
        </div>
      )}
      <p className="mt-1 text-[10px] leading-snug text-dim">Over ground is relative to the seabed; through water is relative to the moving water. The difference is the water current.</p>
    </Section>
  );
}
