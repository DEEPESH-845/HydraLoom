"use client";

import clsx from "clsx";
import Link from "next/link";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Focus, Play, Rotate3d, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ENVIRONMENTS } from "@/lib/sim/environments";
import { useSimStore, type SceneId } from "@/lib/sim/store";
import { CameraFeed } from "./CameraFeed";
import { DemoCard, VisionMoment } from "./overlays";
import { ControlCard, GantryCard, OverviewCard, ResultCard, ScenarioCard, SystemCard, VisionCard } from "./scenes";
import { Btn } from "./shared";
import { Telemetry } from "./Telemetry";

const SCENES: { id: SceneId; name: string }[] = [
  { id: 1, name: "Overview" },
  { id: 2, name: "System" },
  { id: 3, name: "Vision" },
  { id: 4, name: "Gantry" },
  { id: 5, name: "Control" },
  { id: 6, name: "Scenario" },
  { id: 7, name: "Result" },
];

const CARDS: Record<SceneId, () => React.JSX.Element> = {
  1: OverviewCard,
  2: SystemCard,
  3: VisionCard,
  4: GantryCard,
  5: ControlCard,
  6: ScenarioCard,
  7: ResultCard,
};

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

/** DOM overlay over the 3D scene. Pointer events pass through everywhere except the panels. */
/** The VISION column grows with the viewport so its bottom never reaches the centred card: 440 px at 1440, 300 px below 1220. */
function useVisionColumnWidth() {
  const [w, setW] = useState(440);
  useEffect(() => {
    const update = () => setW(Math.min(440, Math.max(300, window.innerWidth - 920)));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return w;
}

export function LabUI() {
  const scene = useSimStore((s) => s.scene);
  const demoActive = useSimStore((s) => s.demo.active);
  const showVision = useSimStore((s) => s.showVision);
  const exploring = useSimStore((s) => s.exploring);
  const setScene = useSimStore((s) => s.setScene);
  const visionColumnWidth = useVisionColumnWidth();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useSimStore.getState();
      if (s.demo.active || s.showVision) return;
      const cur = s.scene;
      if (e.key === "e" || e.key === "E") s.setExploring(!s.exploring);
      else if (e.key === "Escape" && s.exploring) s.setExploring(false);
      else if (e.key === "c" || e.key === "C") s.recenterView();
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") s.setScene(Math.min(7, cur + 1) as SceneId);
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") s.setScene(Math.max(1, cur - 1) as SceneId);
      else if (e.key >= "1" && e.key <= "7") s.setScene(Number(e.key) as SceneId);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Card = CARDS[scene];

  return (
    <MotionConfig reducedMotion="user">
      <div className="pointer-events-none absolute inset-0 select-none overflow-hidden max-[999px]:flex max-[999px]:flex-col">
        <SiteVeil />
        <TopBar />

        <SiteTag />

        {/* left rail: scene index. Below 1000 px it is a horizontal strip directly above the card. */}
        <nav
          data-lab="nav"
          className={clsx(exploring && "invisible", "pointer-events-auto absolute left-4 top-1/2 flex -translate-y-1/2 flex-col gap-0.5 border border-line/60 bg-ground/80 py-1.5 max-[999px]:static max-[999px]:py-0 max-[999px]:mx-auto max-[999px]:w-[calc(100%-2rem)] max-[999px]:max-w-[620px] max-[999px]:translate-y-0 max-[999px]:flex-row max-[999px]:gap-0 max-[999px]:border max-[999px]:border-b-0 max-[999px]:border-line max-[999px]:bg-panel/92 max-[999px]:px-1")}
          aria-label="Scenes"
        >
          {SCENES.map((s) => {
            const on = s.id === scene;
            return (
              <button
                key={s.id}
                type="button"
                disabled={demoActive}
                onClick={() => setScene(s.id)}
                className={clsx(
                  "group flex items-center gap-2 border-l-2 py-1 pl-2 pr-3 text-left transition-colors duration-100 max-[999px]:border-b-2 max-[999px]:border-l-0 max-[999px]:px-2 max-[999px]:py-2",
                  on ? "border-teal" : "border-transparent hover:border-line-strong",
                  demoActive && "cursor-default opacity-50",
                )}
              >
                <span className={clsx("value text-[10px]", on ? "text-teal" : "text-dim")}>{String(s.id).padStart(2, "0")}</span>
                <span className={clsx("label", on ? "text-teal" : "text-muted group-hover:text-text max-[759px]:hidden")}>{s.name}</span>
              </button>
            );
          })}
        </nav>

        {/* right column: feed + telemetry. Wider in VISION so the feed is the focus. */}
        <motion.div
          data-lab="column"
          className={clsx(exploring && "invisible", "pointer-events-auto absolute right-4 top-14 flex max-h-[calc(100%-4.5rem)] flex-col gap-2 max-[999px]:w-[220px]! max-[759px]:w-[176px]!")}
          initial={false}
          animate={{ width: scene === 3 ? visionColumnWidth : 300 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          <CameraFeed />
          {scene !== 3 && (
            <div className="min-h-0 overflow-y-auto max-[999px]:hidden">
              <Telemetry />
            </div>
          )}
        </motion.div>

        {/* bottom centre: context card or demo controller. Between 1000 and 1259 px it sits between the rail and the column; below 1000 px it is the last block of the stack. */}
        <div data-lab="card" className={clsx(exploring && "invisible", "pointer-events-none absolute bottom-6 left-1/2 w-[calc(100%-2rem)] max-w-[620px] -translate-x-1/2 max-[1259px]:left-32 max-[1259px]:right-[332px] max-[1259px]:w-auto max-[1259px]:max-w-none max-[1259px]:translate-x-0 max-[999px]:static max-[999px]:mx-auto max-[999px]:mb-4 max-[999px]:w-[calc(100%-2rem)] max-[999px]:max-w-[620px] max-[999px]:translate-x-0")}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={demoActive ? "demo" : scene}
              className="panel pointer-events-auto max-h-[calc(100vh-9rem)] overflow-y-auto p-4 max-[999px]:max-h-[55vh] max-[759px]:max-h-[42vh]"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {demoActive ? <DemoCard /> : <Card />}
            </motion.div>
          </AnimatePresence>
        </div>

        <AnimatePresence>{exploring && <ExploreHint key="explore" />}</AnimatePresence>

        <AnimatePresence>{showVision && <VisionMoment key="vision" />}</AnimatePresence>
      </div>
    </MotionConfig>
  );
}

/**
 * Which environment the tank is set up as, and an honest note when the main 3D view is lit differently from the feed.
 * Top left under the header from 1000 px; below that it sits in the stack directly above the scene strip.
 * Stays visible in explore mode, where the 3D view is all there is to look at.
 */
function SiteTag() {
  const environment = useSimStore((s) => s.scenario.environment);
  const env = ENVIRONMENTS[environment];
  // the lamp-lit deep gets an overview fill light in the main view only (components/lab/TankDressing.tsx overviewFill)
  const filled = env.light === "lamp";

  return (
    <div
      data-lab="site-tag"
      className="pointer-events-none absolute left-4 top-14 flex max-w-[calc(100%-360px)] flex-wrap items-start gap-1 max-[999px]:static max-[999px]:mx-auto max-[999px]:mt-auto max-[999px]:mb-1.5 max-[999px]:w-[calc(100%-2rem)] max-[999px]:max-w-[620px]"
      role="status"
    >
      <span className="sim-tag flex items-center gap-1.5 bg-ground/85 text-text">
        <span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden />
        {environment === "tank" ? env.name.toUpperCase() : `TANK · ${env.name.toUpperCase()} WATER`}
      </span>
      {filled && (
        <span className="sim-tag bg-ground/85" title="Lab lights are off for the deep sea. The main 3D view adds a dim fill so the rig stays visible; the camera feed and detection see only the rig's lamps.">
          OVERVIEW LIT FOR VISIBILITY · camera feed sees only the rig lamps
        </span>
      )}
    </div>
  );
}

/**
 * Covers the 3D view (and the camera feed under its transparent frame) while the site is swapped for another
 * environment, so the swap and the shader compile behind it are never seen. Panels stay above it and usable.
 */
function SiteVeil() {
  const ready = useSimStore((s) => s.siteReady);
  return (
    <div
      aria-hidden
      data-site-ready={ready ? "true" : "false"}
      className={clsx(
        "absolute inset-0 bg-ground transition-opacity ease-out motion-reduce:transition-none",
        ready ? "opacity-0 duration-300" : "opacity-100 duration-200",
      )}
    />
  );
}

/** Shown while the panels are hidden: how to drive the free camera, and the way back. */
function ExploreHint() {
  const setExploring = useSimStore((s) => s.setExploring);
  const recenterView = useSimStore((s) => s.recenterView);
  return (
    <motion.div
      className="panel pointer-events-auto absolute bottom-6 left-1/2 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4 py-2.5"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      role="status"
    >
      <span className="label text-teal">Explore</span>
      <span className="text-[12px] text-muted">Drag to orbit, right-drag to pan, scroll or pinch to zoom, double-click a part to orbit around it.</span>
      <span className="flex gap-1.5">
        <Btn onClick={recenterView} title="Recenter view (C)">
          <Focus size={14} /> Recenter
        </Btn>
        <Btn onClick={() => setExploring(false)} title="Show panels (E or Esc)">
          Done
        </Btn>
      </span>
    </motion.div>
  );
}

function StatusChip({ name, value }: { name: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5 border border-line px-2 py-1">
      <span className="h-1.5 w-1.5 rounded-full bg-teal" />
      <span className="label text-text">{name}</span>
      <span className="label text-[9px] text-dim">{value}</span>
    </span>
  );
}

function TopBar() {
  const sys = useSimStore(useShallow((s) => s.telemetry.system));
  const demoActive = useSimStore((s) => s.demo.active);
  const startDemo = useSimStore((s) => s.startDemo);
  const reset = useSimStore((s) => s.reset);
  const exploring = useSimStore((s) => s.exploring);
  const setExploring = useSimStore((s) => s.setExploring);
  const recenterView = useSimStore((s) => s.recenterView);

  return (
    <header data-lab="header" className="pointer-events-none absolute inset-x-0 top-0 flex h-12 items-center justify-between gap-4 border-b border-line/70 bg-ground/85 px-4 max-[999px]:static max-[479px]:gap-2 max-[479px]:px-3 max-[999px]:shrink-0">
      <div className="pointer-events-auto flex min-w-0 items-baseline gap-3 overflow-hidden">
        {/* the wordmark leads back to the platform (all environments, Model Lab, Reports); the lab is one of its modes */}
        <Link href="/" title="All environments, Model Lab and Reports" className="whitespace-nowrap font-mono text-[13px] font-semibold tracking-[0.28em] text-text outline-offset-2 hover:text-teal max-[479px]:text-[12px] max-[479px]:tracking-[0.18em]">
          GANTRYLAB
        </Link>
        <span className="label whitespace-nowrap max-[1399px]:hidden">Underwater robotics testbed</span>
        <span className="hidden truncate whitespace-nowrap text-[12px] text-muted min-[1680px]:block">Test underwater autonomy in a tank before open water.</span>
      </div>
      <div className="pointer-events-auto flex shrink-0 items-center gap-1.5 max-[399px]:gap-1">
        {/* secondary status, dropped below 1000 px so the brand always has room */}
        <div className="contents max-[999px]:hidden">
          <StatusChip name="Arduino" value={sys.arduino} />
          <StatusChip name="Raspberry Pi" value={sys.raspberryPi} />
          <StatusChip name="Camera" value={sys.camera} />
          <span className="mx-1 h-5 w-px bg-line" />
        </div>
        <Btn onClick={() => setExploring(!exploring)} active={exploring} disabled={demoActive} title="Explore: hide the panels and orbit freely (E)">
          <Rotate3d size={14} /> <span className="max-[1279px]:hidden">Explore</span>
        </Btn>
        <Btn onClick={recenterView} title="Recenter view (C)">
          <Focus size={14} /> <span className="max-[1279px]:hidden">Recenter</span>
        </Btn>
        <Btn primary onClick={startDemo} disabled={demoActive}>
          <Play size={14} className="max-[399px]:hidden" /> {demoActive ? <>Demo<span className="max-[999px]:hidden"> running</span></> : "Run demo"}
        </Btn>
        <Btn onClick={reset} disabled={demoActive} title="Reset">
          <RotateCcw size={14} /> <span className="max-[479px]:hidden">Reset</span>
        </Btn>
      </div>
    </header>
  );
}
