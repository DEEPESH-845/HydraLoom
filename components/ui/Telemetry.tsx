"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSimStore } from "@/lib/sim/store";
import { f1, pad2, pct, signed } from "./shared";

function Row({ k, v, tone }: { k: string; v: ReactNode; tone?: "teal" | "amber" }) {
  return (
    <>
      <span className="label truncate">{k}</span>
      <span className={clsx("value whitespace-nowrap text-right text-[11px] tabular-nums", tone === "teal" ? "text-teal" : tone === "amber" ? "text-amber" : "text-text")}>{v}</span>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-line px-2.5 py-1 first:border-t-0">
      <div className="label mb-0.5 text-[9px] text-dim">{title}</div>
      <div className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-[2px]">{children}</div>
    </div>
  );
}

/** Slices are selected with useShallow so the panel re-renders only when a displayed value changes. */
export function Telemetry() {
  const paused = useSimStore((s) => s.demo.active && s.demo.paused);
  const g = useSimStore(
    useShallow((s) => ({ x: s.telemetry.gantry.x, y: s.telemetry.gantry.y, vx: s.telemetry.gantry.vx, vy: s.telemetry.gantry.vy, moving: s.telemetry.gantry.moving, atHome: s.telemetry.gantry.atHome })),
  );
  const cam = useSimStore(useShallow((s) => ({ fps: s.telemetry.camera.fps, res: s.telemetry.camera.resolution })));
  const vis = useSimStore(useShallow((s) => ({ count: s.telemetry.vision.count, inFrame: s.telemetry.vision.inFrame, best: s.telemetry.vision.bestConfidence, hz: s.telemetry.vision.hz })));
  const rl = useSimStore(
    useShallow((s) => ({
      episode: s.rl.episode,
      step: s.rl.step,
      action: s.rl.action,
      reward: s.rl.reward,
      episodeReward: s.rl.episodeReward,
      conf: s.rl.policyConfidence,
      active: s.rl.active,
    })),
  );
  const sys = useSimStore(useShallow((s) => ({ ...s.telemetry.system, time: Math.floor(s.telemetry.time * 10) / 10 })));

  return (
    <div className="panel">
      <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
        <span className="label text-text">Telemetry</span>
        <span className="sim-tag">SIMULATED</span>
      </div>
      <Section title="Gantry">
        <Row k="X" v={`${f1(g.x)} cm`} />
        <Row k="Y" v={`${f1(g.y)} cm`} />
        <Row k="VX" v={`${f1(g.vx)} cm/s`} />
        <Row k="VY" v={`${f1(g.vy)} cm/s`} />
        <Row k="State" v={paused ? "PAUSED" : g.moving ? "MOVING" : "HOLDING"} tone={g.moving && !paused ? "teal" : undefined} />
        <Row k="At home" v={g.atHome ? "YES" : "NO"} />
      </Section>
      <Section title="Camera">
        <Row k="FPS" v={`${cam.fps} nominal`} />
        <Row k="Res" v={cam.res.replace(" (simulated)", "")} />
      </Section>
      <Section title="Vision">
        <Row k="Detected" v={pad2(vis.count)} tone={vis.count > 0 ? "amber" : undefined} />
        <Row k="Best" v={pct(vis.best)} />
        <Row k="Detector" v={`${vis.hz} Hz nominal`} />
        <Row k="In frame" v={pad2(vis.inFrame)} />
      </Section>
      <Section title="Control">
        <Row k="Episode" v={rl.episode} />
        <Row k="Step" v={rl.step} />
        <Row k="Action" v={rl.action} tone={rl.active ? "amber" : undefined} />
        <Row k="Reward" v={signed(rl.reward)} />
        <Row k="Ep reward" v={signed(rl.episodeReward)} />
        <Row k="Policy" v={pct(rl.conf, 0)} />
      </Section>
      <Section title="System">
        <Row k="Arduino" v={sys.arduino} tone="teal" />
        <Row k="Pi" v={sys.raspberryPi} tone="teal" />
        <Row k="Camera" v={sys.camera} tone="teal" />
        <Row k="Sim time" v={`${f1(sys.time)} s`} />
      </Section>
    </div>
  );
}
