"use client";

import clsx from "clsx";
import { Focus, Pause, Play, Rotate3d } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import Link from "next/link";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useFieldStore, type WorkspaceId } from "@/lib/field/store";
import { PLATFORMS } from "@/lib/platforms";
import { ENVIRONMENT_LIBRARY } from "@/lib/world/environments";
import { FieldScene } from "@/components/field/FieldScene";
import { lastCapture } from "./AnalysisCard";
import { AnalysisCard } from "./AnalysisCard";
import { EnvironmentCard } from "./EnvironmentCard";
import { DetectionBoxes, DetectionStrip, FieldFeed } from "./FieldFeed";
import { PlatformCard } from "./PlatformCard";
import { SimulationCard, VIEWS, drive } from "./SimulationCard";
import { Row, SimTag, deg, f1, f2 } from "./ui";

/*
 * The platform shell over the field world (docs/BLUEPRINT.md sections 5 and 6): top bar with the workspace nav, the
 * 3D world full-bleed underneath, the platform camera and key telemetry in the right column, and the active
 * workspace's card bottom left. Below 1000 px it becomes a stack: header, 3D band (feed inset top right), workspace
 * strip and card. Elements tagged data-field are measured by the camera rig so the 3D subject sits in the free area.
 */

type NavItem = { n: string; label: string; ws?: WorkspaceId; href?: string; title: string };

const NAV: NavItem[] = [
  { n: "01", label: "Environment", ws: "environment", title: "Choose and tune the site: water, light, current" },
  { n: "02", label: "Platform", ws: "platform", title: "Choose the vehicle or station and its settings" },
  { n: "03", label: "Simulation", ws: "simulation", title: "Run, pilot, missions and telemetry" },
  { n: "04", label: "Model Lab", href: "/models", title: "Upload and evaluate detection models (opens /models)" },
  { n: "05", label: "Analysis", ws: "analysis", title: "Live analysis, results and dataset capture" },
  { n: "06", label: "Reports", href: "/reports", title: "Engineering reports (opens /reports)" },
  { n: "07", label: "Benchmark", href: "/benchmark", title: "Compare several models (opens /benchmark)" },
  { n: "08", label: "Autonomy", href: "/autonomy", title: "Learned navigation and model switching (opens /autonomy)" },
  { n: "09", label: "Hardware", href: "/hardware", title: "The physical gantry (opens /hardware)" },
];

const CARDS: Record<WorkspaceId, () => React.JSX.Element> = {
  environment: EnvironmentCard,
  platform: PlatformCard,
  simulation: SimulationCard,
  analysis: AnalysisCard,
};

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

const KEYS: Record<string, [keyof import("@/lib/physics/autopilot").Stick, number]> = {
  w: ["surge", 1],
  s: ["surge", -1],
  a: ["yaw", -1],
  d: ["yaw", 1],
  q: ["sway", -1],
  e: ["sway", 1],
  r: ["heave", 1],
  f: ["heave", -1],
};

/** Keyboard pilot: W/S surge, A/D yaw, Q/E sway, R/F heave, Space pause. Only when no text field has focus. */
function useKeyboardPilot() {
  useEffect(() => {
    const held = new Set<string>();
    const apply = () => {
      const stick = { surge: 0, sway: 0, heave: 0, yaw: 0 };
      for (const k of held) {
        const m = KEYS[k];
        if (m) stick[m[0]] += m[1];
      }
      drive(stick);
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " " && !(e.target instanceof HTMLButtonElement)) {
        const s = useFieldStore.getState();
        s.setPaused(!s.paused);
        e.preventDefault();
        return;
      }
      if (!KEYS[k]) return;
      e.preventDefault();
      if (held.has(k)) return;
      held.add(k);
      apply();
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!held.delete(k)) return;
      apply();
    };
    const blur = () => {
      if (!held.size) return;
      held.clear();
      apply();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
}

/** H toggles explore (panels step aside), Esc leaves it, C recenters on the whole site. */
function useExploreKeys() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useFieldStore.getState();
      const k = e.key.toLowerCase();
      if (k === "h") s.setExploring(!s.exploring);
      else if (e.key === "Escape" && s.exploring) s.setExploring(false);
      else if (k === "c") s.recenter();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
}

export function FieldWorkspace() {
  const workspace = useFieldStore((s) => s.workspace);
  const exploring = useFieldStore((s) => s.exploring);
  const view = useFieldStore((s) => s.view);
  useKeyboardPilot();
  useExploreKeys();
  useEffect(() => {
    // deep links from the other workspaces (/models, /reports): /?ws=platform opens 02 directly
    const ws = new URLSearchParams(window.location.search).get("ws");
    if (ws === "environment" || ws === "platform" || ws === "simulation" || ws === "analysis") useFieldStore.getState().setWorkspace(ws);
  }, []);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as Record<string, unknown>).__fieldCapture = lastCapture;
  }, []);
  const Card = CARDS[workspace];
  return (
    <MotionConfig reducedMotion="user">
      <main className="relative h-screen w-screen overflow-hidden bg-ground">
        <div className="absolute inset-0">
          <FieldScene />
        </div>
        <div className="pointer-events-none absolute inset-0 select-none overflow-hidden max-[999px]:flex max-[999px]:flex-col">
          {view === "pilot" && <DetectionBoxes full />}
          <Veil />
          <TopBar />
          <SiteTag />
          <DetectionStrip />
          {/* right column: platform camera and key telemetry */}
          <div
            data-field="column"
            className={clsx(
              exploring && "invisible",
              "pointer-events-auto absolute right-4 top-14 flex max-h-[calc(100%-4.5rem)] w-[340px] flex-col gap-2 max-[1259px]:w-[300px] max-[999px]:right-2 max-[999px]:w-[220px] max-[759px]:w-[176px]",
            )}
          >
            <FieldFeed />
            <div className="min-h-0 overflow-y-auto max-[999px]:hidden">
              <KeyTelemetry />
            </div>
          </div>
          {!exploring && <Compass />}
          {/* workspace strip below 1000 px; the desktop nav lives in the top bar */}
          <nav data-field="nav" data-exploring={exploring} aria-label="Workspaces" className="pointer-events-auto hidden data-[exploring=true]:invisible max-[999px]:static max-[999px]:mx-auto max-[999px]:mt-auto max-[999px]:flex max-[999px]:w-[calc(100%-1rem)] max-[999px]:border max-[999px]:border-b-0 max-[999px]:border-line max-[999px]:bg-panel/95">
            <NavItems compact />
          </nav>
          <div
            data-field="card"
            data-exploring={exploring}
            className="pointer-events-none absolute bottom-6 data-[exploring=true]:invisible left-4 w-[calc(100%-2rem)] max-w-[640px] min-[1000px]:max-w-[min(640px,calc(100%-340px-3rem-200px))] max-[1259px]:min-[1000px]:max-w-[min(640px,calc(100%-300px-3rem-200px))] max-[999px]:static max-[999px]:mx-auto max-[999px]:mb-2 max-[999px]:w-[calc(100%-1rem)] max-[999px]:max-w-none"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={workspace}
                className="panel pointer-events-auto max-h-[calc(100vh-15rem)] overflow-y-auto p-4 min-[1000px]:max-h-[min(46vh,calc(100vh-16rem))] max-[999px]:max-h-[42vh] max-[999px]:p-3"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                data-testid={`card-${workspace}`}
              >
                <Card />
              </motion.div>
            </AnimatePresence>
          </div>
          <AnimatePresence>{exploring && <ExploreHint key="explore" />}</AnimatePresence>
        </div>
      </main>
    </MotionConfig>
  );
}

function NavItems({ compact }: { compact?: boolean }) {
  const workspace = useFieldStore((s) => s.workspace);
  const setWorkspace = useFieldStore((s) => s.setWorkspace);
  return (
    <>
      {NAV.map((it) => {
        const on = it.ws === workspace;
        const cls = clsx(
          "group flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2 transition-colors duration-100",
          compact ? "flex-1 justify-center py-2" : "h-12 py-0",
          on ? "border-teal" : "border-transparent hover:border-line-strong",
        );
        const inner = (
          <>
            <span className={clsx("value text-[10px]", on ? "text-teal" : "text-dim")}>{it.n}</span>
            <span className={clsx("label", on ? "text-teal" : "text-muted group-hover:text-text", compact && "max-[759px]:hidden", !compact && !on && "max-[1679px]:hidden", !compact && on && "max-[1279px]:hidden")}>{it.label}</span>
          </>
        );
        return it.href ? (
          <Link key={it.n} href={it.href} className={cls} title={it.title} aria-label={`${it.n} ${it.label}`}>
            {inner}
          </Link>
        ) : (
          <button key={it.n} type="button" className={cls} onClick={() => setWorkspace(it.ws!)} aria-pressed={on} title={it.title} aria-label={`${it.n} ${it.label}`}>
            {inner}
          </button>
        );
      })}
    </>
  );
}

/** Shown while the panels are hidden: how to move through the site, and the way back. */
function ExploreHint() {
  const setExploring = useFieldStore((s) => s.setExploring);
  const recenter = useFieldStore((s) => s.recenter);
  return (
    <motion.div
      className="panel pointer-events-auto absolute bottom-5 left-1/2 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4 py-2.5"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      role="status"
      data-testid="explore-hint"
    >
      <span className="label text-teal">Explore</span>
      <span className="text-[12px] text-muted">Drag to orbit, right-drag to pan, scroll to zoom toward the cursor, arrow keys glide, double-click to focus a point.</span>
      <span className="flex gap-1.5">
        <button type="button" className="btn flex items-center gap-1.5" onClick={recenter} title="Whole site (C)">
          <Focus size={13} aria-hidden /> Recenter
        </button>
        <button type="button" className="btn" onClick={() => setExploring(false)} title="Show panels (H or Esc)">
          Done
        </button>
      </span>
    </motion.div>
  );
}

function TopBar() {
  const view = useFieldStore((s) => s.view);
  const setView = useFieldStore((s) => s.setView);
  const exploring = useFieldStore((s) => s.exploring);
  const setExploring = useFieldStore((s) => s.setExploring);
  const recenter = useFieldStore((s) => s.recenter);
  return (
    <header data-field="header" className="pointer-events-none absolute inset-x-0 top-0 flex h-12 items-center justify-between gap-3 border-b border-line/70 bg-ground/90 px-4 max-[999px]:static max-[999px]:shrink-0 max-[479px]:px-3">
      <div className="pointer-events-auto flex min-w-0 items-center gap-3">
        <span className="whitespace-nowrap font-mono text-[13px] font-semibold tracking-[0.28em] text-text max-[479px]:text-[12px] max-[479px]:tracking-[0.18em]">GANTRYLAB</span>
        <SimTag className="max-[399px]:hidden" />
      </div>
      <nav aria-label="Workspaces" className="pointer-events-auto flex min-w-0 items-stretch max-[999px]:hidden">
        <NavItems />
      </nav>
      <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
        <label className="sr-only" htmlFor="view-select">
          View
        </label>
        <select
          id="view-select"
          value={view}
          onChange={(e) => setView(e.target.value as typeof view)}
          className="border border-line-strong bg-panel-2 px-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-text"
          title="Main view"
        >
          {VIEWS.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={clsx("btn flex items-center gap-1.5", exploring && "btn-active")}
          onClick={() => setExploring(!exploring)}
          aria-pressed={exploring}
          title="Explore: hide the panels and move freely through the site (H)"
        >
          <Rotate3d size={13} aria-hidden /> <span className="max-[1279px]:hidden">Explore</span>
        </button>
        <button type="button" className="btn flex items-center gap-1.5" onClick={recenter} title="Recenter on the whole site (C)">
          <Focus size={13} aria-hidden /> <span className="max-[1279px]:hidden">Recenter</span>
        </button>
        <PlayPause />
      </div>
    </header>
  );
}

function PlayPause() {
  const paused = useFieldStore((s) => s.paused);
  const setPaused = useFieldStore((s) => s.setPaused);
  const time = useFieldStore((s) => s.telemetry.time);
  return (
    <button type="button" className={clsx("btn flex items-center gap-1.5", !paused && "btn-active")} onClick={() => setPaused(!paused)} aria-label={paused ? "Play simulation" : "Pause simulation"} title="Pause or play (Space)">
      {paused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
      <span className="value normal-case tracking-normal">{paused ? "paused" : `t ${time.toFixed(0)} s`}</span>
    </button>
  );
}

/** Environment and platform in use, plus an honest note whenever the main view differs from what the camera sees. */
function SiteTag() {
  const { envId, platformId, view, thinning, lampLevel } = useFieldStore(
    useShallow((s) => ({ envId: s.envId, platformId: s.platformId, view: s.view, thinning: s.overviewThinning, lampLevel: ENVIRONMENT_LIBRARY[s.envId].light.source === "lamp" ? s.conditions.lighting : s.conditions.lamps })),
  );
  const env = ENVIRONMENT_LIBRARY[envId];
  const lamp = env.light.source === "lamp";
  const pilot = view === "pilot";
  const headlights = PLATFORMS[platformId].lamps.count > 0 && lampLevel > 0.01;
  return (
    <div data-field="site-tag" role="status" className="pointer-events-none absolute left-4 top-14 flex max-w-[calc(100%-380px)] flex-wrap items-start gap-1 max-[999px]:left-2 max-[999px]:max-w-[calc(100%-240px)] max-[759px]:max-w-[calc(100%-196px)]">
      <span className="sim-tag flex items-center gap-1.5 bg-ground/85 text-text">
        <span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden />
        {env.name.toUpperCase()} · {PLATFORMS[platformId].name.toUpperCase()}
      </span>
      {!pilot && thinning && (
        <span className="sim-tag bg-ground/85" data-testid="thinning-tag">
          Overview: water thinned for visibility. The vehicle camera sees true water.
        </span>
      )}
      {!pilot && lamp && (
        <span className="sim-tag bg-ground/85" data-testid="fill-tag">
          Overview lit by a dim fill. The vehicle camera sees only its lamps.
        </span>
      )}
      {!pilot && headlights && (
        <span className="sim-tag bg-ground/85" data-testid="headlight-tag">
          Headlights drawn brighter here. The vehicle camera sees their true power.
        </span>
      )}
    </div>
  );
}

/** Veils the 3D view (and the feed under its transparent frame) while the world is swapped. */
function Veil() {
  const ready = useFieldStore((s) => s.worldReady);
  return (
    <div
      aria-hidden
      data-world-ready={ready ? "true" : "false"}
      className={clsx("absolute inset-0 bg-ground transition-opacity ease-out motion-reduce:transition-none", ready ? "opacity-0 duration-300" : "opacity-100 duration-200")}
    />
  );
}

function KeyTelemetry() {
  const t = useFieldStore((s) => s.telemetry);
  const vehicle = useFieldStore((s) => s.platformId !== "station");
  return (
    <div className="panel px-3 py-2" data-testid="key-telemetry">
      <div className="mb-1 flex items-center justify-between">
        <span className="label text-text">Telemetry</span>
        <SimTag />
      </div>
      <Row k="Depth / altitude" v={`${f1(t.depthM)} / ${f1(t.altitudeM)}`} unit="m" />
      <Row k="Heading" v={deg(t.headingDeg)} />
      {vehicle && <Row k="Vehicle speed over ground" v={f2(t.speedOverGround)} unit="m/s" />}
      {vehicle && <Row k="Vehicle speed through water" v={f2(t.speedThroughWater)} unit="m/s" />}
      <Row k="Water current here" v={`${f2(t.currentSpeed)} m/s ${deg(t.currentHeadingDeg)}`} tone="teal" />
      <Row k="Turbidity / visibility" v={`${f1(t.ntu)} NTU / ${f1(t.visibilityM)} m`} />
      {vehicle && <Row k="Net buoyancy" v={`${t.netBuoyancyN >= 0 ? "+" : ""}${f1(t.netBuoyancyN)}`} unit="N" />}
    </div>
  );
}

/** Compass rose: the water current (teal arrow, where it flows toward) and the platform heading (white needle). */
function Compass() {
  const show = useFieldStore((s) => s.showFlow);
  const { cur, curH, hdg, cfg } = useFieldStore(useShallow((s) => ({ cur: s.telemetry.currentSpeed, curH: s.telemetry.currentHeadingDeg, hdg: s.telemetry.headingDeg, cfg: s.conditions.current.speedMps })));
  if (!show) return null;
  const a = (curH * Math.PI) / 180;
  const h = (hdg * Math.PI) / 180;
  return (
    <div data-field="compass" className="panel pointer-events-auto absolute bottom-6 right-[372px] flex items-center gap-2 px-2.5 py-2 max-[1259px]:right-[332px] max-[999px]:hidden" aria-label="Current and heading compass" data-testid="compass">
      <svg viewBox="-30 -30 60 60" className="h-16 w-16" aria-hidden>
        <circle r="27" fill="none" stroke="var(--color-line-strong)" />
        {(["N", "E", "S", "W"] as const).map((n, i) => (
          <text key={n} x={[0, 21, 0, -21][i]} y={[-18, 3, 24, 3][i]} textAnchor="middle" fontSize="7" fill="var(--color-dim)" fontFamily="var(--font-mono)">
            {n}
          </text>
        ))}
        <line x1={-Math.sin(h) * 6} y1={Math.cos(h) * 6} x2={Math.sin(h) * 20} y2={-Math.cos(h) * 20} stroke="var(--color-text)" strokeWidth="1.5" />
        <line x1={-Math.sin(a) * 12} y1={Math.cos(a) * 12} x2={Math.sin(a) * 16} y2={-Math.cos(a) * 16} stroke="var(--color-teal)" strokeWidth="2.5" />
        <polygon points={`${Math.sin(a) * 24},${-Math.cos(a) * 24} ${Math.sin(a + 0.4) * 15},${-Math.cos(a + 0.4) * 15} ${Math.sin(a - 0.4) * 15},${-Math.cos(a - 0.4) * 15}`} fill="var(--color-teal)" />
      </svg>
      <div className="value text-[10px] leading-relaxed">
        <div className="text-teal">CURRENT {f2(cur)} m/s</div>
        <div className="text-muted">toward {deg(curH)}</div>
        <div className="text-dim">set {f2(cfg)} m/s</div>
        <div className="text-text">HDG {deg(hdg)}</div>
      </div>
    </div>
  );
}
