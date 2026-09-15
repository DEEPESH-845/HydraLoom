"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { DEMO_PHASES } from "@/lib/sim/demo";
import { useSimStore } from "@/lib/sim/store";
import { ResultMetrics } from "./scenes";
import { Btn, pct } from "./shared";

/** Replaces the context card while the scripted demo runs. */
export function DemoCard() {
  const phase = useSimStore((s) => s.demo.phase);
  const paused = useSimStore((s) => s.demo.paused);
  const t = useSimStore((s) => s.demo.t);
  const result = useSimStore((s) => s.result);
  const previous = useSimStore((s) => s.previousResult);
  const pauseDemo = useSimStore((s) => s.pauseDemo);
  const startDemo = useSimStore((s) => s.startDemo);
  const exitDemo = useSimStore((s) => s.exitDemo);
  const setShowVision = useSimStore((s) => s.setShowVision);
  const p = DEMO_PHASES[phase] ?? DEMO_PHASES[0];

  // The director does not publish phase start times, so remember when this card saw the phase change.
  const phaseStart = useRef<{ phase: number; t: number; closed: boolean } | null>(null);
  const isResult = p.id === "RESULT";
  useEffect(() => {
    const ps = phaseStart.current;
    if (!ps || ps.phase !== phase) {
      phaseStart.current = { phase, t, closed: false };
      return;
    }
    if (!isResult || ps.closed || t - ps.t < p.minSeconds) return;
    ps.closed = true;
    setShowVision(true);
  }, [phase, isResult, t, p.minSeconds, setShowVision]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-1">
        {DEMO_PHASES.map((ph, i) => (
          <span key={ph.id} className={clsx("h-[3px] flex-1", i === phase ? "bg-teal" : i < phase ? "bg-teal/40" : "bg-line")} title={ph.title} />
        ))}
      </div>
      <div className="label mb-0.5 text-dim">
        Demo {String(phase + 1).padStart(2, "0")} / {String(DEMO_PHASES.length).padStart(2, "0")}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={p.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: "easeOut" }}>
          <h2 className="font-sans text-lg leading-tight text-text">{p.title}</h2>
          <p className="mt-1 text-[12px] leading-snug text-muted">{p.caption}</p>
          {isResult && result && (
            <div className="mt-3">
              <ResultMetrics result={result} previous={previous} />
            </div>
          )}
        </motion.div>
      </AnimatePresence>
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn onClick={() => pauseDemo(!paused)} active={paused}>
          {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "Resume" : "Pause"}
        </Btn>
        <Btn onClick={startDemo}>
          <RotateCcw size={14} /> Replay
        </Btn>
        <Btn onClick={exitDemo} className="ml-auto">
          <X size={14} /> Exit demo
        </Btn>
      </div>
    </div>
  );
}

const STAGES: [string, string][] = [
  ["Controlled testbed", "A tank, a gantry and a camera: every variable is known and adjustable."],
  ["Repeatable scenarios", "Seeded runs. Same turbidity, same light, same objects, same result."],
  ["Vision validation", "Detection quality measured against ground truth, not guessed at sea."],
  ["Autonomous control", "The policy closes the loop on physical motion: every action costs travel time."],
  ["Hardware testing", "The perception stack is exercised on real optics and real water before it moves to a vehicle."],
  ["Field deployment", "Only what has already worked in the tank goes into open water."],
];

/** The closing moment. Calm, sequential, no decoration. */
export function VisionMoment() {
  const setShowVision = useSimStore((s) => s.setShowVision);
  const result = useSimStore((s) => s.result);
  const close = () => {
    const s = useSimStore.getState();
    if (s.demo.active) s.exitDemo(); // the demo has nowhere left to go after the closing moment
    s.setShowVision(false);
  };
  const runAgain = () => {
    const s = useSimStore.getState();
    close();
    s.setScenario({ turbidity: 0.5 });
    s.runTest();
    s.setScene(4);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setShowVision]);

  return (
    <motion.div
      className="pointer-events-auto absolute inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto bg-ground/[0.985] px-6 max-[759px]:justify-start max-[759px]:pt-14 max-[759px]:pb-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <Btn onClick={close} className="absolute right-4 top-3">
        <X size={14} /> Close
      </Btn>
      <div className="label mb-6 text-dim">From simulation to field</div>
      <ol className="w-full max-w-[600px]">
        {STAGES.map(([name, text], i) => (
          <motion.li
            key={name}
            className="grid grid-cols-[200px_1fr] items-center gap-x-6 max-[759px]:grid-cols-1 max-[759px]:gap-y-1"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.15 + i * 0.12, ease: "easeOut" }}
          >
            <span
              className={clsx(
                "justify-self-start whitespace-nowrap border px-2.5 py-1.5 font-mono text-[11px] tracking-[0.12em] uppercase",
                i === STAGES.length - 1 ? "border-amber text-amber" : "border-teal text-teal",
              )}
            >
              {name}
            </span>
            <p className="text-[15px] leading-snug text-muted">{text}</p>
            {i < STAGES.length - 1 && (
              <>
                <span className="ml-4 h-5 w-px bg-line-strong" />
                <span />
              </>
            )}
          </motion.li>
        ))}
      </ol>
      <motion.h1
        className="mt-10 max-w-[700px] text-center font-sans text-2xl leading-tight text-text"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.15 + STAGES.length * 0.12 + 0.1 }}
      >
        Test underwater autonomy before risking it underwater.
      </motion.h1>
      <motion.div
        className="mt-4 flex flex-col items-center gap-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.15 + STAGES.length * 0.12 + 0.4 }}
      >
        {result && (
          <p className="value text-[13px] text-muted">
            This run: {result.objectsDetected} detected, {result.falsePositives} false positive{result.falsePositives === 1 ? "" : "s"}, {pct(result.coverage, 0)} coverage, in a
            repeatable tank test.
          </p>
        )}
        <Btn onClick={runAgain}>Run again with murkier water</Btn>
      </motion.div>
    </motion.div>
  );
}
