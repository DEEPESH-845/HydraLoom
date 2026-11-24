"use client";

import clsx from "clsx";
import { Home, Play, RotateCcw, Square } from "lucide-react";
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { GANTRY } from "@/lib/sim/constants";
import { useSimStore, type ComponentId } from "@/lib/sim/store";
import { ACTIONS, type Action, type TestResult } from "@/lib/sim/types";
import { visibilityRange, waterOptics } from "@/lib/optics/water";
import { ENVIRONMENT_IDS, ENVIRONMENTS, environmentNtu, environmentWater, type Environment, type EnvironmentId } from "@/lib/sim/environments";
import { STRATEGIES, STRATEGY_IDS, plannedViewpoints, type StrategyId } from "@/lib/gantry/strategies";
import { compareStrategies, type StrategyRow } from "@/lib/gantry/evaluate";
import { LabCapturePanel } from "./LabCapturePanel";
import { Btn, CardHead, Chain, Chip, ObjectChips, clampNum, f1, f2, isTargetClass, pad2, pct, signed, useObjects } from "./shared";

/** Shown once a test has finished and nothing else is running. */
function ViewResultLink({ className }: { className?: string }) {
  const show = useSimStore((s) => s.result !== null && s.mode !== "TEST");
  const setScene = useSimStore((s) => s.setScene);
  if (!show) return null;
  return (
    <button type="button" className={clsx("value text-[10px] text-amber hover:underline", className)} onClick={() => setScene(7)}>
      TEST COMPLETE, VIEW RESULT -&gt;
    </button>
  );
}

// ---------------------------------------------------------------- 01 OVERVIEW

export function OverviewCard() {
  const runTest = useSimStore((s) => s.runTest);
  const setScene = useSimStore((s) => s.setScene);
  return (
    <div>
      <CardHead
        title="Underwater robotics testbed"
        note="A controlled physical environment for testing underwater perception, navigation and autonomy before field deployment."
      />
      <div className="flex flex-wrap gap-2">
        <Btn
          primary
          onClick={() => {
            runTest();
            setScene(4);
          }}
        >
          <Play size={14} /> Run simulation
        </Btn>
        <Btn onClick={() => setScene(2)}>Explore the system</Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 02 SYSTEM

const COMPONENTS: { id: ComponentId; name: string; text: string }[] = [
  { id: "gantry", name: "Gantry", text: "2020 frame, two X rails, Y beam, NEMA17 + GT2 belts. 100 x 40 cm travel." },
  { id: "camera", name: "Camera", text: "Pi Camera Module 3 Wide in an acrylic housing, 8 cm under the surface." },
  { id: "aquarium", name: "Aquarium", text: "120 x 60 x 60 cm glass tank, 50 cm of water, sand floor." },
  { id: "raspberry-pi", name: "Raspberry Pi", text: "Runs detection on the feed, talks to the Arduino over USB serial." },
  { id: "arduino", name: "Arduino", text: "Uno + CNC shield, two A4988 drivers, 80 steps per mm." },
  { id: "test-objects", name: "Test objects", text: "Printed hull section, inert training mine and debris on the sand." },
];

const MAPPING: [string, string][] = [
  ["Three.js aquarium", "120 x 60 x 60 glass tank"],
  ["Virtual gantry", "Arduino + CNC shield XY gantry"],
  ["Virtual camera", "Pi Camera Module 3 in acrylic housing"],
  ["Detection engine", "YOLO model on the Raspberry Pi"],
  ["Rule-based controller", "Control policy on the Raspberry Pi"],
  ["Test objects", "3D printed obstacles on sand"],
];

/** Substrate and set-up the tank carries for each emulated environment. */
const TANK_SETUP: Record<EnvironmentId, string> = {
  tank: "120 x 60 x 60 cm glass tank, 50 cm of water, sand floor.",
  harbor: "Same tank set up as harbour water: dark organic mud, shell grit, scale pilings, a tyre and chain in the margins.",
  river: "Same tank set up as river water: sand and gravel bed, a slow flume current, a scale bridge pier and a branch.",
  deepsea: "Same tank set up as the deep sea: pale ooze with manganese nodules, lab lights off, only the rig's lamps.",
};

/** The aquarium row says how the tank is set up for the current environment; the rest of the rig is unchanged. */
function siteRow(c: (typeof COMPONENTS)[number], env: Environment): { name: string; text: string } {
  if (c.id === "aquarium") return { name: c.name, text: TANK_SETUP[env.id] };
  return c;
}

export function SystemCard() {
  const env = ENVIRONMENTS[useSimStore((s) => s.scenario.environment)];
  const setHighlight = useSimStore((s) => s.setHighlight);
  const releaseHighlight = useSimStore((s) => s.releaseHighlight);
  const pinHighlight = useSimStore((s) => s.pinHighlight);
  const highlight = useSimStore((s) => s.highlight);
  // the pin lives in the store, so leaving a 3D callout returns to it as leaving a row does
  const sticky = useSimStore((s) => s.pinnedHighlight);
  const [mapping, setMapping] = useState(false);
  const toggle = (id: ComponentId) => pinHighlight(sticky === id ? null : id);

  return (
    <div>
      <CardHead title="System" note="Hover a component to highlight it in the scene. Click to keep it highlighted." />
      <ul className="grid grid-cols-2 gap-x-4 border-t border-line max-[759px]:grid-cols-1">
        {COMPONENTS.map((c, i) => {
          const on = highlight === c.id;
          return (
            <li
              key={c.id}
              className={clsx(
                "grid cursor-pointer grid-cols-[22px_1fr] gap-x-1.5 border-b border-line py-1 pr-1 pl-1 transition-colors duration-100",
                on ? "bg-panel-2" : "hover:bg-panel-2/60",
              )}
              role="button"
              tabIndex={0}
              aria-pressed={sticky === c.id}
              onMouseEnter={() => setHighlight(c.id)}
              onMouseLeave={releaseHighlight}
              onFocus={() => setHighlight(c.id)}
              onBlur={releaseHighlight}
              onClick={() => toggle(c.id)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                toggle(c.id);
              }}
            >
              <span className={clsx("value text-[11px]", on ? "text-teal" : "text-dim")}>{pad2(i + 1)}</span>
              <span className={clsx("label", on ? "text-teal" : "text-text")}>{siteRow(c, env).name}</span>
              <span />
              <span className="text-[11px] leading-snug text-muted">{siteRow(c, env).text}</span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="label mt-2 flex items-center gap-1.5 hover:text-text" onClick={() => setMapping((m) => !m)} aria-expanded={mapping}>
        <span className="value text-[10px] text-dim">{mapping ? "-" : "+"}</span> Real-world mapping
      </button>
      {mapping && (
        <div className="mt-1 grid grid-cols-[auto_16px_1fr] gap-x-3 gap-y-[1px]">
          <span className="label text-dim">Simulation</span>
          <span />
          <span className="label text-dim">Physical (planned)</span>
          {MAPPING.map(([sim, phys]) => (
            <div key={sim} className="contents">
              <span className="value text-[10px] text-muted">{sim}</span>
              <span className="value text-[10px] text-dim">-&gt;</span>
              <span className="value text-[10px] text-text">{phys}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 03 VISION

const PIPELINE = ["FRAME", "PREPROCESS", "DETECT", "CLASSIFY", "CONFIDENCE", "WORLD XY"];

export function VisionCard() {
  const detections = useSimStore((s) => s.detections);
  const trackObject = useSimStore((s) => s.trackObject);
  const runTest = useSimStore((s) => s.runTest);
  const selected = useSimStore((s) => s.selectedObjectId);
  const inFrame = useSimStore((s) => s.telemetry.vision.inFrame);
  const threshold = useSimStore((s) => s.scenario.threshold);
  const testing = useSimStore((s) => s.mode === "TEST");

  return (
    <div>
      <CardHead
        title="Object detection"
        note="Detection is simulated from geometry, distance, centring, turbidity and light. No neural network runs in the browser."
      />
      <Chain items={PIPELINE} />
      <div className="mt-3 border-t border-line">
        {detections.length === 0 ? (
          <div className="flex items-center justify-between gap-3 py-2">
            <span className="text-[12px] text-muted">
              {inFrame > 0
                ? `${inFrame} object${inFrame === 1 ? "" : "s"} in view, below the ${pct(threshold, 0)} threshold.`
                : "No objects in the camera footprint. Move the gantry or run a scan."}
            </span>
            {!testing && <Btn onClick={runTest}>Scan</Btn>}
          </div>
        ) : (
          detections.map((d) => {
            const t = isTargetClass(d.class);
            return (
              <div key={d.objectId} className="grid grid-cols-[92px_52px_1fr_56px_70px_auto] items-center gap-2 border-b border-line py-1 max-[759px]:grid-cols-[72px_44px_1fr_auto]">
                <span className={clsx("value text-[11px]", t ? "text-amber" : "text-teal")}>{d.class}</span>
                <span className="value text-[11px] text-text">{pct(d.confidence)}</span>
                <span className="value text-[11px] text-muted">
                  X {f1(d.estX)}&nbsp;&nbsp;Y {f1(d.estY)}
                </span>
                <span className="value text-[11px] text-muted max-[759px]:hidden">{f2(d.distance)} m</span>
                <span className={clsx("label max-[759px]:hidden", d.state === "LOCKED" ? "text-teal" : "text-muted")}>{d.state}</span>
                <Chip tone="teal" active onClick={() => trackObject(d.objectId)}>
                  Track
                </Chip>
              </div>
            );
          })
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ObjectChips label="Point at" activeId={selected} onPick={trackObject} />
        <ViewResultLink className="ml-auto" />
      </div>
      <LabCapturePanel />
    </div>
  );
}

// ---------------------------------------------------------------- 04 GANTRY

const PAD_W = 250;
const PAD_H = (PAD_W * GANTRY.travelY) / GANTRY.travelX;

function XYPad() {
  // Re-render on every telemetry publish (20 Hz) so the target ring read off the engine is never stale.
  const pos = useSimStore((s) => s.telemetry.gantry);
  const moveGantryTo = useSimStore((s) => s.moveGantryTo);
  const objects = useObjects();
  const strategy = useSimStore((s) => s.scenario.strategy);
  const waypoints = useSimStore((s) => s.scenario.waypoints);
  // the selected strategy's plan, not always the serpentine's six points
  const plan = useMemo(() => plannedViewpoints(strategy, waypoints), [strategy, waypoints]);
  const g = useSimStore.getState().engine.gantry;
  const px = (x: number) => (x / GANTRY.travelX) * 100;
  const py = (y: number) => (y / GANTRY.travelY) * 100;

  const moveToPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = clampNum(((e.clientX - r.left) / r.width) * GANTRY.travelX, 0, GANTRY.travelX);
    const y = clampNum(((e.clientY - r.top) / r.height) * GANTRY.travelY, 0, GANTRY.travelY);
    moveGantryTo(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  };
  // Press to send the carriage, keep the button down and drag to steer it live; the motion profile still limits speed.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    moveToPointer(e);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) moveToPointer(e);
  };
  // Arrow keys jog one controller step (5 cm) from the current target; Shift jogs 1 cm.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.shiftKey ? 1 : GANTRY.stepCm;
    const dx = e.key === "ArrowRight" ? d : e.key === "ArrowLeft" ? -d : 0;
    const dy = e.key === "ArrowDown" ? d : e.key === "ArrowUp" ? -d : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation(); // arrows otherwise switch scenes
    moveGantryTo(clampNum(g.x.target + dx, 0, GANTRY.travelX), clampNum(g.y.target + dy, 0, GANTRY.travelY));
  };

  return (
    <div
      className="relative shrink-0 cursor-crosshair touch-none border border-line-strong bg-panel-2/60"
      style={{
        width: PAD_W,
        height: PAD_H,
        backgroundImage: "linear-gradient(to right, var(--color-line) 1px, transparent 1px), linear-gradient(to bottom, var(--color-line) 1px, transparent 1px)",
        backgroundSize: `${PAD_W / 10}px ${PAD_H / 4}px`,
        backgroundPosition: "-1px -1px", // the first grid line would otherwise double the border
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="group"
      aria-label="Gantry XY pad: click or drag to move the carriage, arrow keys jog 5 cm, Shift and arrow 1 cm"
      title="Click to move the gantry"
    >
      {plan.map(([x, y], i) => (
        <span key={`${i}-${x}-${y}`} data-waypoint className="absolute h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-dim" style={{ left: `${px(x)}%`, top: `${py(y)}%` }} />
      ))}
      {objects.map((o) => (
        <span
          key={o.id}
          className={clsx("absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2", isTargetClass(o.type) ? "bg-amber" : "bg-muted")}
          style={{ left: `${px(o.x)}%`, top: `${py(o.y)}%` }}
          title={o.label}
        />
      ))}
      {/* target ring */}
      <span
        className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-amber"
        style={{ left: `${px(g.x.target)}%`, top: `${py(g.y.target)}%` }}
      />
      {/* gantry crosshair */}
      <span className="absolute h-px w-3 -translate-x-1/2 -translate-y-1/2 bg-teal" style={{ left: `${px(pos.x)}%`, top: `${py(pos.y)}%` }} />
      <span className="absolute h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-teal" style={{ left: `${px(pos.x)}%`, top: `${py(pos.y)}%` }} />
    </div>
  );
}

export function GantryCard() {
  const t = useSimStore(
    useShallow((s) => ({ x: s.telemetry.gantry.x, y: s.telemetry.gantry.y, moving: s.telemetry.gantry.moving, mode: s.mode, phase: s.phase })),
  );
  // rl.targetId outlives the episode, so while tracking by hand the selected object wins, and a manual move has no
  // target at all (it used to keep showing the last episode's object).
  const targetId = useSimStore((s) => (s.mode === "MANUAL" ? null : s.mode === "TRACK" ? s.selectedObjectId : (s.rl.targetId ?? s.selectedObjectId)));
  const targetLabel = useSimStore((s) => s.scenario.objects.find((o) => o.id === targetId)?.label ?? null);
  const { moveGantryTo, runTest, stop, trackObject } = useSimStore(
    useShallow((s) => ({ moveGantryTo: s.moveGantryTo, runTest: s.runTest, stop: s.stop, trackObject: s.trackObject })),
  );
  const g = useSimStore.getState().engine.gantry;
  const remaining = Math.hypot(g.x.target - t.x, g.y.target - t.y);

  const steps: [string, string, string][] = [
    ["Target", targetLabel ?? (t.mode === "MANUAL" ? "MANUAL" : t.mode === "TEST" ? "SCAN" : "NONE"), "text-amber"],
    ["Coordinate", `${f1(g.x.target)}, ${f1(g.y.target)}`, "text-text"],
    ["Path", `${f1(remaining)} cm left`, remaining > GANTRY.arriveTolerance ? "text-teal" : "text-muted"],
    ["Gantry", `${f1(t.x)}, ${f1(t.y)} ${t.moving ? "MOVING" : "HOLDING"}`, t.moving ? "text-teal" : "text-text"],
  ];

  return (
    <div>
      <CardHead
        title="Gantry control"
        right={
          <span className="value text-[10px] text-muted">
            MODE <span className="text-teal">{t.mode}</span>&nbsp;&nbsp;PHASE <span className="text-teal">{t.phase}</span>
          </span>
        }
      />
      <div className="flex gap-4 max-[759px]:flex-col">
        <div className="shrink-0">
          <XYPad />
          <div className="value mt-0.5 text-right text-[9px] text-dim">100 x 40 cm</div>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-[auto_1fr] content-start gap-x-3 gap-y-1">
          {steps.map(([k, v, cls], i) => (
            <div key={k} className="contents">
              <span className="label flex items-center gap-1">
                {i > 0 && <span className="text-dim">-&gt;</span>}
                {k}
              </span>
              <span className={clsx("value truncate text-[11px]", cls)}>{v}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn onClick={() => moveGantryTo(0, 0)}>
          <Home size={14} /> Home
        </Btn>
        <Btn primary onClick={runTest}>
          <Play size={14} /> Run test
        </Btn>
        <Btn onClick={stop}>
          <Square size={14} /> Stop
        </Btn>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ObjectChips label="Track" activeId={targetId} onPick={trackObject} />
        <ViewResultLink className="ml-auto" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 05 CONTROL

const RL_PHASES = ["OBSERVE", "DECIDE", "MOVE"];

export function ControlCard() {
  const rl = useSimStore(useShallow((s) => s.rl));
  const selected = useSimStore((s) => s.selectedObjectId);
  const startEpisode = useSimStore((s) => s.startEpisode);
  const selectObject = useSimStore((s) => s.selectObject);
  const testRunning = useSimStore((s) => s.mode === "TEST");
  const objects = useObjects();
  const o = rl.observation;

  return (
    <div>
      <CardHead
        title="Controller"
        note="Rule-based controller, not a trained network: step toward the best detection, hold when centred. Reward is logged, not learned from."
        right={
          <span className="value whitespace-nowrap text-[10px] text-muted">
            EPISODE <span className="text-text">{rl.episode}</span>&nbsp;&nbsp;STEP <span className="text-text">{rl.step}</span>
          </span>
        }
      />
      <Chain items={RL_PHASES} activeIndex={rl.active ? RL_PHASES.indexOf(rl.phase) : -1} />

      <div className="mt-3 grid grid-cols-[1fr_auto_1fr_1fr] gap-x-5 max-[759px]:grid-cols-2 max-[759px]:gap-y-3">
        <div>
          <div className="label mb-1 text-dim">State</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[2px]">
            <KV k="x" v={f1(o.x)} />
            <KV k="y" v={f1(o.y)} />
            {/* the engine holds no target until an episode names one */}
            <KV k="target x" v={rl.targetId ? f1(o.targetX) : "-"} />
            <KV k="target y" v={rl.targetId ? f1(o.targetY) : "-"} />
            <KV k="target seen" v={rl.targetId ? pct(o.confidence) : "-"} />
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="label text-dim">-&gt; Action</span>
            {rl.exploring && (
              <Chip tone="amber" active>
                Explore
              </Chip>
            )}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {ACTIONS.map((a: Action) => (
              <Chip key={a} tone="amber" active={rl.active && rl.action === a} className="text-center">
                {a}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <div className="label mb-1 text-dim">-&gt; Reward</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[2px]">
            <KV k="step" v={signed(rl.reward)} tone={rl.reward >= 0 ? "text-teal" : "text-danger"} />
            <KV k="episode" v={signed(rl.episodeReward)} />
            <KV k="target" v={objects.find((o) => o.id === rl.targetId)?.label ?? "NONE"} />
          </div>
        </div>
        <div>
          <div className="label mb-1 text-dim">-&gt; Next state</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[2px]">
            <KV k="next x" v={f1(rl.nextX)} />
            <KV k="next y" v={f1(rl.nextY)} />
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="label">Policy conf</span>
        <div className="h-[3px] flex-1 bg-line">
          <div className="h-full bg-teal transition-[width] duration-150" style={{ width: `${clampNum(rl.policyConfidence, 0, 1) * 100}%` }} />
        </div>
        <span className="value w-10 text-right text-[11px] text-text">{pct(rl.policyConfidence, 0)}</span>
      </div>

      {rl.done && (
        <div className="mt-2 border border-line-strong px-2 py-1 text-[12px] text-text">
          Episode complete. Total reward <span className="value text-amber">{signed(rl.episodeReward)}</span> in {rl.step} steps.
        </div>
      )}

      {testRunning ? (
        <div className="label mt-3 text-dim">Test in progress. The policy is driving the gantry toward the best detection.</div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn primary onClick={() => startEpisode(selected ?? "wreck-01")}>
            <Play size={14} /> Run episode
          </Btn>
          <label className="label flex items-center gap-2">
            Target
            <select
              value={selected ?? "wreck-01"}
              onChange={(e) => selectObject(e.target.value)}
              className="value border border-line-strong bg-panel-2 px-1.5 py-1 text-[11px] text-text outline-none focus:border-teal"
            >
              {objects.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

function KV({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <>
      <span className="label whitespace-nowrap">{k}</span>
      <span className={clsx("value text-right text-[11px]", tone ?? "text-text")}>{v}</span>
    </>
  );
}

// ---------------------------------------------------------------- 06 SCENARIO

const fmtNtu = (ntu: number) => `${ntu < 10 ? ntu.toFixed(1) : ntu.toFixed(0)} NTU`;

/** Turbidity in NTU with the distance at which contrast drops to 2 percent, from the water model in lib/optics. */
function turbidityLabel(env: Environment, turbidity: number): string {
  const vis = visibilityRange(waterOptics(environmentWater(env, turbidity)).c[1]);
  const range = vis >= 10 ? ">10 m" : vis >= 1 ? `${vis.toFixed(1)} m` : `${Math.round(vis * 100)} cm`;
  return `${fmtNtu(environmentNtu(env, turbidity))} · sees ${range}`;
}

/** Segmented picker for the water the rig is placed in. Selecting one also applies its default turbidity and lighting. */
function EnvironmentPicker({ value, onPick }: { value: EnvironmentId; onPick: (id: EnvironmentId) => void }) {
  return (
    <div>
      <div className="label mb-1">Environment</div>
      <div className="grid grid-cols-4" role="group" aria-label="Environment">
        {ENVIRONMENT_IDS.map((id, i) => {
          const on = id === value;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(id)}
              className={clsx(
                "btn relative min-w-0 truncate px-1! py-1.5! text-center hover:z-10 focus-visible:z-20",
                i > 0 && "-ml-px",
                on && "btn-active z-10 bg-panel",
              )}
            >
              {ENVIRONMENTS[id].name}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-muted">{ENVIRONMENTS[value].problem}</p>
    </div>
  );
}

function Slider({ label, value, min, max, step, show, onChange }: { label: string; value: number; min: number; max: number; step: number; show: string; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="mb-0.5 flex items-center justify-between">
        <span className="label">{label}</span>
        <span className="value text-[11px] text-text">{show}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(clampNum(parseFloat(e.target.value), min, max))} />
    </label>
  );
}

/** Uncontrolled number input that commits on blur or Enter and clamps to its range. Remounts when the store value changes. */
function NumField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const commit = (el: HTMLInputElement) => {
    const n = Math.round(parseFloat(el.value));
    if (!Number.isFinite(n)) {
      el.value = String(value); // blank or junk reverts, it does not jump to the minimum
      return;
    }
    const v = clampNum(n, min, max);
    el.value = String(v);
    if (v !== value) onCommit(v);
  };
  return (
    <input
      key={value}
      type="number"
      min={min}
      max={max}
      defaultValue={value}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className="value w-14 border border-line-strong bg-panel-2 px-1 py-[2px] text-[11px] text-text outline-none [appearance:textfield] focus:border-teal [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

function ObjectRow({ index }: { index: number }) {
  const o = useSimStore(useShallow((s) => ({ id: s.scenario.objects[index].id, label: s.scenario.objects[index].label, type: s.scenario.objects[index].type, x: s.scenario.objects[index].x, y: s.scenario.objects[index].y })));
  const moveObject = useSimStore((s) => s.moveObject);
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-line py-[3px]">
      <span className="min-w-0">
        <span className="value block text-[10px] leading-tight text-text">{o.label}</span>
        <span className={clsx("label block text-[9px]", isTargetClass(o.type) ? "text-amber" : "text-muted")}>{o.type}</span>
      </span>
      <span className="flex items-center gap-1">
        <span className="label">X</span>
        <NumField value={Math.round(o.x)} min={3} max={GANTRY.travelX - 3} onCommit={(v) => moveObject(o.id, v, o.y)} />
      </span>
      <span className="flex items-center gap-1">
        <span className="label">Y</span>
        <NumField value={Math.round(o.y)} min={3} max={GANTRY.travelY - 3} onCommit={(v) => moveObject(o.id, o.x, v)} />
      </span>
    </div>
  );
}

/** Parses "x,y; x,y" gantry cm pairs; anything unparsable is dropped. */
function parseWaypoints(text: string): [number, number][] {
  return text
    .split(/[;\n]+/)
    .map((pair) => pair.split(/[,\s]+/).filter(Boolean).map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
    .map(([x, y]) => [x, y] as [number, number]);
}

/** How the scan chooses viewpoints. Every option is a heuristic; the copy says so. */
function StrategyPicker() {
  const strategy = useSimStore((s) => s.scenario.strategy);
  const waypoints = useSimStore((s) => s.scenario.waypoints);
  const setScenario = useSimStore((s) => s.setScenario);
  const info = STRATEGIES[strategy];
  return (
    <div className="mt-3">
      <label className="flex items-center justify-between gap-3">
        <span className="label">Inspection strategy</span>
        <select
          aria-label="Inspection strategy"
          value={strategy}
          onChange={(e) => setScenario({ strategy: e.target.value as StrategyId })}
          className="value min-w-0 border border-line-strong bg-panel-2 px-1.5 py-[3px] text-[11px] text-text outline-none focus:border-teal"
        >
          {STRATEGY_IDS.map((id) => (
            <option key={id} value={id}>
              {STRATEGIES[id].name}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-[12px] leading-snug text-muted">
        {info.summary} <span className="text-dim">Heuristic ({info.kind === "active-perception" ? "active perception" : info.kind}), not a trained policy.</span>
      </p>
      {strategy === "waypoints" && (
        <input
          key={waypoints.map((w) => w.join(",")).join(";")}
          aria-label="Waypoints, gantry cm"
          placeholder="x,y; x,y  e.g. 20,10; 60,30"
          defaultValue={waypoints.map((w) => w.join(",")).join("; ")}
          onBlur={(e) => setScenario({ waypoints: parseWaypoints(e.currentTarget.value) })}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="value mt-1 w-full border border-line-strong bg-panel-2 px-1.5 py-[3px] text-[11px] text-text outline-none focus:border-teal"
        />
      )}
    </div>
  );
}

export function ScenarioCard() {
  const sc = useSimStore(useShallow((s) => ({ environment: s.scenario.environment, turbidity: s.scenario.turbidity, lighting: s.scenario.lighting, threshold: s.scenario.threshold, gantrySpeed: s.scenario.gantrySpeed, count: s.scenario.objects.length })));
  const run = useSimStore(useShallow((s) => ({ phase: s.phase, events: s.events.length })));
  const { setScenario, runTest, reset, setScene } = useSimStore(useShallow((s) => ({ setScenario: s.setScenario, runTest: s.runTest, reset: s.reset, setScene: s.setScene })));
  const running = run.phase === "HOMING" || run.phase === "SCANNING" || run.phase === "DETECTING" || run.phase === "TRACKING";
  const env = ENVIRONMENTS[sc.environment];

  return (
    <div>
      <CardHead title="Test scenario" note="Water, light and detector settings apply immediately, including to a running test. Object positions are gantry cm." />
      <EnvironmentPicker value={sc.environment} onPick={(environment) => setScenario({ environment })} />
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 max-[759px]:grid-cols-1">
        <Slider label="Turbidity" value={sc.turbidity} min={0} max={1} step={0.05} show={turbidityLabel(env, sc.turbidity)} onChange={(v) => setScenario({ turbidity: v })} />
        <Slider label={env.lightingLabel} value={sc.lighting} min={0} max={1} step={0.05} show={f2(sc.lighting)} onChange={(v) => setScenario({ lighting: v })} />
        <Slider label="Detection threshold" value={sc.threshold} min={0.3} max={0.95} step={0.05} show={pct(sc.threshold, 0)} onChange={(v) => setScenario({ threshold: v })} />
        <Slider label="Gantry speed" value={sc.gantrySpeed} min={0.2} max={1} step={0.05} show={pct(sc.gantrySpeed, 0)} onChange={(v) => setScenario({ gantrySpeed: v })} />
      </div>
      <StrategyPicker />
      <div className="mt-3 grid grid-cols-2 gap-x-6 border-t border-line max-[759px]:grid-cols-1">
        {Array.from({ length: sc.count }, (_, i) => (
          <ObjectRow key={i} index={i} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn
          primary
          onClick={() => {
            runTest();
            setScene(4);
          }}
        >
          <Play size={14} /> Run test
        </Btn>
        <Btn onClick={reset}>
          <RotateCcw size={14} /> Reset scenario
        </Btn>
        {running && (
          <span className="value ml-auto text-[10px] text-teal">
            {run.phase}&nbsp;&nbsp;{run.events} events
          </span>
        )}
        {!running && <ViewResultLink className="ml-auto" />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 07 RESULT

/** Signed change against the previous run, or null when there is none. */
const delta = (cur: number, prev: number | undefined, fmt: (n: number) => string) => (prev === undefined ? null : cur === prev ? "no change" : fmt(cur - prev));

/** Metric grid plus the scenario line. Shared with the demo's RESULT phase. */
export function ResultMetrics({ result, previous }: { result: TestResult; previous: TestResult | null }) {
  const objects = useObjects();
  const targetLabel = objects.find((o) => o.id === result.targetId)?.label ?? "NONE";
  const p = previous ?? undefined;
  const env = ENVIRONMENTS[result.environment] ?? ENVIRONMENTS.tank; // results saved before environments existed are tank runs
  const metrics: [string, string, string | undefined, string | null][] = [
    ["Objects detected", pad2(result.objectsDetected), undefined, delta(result.objectsDetected, p?.objectsDetected, (d) => signed(d, 0))],
    ["Successful", pad2(result.successfulDetections), "text-teal", delta(result.successfulDetections, p?.successfulDetections, (d) => signed(d, 0))],
    ["False positives", pad2(result.falsePositives), result.falsePositives > 0 ? "text-amber" : undefined, delta(result.falsePositives, p?.falsePositives, (d) => signed(d, 0))],
    ["Avg confidence", pct(result.avgConfidence), undefined, delta(result.avgConfidence, p?.avgConfidence, (d) => signed(d * 100, 1) + "%")],
    ["Coverage", pct(result.coverage, 0), undefined, delta(result.coverage, p?.coverage, (d) => signed(d * 100, 0) + "%")],
    ["Episode reward", signed(result.episodeReward), result.episodeReward >= 0 ? "text-teal" : "text-danger", delta(result.episodeReward, p?.episodeReward, (d) => signed(d))],
    ["Duration", `${f1(result.durationS)} s`, undefined, delta(result.durationS, p?.durationS, (d) => signed(d, 1) + " s")],
    ["Target", targetLabel, "text-amber", null],
  ];
  return (
    <div>
      <div className="grid grid-cols-4 gap-px bg-line max-[759px]:grid-cols-2">
        {metrics.map(([k, v, tone, d]) => (
          <div key={k} className="bg-panel px-2 py-1.5">
            <div className="label text-[9px]">{k}</div>
            {/* object labels step down a size instead of wrapping onto a second line in a 1024 px card */}
            <div className={clsx("value truncate leading-tight", v.length > 14 ? "text-[11px]" : v.length > 9 ? "text-[12px]" : "text-[15px]", tone ?? "text-text")} title={v.length > 14 ? v : undefined}>
              {v}
            </div>
            {previous && <div className="value text-[9px] leading-tight text-dim">{d ?? " "}</div>}
          </div>
        ))}
      </div>
      {/* each name and value stays on one line; the pairs wrap as units in a narrow card */}
      <div className="value mt-1.5 flex flex-wrap items-baseline gap-x-3 text-[10px] text-muted">
        <span className="label">Scenario</span>
        <span className="whitespace-nowrap">{env.name}</span>
        <span className="whitespace-nowrap">turbidity {fmtNtu(environmentNtu(env, result.turbidity))}</span>
        <span className="whitespace-nowrap">light {f2(result.lighting)}</span>
        <span className="whitespace-nowrap">threshold {pct(result.threshold, 0)}</span>
        {result.strategy && (
          <span className="whitespace-nowrap">
            {STRATEGIES[result.strategy]?.name ?? result.strategy}: {result.viewpoints} views, {f1(result.pathCm / 100)} m travel
            {result.repositionGain !== null && result.repositionGain !== undefined ? `, re-centring ${signed(result.repositionGain * 100, 1)}%` : ""}
          </span>
        )}
        {result.missed?.length ? <span className="whitespace-nowrap">missed {result.missed.join(", ")}</span> : null}
        {previous && <span className="whitespace-nowrap text-dim">deltas vs previous run</span>}
      </div>
    </div>
  );
}

export function ResultCard() {
  const result = useSimStore((s) => s.result);
  const previous = useSimStore((s) => s.previousResult);
  const events = useSimStore((s) => s.events);
  const { runTest, replayTest, setShowVision, setScene } = useSimStore(useShallow((s) => ({ runTest: s.runTest, replayTest: s.replayTest, setShowVision: s.setShowVision, setScene: s.setScene })));
  const [showLog, setShowLog] = useState(false);
  const testing = useSimStore((s) => s.mode === "TEST");

  if (!result) {
    // a scan clears the shown result until it completes, and a stopped scan has none: say which, never "no test yet"
    const note = testing
      ? "A test is running. Its result appears here when it completes."
      : previous
        ? "The last test was stopped before it completed, so it has no result. Run it again."
        : "No test has run yet.";
    return (
      <div>
        <CardHead title="Test result" note={note} />
        <Btn
          primary
          onClick={() => {
            runTest();
            setScene(4);
          }}
        >
          <Play size={14} /> Run test
        </Btn>
      </div>
    );
  }

  const log = events.slice(-10);

  return (
    <div>
      <CardHead title="Test result" right={<span className="sim-tag">SIMULATED</span>} />
      <ResultMetrics result={result} previous={previous} />
      <button type="button" className="label mt-2 flex items-center gap-1.5 hover:text-text" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
        <span className="value text-[10px] text-dim">{showLog ? "-" : "+"}</span> Event log ({events.length > log.length ? `last ${log.length} of ${events.length}` : events.length})
      </button>
      {showLog && (
        <div className="mt-1 border border-line bg-ground/60 px-2 py-1">
          {log.map((e, i) => (
            <div key={i} className="grid grid-cols-[44px_1fr] gap-2 font-mono text-[10px] leading-[14px]">
              <span className="text-dim">{f1(e.t)} s</span>
              <span className={clsx(e.kind === "RESULT" ? "text-amber" : e.kind === "DETECT" || e.kind === "TARGET" ? "text-teal" : "text-muted")}>{e.text}</span>
            </div>
          ))}
        </div>
      )}
      <StrategyComparison />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn onClick={replayTest} title="Same seed, same scenario, same result.">
          <RotateCcw size={14} /> Replay test
        </Btn>
        <span className="text-[11px] text-muted max-[1259px]:hidden">Same seed, same scenario, same result.</span>
        <Btn primary className="ml-auto" onClick={() => setShowVision(true)}>
          Simulation to field
        </Btn>
      </div>
    </div>
  );
}

/**
 * Runs every inspection strategy headlessly on the current scenario and seed and tabulates the outcome.
 * Same water, objects and seed for each, so the rows differ only in where the camera was sent.
 */
function StrategyComparison() {
  const [rows, setRows] = useState<StrategyRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setRows([]);
    const scenario = useSimStore.getState().engine.scenario;
    await compareStrategies(structuredClone(scenario), undefined, (row) => setRows((r) => [...(r ?? []), row]));
    setBusy(false);
  };
  return (
    <div className="mt-2">
      <button type="button" className="label flex items-center gap-1.5 hover:text-text disabled:opacity-50" onClick={run} disabled={busy}>
        <span className="value text-[10px] text-dim">{busy ? "~" : "+"}</span> {busy ? "Comparing strategies" : "Compare inspection strategies"}
      </button>
      {rows && rows.length > 0 && (
        <div className="mt-1 overflow-x-auto border border-line bg-ground/60" role="region" aria-label="Strategy comparison">
          <table className="w-full font-mono text-[10px] leading-[15px]">
            <thead>
              <tr className="text-left text-dim">
                {["Strategy", "Found", "OK", "FP", "Avg conf", "Coverage", "Travel", "Time", "Cov/m"].map((h) => (
                  <th key={h} className="px-1.5 py-0.5 font-normal whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ strategy, result: r, efficiency }) => (
                <tr key={strategy} className="border-t border-line text-muted">
                  <td className="px-1.5 py-0.5 whitespace-nowrap text-text">{STRATEGIES[strategy].name}</td>
                  <td className="px-1.5">{r.objectsDetected}</td>
                  <td className="px-1.5 text-teal">{r.successfulDetections}</td>
                  <td className={clsx("px-1.5", r.falsePositives > 0 && "text-amber")}>{r.falsePositives}</td>
                  <td className="px-1.5">{pct(r.avgConfidence)}</td>
                  <td className="px-1.5">{pct(r.coverage, 0)}</td>
                  <td className="px-1.5 whitespace-nowrap">{f1(r.pathCm / 100)} m</td>
                  <td className="px-1.5 whitespace-nowrap">{f1(r.durationS)} s</td>
                  <td className="px-1.5">{f2(efficiency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-1.5 py-1 text-[10px] text-dim">SIMULATED. Same scenario and seed for every row. Heuristic controllers, not trained policies.</p>
        </div>
      )}
    </div>
  );
}
