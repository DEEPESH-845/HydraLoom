"use client";

import clsx from "clsx";
import { Cable, CircleStop, House, Printer, Unplug } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LineChart, RankBars, Seg, download } from "@/components/bench/charts";
import { EmptyState, KindTag, PageShell, Panel, inputCls } from "@/components/evaluation/ui";
import { WorkspaceNav } from "@/components/evaluation/WorkspaceNav";
import { readLocal, useInterval, writeLocal } from "@/lib/api/hooks";
import { NavState } from "@/lib/autonomy/nav";
import { NAV_WEIGHTS } from "@/lib/autonomy/nav-weights";
import { coveragePlan } from "@/lib/gantry/strategies";
import { TESTS, TEST_ORDER, buildReport, overall, parsePiLog, runTest, suggest, toCsv, twinMs, type HardwareReport, type Metric, type PiLog, type TestId, type TestRecord } from "@/lib/hardware/acceptance";
import { GrblEmulator, HEALTHY, WORN } from "@/lib/hardware/emulator";
import { GrblDriver, openWebSerial, webSerialAvailable } from "@/lib/hardware/grbl";
import { ARM_PHRASE, DEFAULT_LIMITS } from "@/lib/hardware/safety";
import { GANTRY, TEST } from "@/lib/sim/constants";

const STORE = "gantrylab.hardware.reports.v1";
const KEEP = 30;

function loadReports(): HardwareReport[] {
  try {
    const v = JSON.parse(readLocal(STORE) ?? "[]") as HardwareReport[];
    return Array.isArray(v) ? v.filter((r) => r?.schema === "gantrylab.hardware-report/1" && Array.isArray(r.tests)) : [];
  } catch {
    return [];
  }
}

interface GaugeAsk {
  prompt: string;
  resolve: (v: [number, number] | null) => void;
}

export function HardwareBench() {
  const [driver, setDriver] = useState<GrblDriver | null>(null);
  const [emu, setEmu] = useState<GrblEmulator | null>(null);
  const [, bump] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<TestRecord[]>([]);
  const [reports, setReports] = useState<HardwareReport[]>([]);
  const [open, setOpen] = useState<HardwareReport | null>(null);
  const [ask, setAsk] = useState<GaugeAsk | null>(null);
  const live = useRef<GrblDriver | null>(null);

  // saved reports exist only in the browser; read after mount so the server render matches
  useEffect(() => {
    const id = setTimeout(() => setReports(loadReports()), 0);
    return () => {
      clearTimeout(id);
      void live.current?.close();
    };
  }, []);
  useInterval(() => bump((n) => n + 1), 100, driver !== null);

  const connect = async (make: () => Promise<{ d: GrblDriver; e: GrblEmulator | null }>) => {
    setError(null);
    setConnecting(true);
    try {
      const { d, e } = await make();
      try {
        await d.start();
      } catch (err) {
        await d.close();
        throw err;
      }
      live.current = d;
      setDriver(d);
      setEmu(e);
      setTests([]);
    } catch (e) {
      // the browser's own port picker being dismissed is not an error
      if ((e as Error).name !== "NotFoundError") setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  };
  const connectEmulator = (worn: boolean) =>
    connect(async () => {
      const e = new GrblEmulator(worn ? WORN : HEALTHY).run();
      return { d: new GrblDriver(e), e };
    });
  const connectSerial = () => connect(async () => ({ d: new GrblDriver(await openWebSerial()), e: null }));
  const disconnect = async () => {
    await driver?.close();
    live.current = null;
    setDriver(null);
    setEmu(null);
    setBusy(null);
  };

  const act = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(`${label}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const save = (r: HardwareReport) => {
    const next = [r, ...reports.filter((x) => x.id !== r.id)].slice(0, KEEP);
    setReports(next);
    writeLocal(STORE, JSON.stringify(next));
    setOpen(r);
  };

  return (
    <PageShell testId="hardware">
      <WorkspaceNav active="hardware" />
      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-6 py-5 max-[759px]:px-4 max-[479px]:px-2 max-[479px]:py-3 print:max-w-none">
        <div className="print:hidden">
          <h1 className="text-[24px] font-medium leading-tight text-text max-[479px]:text-[20px]">Hardware bench</h1>
          <p className="mt-1 max-w-[84ch] text-[13px] leading-relaxed text-muted">Connect the physical gantry, run acceptance tests against the twin, and keep the reports. Every motion goes through the safety layer.</p>
        </div>
        {error && (
          <div role="alert" className="border border-danger/60 bg-danger/5 px-3 py-2 text-[12px] text-text print:hidden" data-testid="hw-error">
            {error}
          </div>
        )}
        {!driver ? (
          <Connect onSerial={connectSerial} onEmulator={connectEmulator} connecting={connecting} />
        ) : (
          <div className="grid grid-cols-[5fr_7fr] items-start gap-4 max-[1099px]:grid-cols-1 print:hidden">
            <div className="flex min-w-0 flex-col gap-4">
              <Machine driver={driver} busy={busy} act={act} onDisconnect={disconnect} />
              <Console driver={driver} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <LiveMap driver={driver} emu={emu} busy={busy} act={act} />
              <Acceptance driver={driver} emu={emu} busy={busy} act={act} tests={tests} setTests={setTests} setAsk={setAsk} onSave={save} />
            </div>
          </div>
        )}
        {open && <Report r={open} history={reports} onClose={() => setOpen(null)} />}
        <History reports={reports} open={open} onOpen={setOpen} onDelete={(id) => {
          const next = reports.filter((r) => r.id !== id);
          setReports(next);
          writeLocal(STORE, JSON.stringify(next));
          if (open?.id === id) setOpen(null);
        }} onImport={save} />
        <PiPanel />
      </main>
      {ask && <GaugeDialog key={ask.prompt} ask={ask} onDone={() => setAsk(null)} />}
    </PageShell>
  );
}

const noop = () => () => {};

function Connect({ onSerial, onEmulator, connecting }: { onSerial: () => void; onEmulator: (worn: boolean) => void; connecting: boolean }) {
  const serial = useSyncExternalStore(noop, webSerialAvailable, () => false);
  return (
    <div className="grid grid-cols-2 gap-4 max-[899px]:grid-cols-1 print:hidden">
      <Panel id="connect" label="Physical gantry" title="Connect over USB">
        <p className="max-w-[60ch] text-[13px] leading-relaxed text-muted">Arduino Uno with a CNC shield running GRBL 1.1 at 115200 baud. The controller&apos;s saved settings are read, never written.</p>
        <button type="button" className="btn btn-primary mt-3 inline-flex items-center gap-1.5" onClick={onSerial} disabled={!serial || connecting} data-testid="connect-serial">
          <Cable size={13} /> {connecting ? "Connecting" : "Choose port"}
        </button>
        {!serial && <p className="mt-2 text-[12px] text-amber">This browser has no Web Serial. Use Chrome or Edge on the computer the gantry is plugged into.</p>}
      </Panel>
      <Panel id="emulate" label="No machine attached" title="Use the emulated rig" right={<KindTag kind="simulated" />}>
        <p className="max-w-[60ch] text-[13px] leading-relaxed text-muted">The same protocol, driver and safety layer with a simulated machine behind them. The worn rig has backlash, a scale error, lost steps and a slow acceleration for the tests to find.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => onEmulator(false)} disabled={connecting} data-testid="connect-healthy">
            Healthy rig
          </button>
          <button type="button" className="btn" onClick={() => onEmulator(true)} disabled={connecting} data-testid="connect-worn">
            Worn rig
          </button>
        </div>
      </Panel>
    </div>
  );
}

type Act = (label: string, fn: () => Promise<unknown>) => Promise<void>;

function Machine({ driver, busy, act, onDisconnect }: { driver: GrblDriver; busy: string | null; act: Act; onDisconnect: () => void }) {
  const [phrase, setPhrase] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  const s = driver.status;
  const st = driver.supervisor.state;
  const p = driver.packet();
  const latched = st === "ESTOP" || st === "FAULT";
  return (
    <Panel
      id="machine"
      label={driver.kind === "serial" ? "Physical gantry" : "Emulated rig"}
      title={driver.closed ? "Link lost" : (s?.state ?? "Connecting")}
      right={
        <>
          <KindTag kind={driver.kind === "serial" ? "measured" : "simulated"} />
          <button type="button" className="btn inline-flex items-center gap-1.5 !py-1.5" onClick={onDisconnect}>
            <Unplug size={13} /> Disconnect
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => {
            driver.supervisor.emergencyStop(driver.now());
            void driver.stop();
          }}
          className="flex w-full items-center justify-center gap-2 border-2 border-danger bg-danger/15 px-4 py-3 font-mono text-[13px] font-semibold uppercase tracking-[0.12em] text-text hover:bg-danger/30"
          data-testid="estop"
        >
          <CircleStop size={16} /> Emergency stop
        </button>
        <dl className="grid grid-cols-3 gap-3">
          {(
            [
              ["X", Number.isFinite(p.x) ? `${p.x.toFixed(2)} cm` : "n/a"],
              ["Y", Number.isFinite(p.y) ? `${p.y.toFixed(2)} cm` : "n/a"],
              ["Safety", st],
              ["Homed", driver.homed ? "yes" : "no"],
              ["Limits", `${p.limitX0 ? "X0 " : ""}${p.limitY0 ? "Y0" : ""}` || "clear"],
              ["Round trip", driver.rtt.length ? `${driver.rtt.at(-1)!.toFixed(0)} ms` : "n/a"],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="label text-[9px]">{k}</dt>
              <dd className={clsx("value truncate text-[14px]", k === "Safety" ? (latched ? "text-danger" : st === "ARMED" ? "text-amber" : "text-text") : "text-text")} data-testid={`hw-${k.toLowerCase().replace(" ", "-")}`}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
        {latched ? (
          <div className="flex flex-wrap items-center gap-2 border border-danger/60 p-3 text-[12px] text-text">
            <span className="flex-1">{st} is latched. Check the machine, then reset. It returns to disarmed.</span>
            <button type="button" className="btn !py-1.5" onClick={() => setWhy(driver.supervisor.resetLatch(driver.now()).reason || null)} data-testid="reset-latch">
              Reset
            </button>
          </div>
        ) : st === "DISARMED" ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = driver.supervisor.arm(phrase, driver.now());
              setWhy(v.ok ? null : v.reason);
              if (v.ok) setPhrase("");
            }}
          >
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] text-muted">
              Hands clear of the belts? Type {ARM_PHRASE}
              <input className={inputCls} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" data-testid="arm-phrase" />
            </label>
            <button type="submit" className="btn btn-primary" data-testid="arm">
              Arm
            </button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => act("Home", () => driver.run({ kind: "HOME", source: "operator" }))} data-testid="home">
              <House size={13} /> {busy === "Home" ? "Homing" : "Home"}
            </button>
            <button type="button" className="btn" onClick={() => driver.supervisor.disarm(driver.now())}>
              Disarm
            </button>
            <MoveForm driver={driver} busy={busy} act={act} />
          </div>
        )}
        {why && <p className="text-[12px] text-amber">{why}</p>}
      </div>
    </Panel>
  );
}

function MoveForm({ driver, busy, act }: { driver: GrblDriver; busy: string | null; act: Act }) {
  const [x, setX] = useState("50");
  const [y, setY] = useState("20");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void act("Move", () => driver.run({ kind: "MOVE", x: Number(x), y: Number(y), speed: 10, source: "operator" }));
      }}
    >
      {(
        [
          ["X cm", x, setX, "move-x"],
          ["Y cm", y, setY, "move-y"],
        ] as const
      ).map(([l, v, set, id]) => (
        <label key={l} className="flex items-center gap-1 text-[12px] text-muted">
          {l}
          <input className={`${inputCls} !w-16`} value={v} onChange={(e) => set(e.target.value)} inputMode="decimal" data-testid={id} />
        </label>
      ))}
      <button type="submit" className="btn" disabled={!!busy || !driver.homed} data-testid="move">
        Move
      </button>
    </form>
  );
}

function Console({ driver }: { driver: GrblDriver }) {
  const log = driver.log.slice(-60).reverse();
  const safety = driver.supervisor.log.slice(-20).reverse();
  return (
    <Panel id="console" label="Link" title="Controller and safety log" note={driver.version ? `GRBL ${driver.version}` : undefined}>
      <div className="grid grid-cols-2 gap-4 max-[599px]:grid-cols-1">
        <ul className="value max-h-52 overflow-y-auto text-[10px] leading-relaxed" aria-label="Controller log">
          {log.map((e, i) => (
            <li key={i} className={clsx("break-all", e.dir === "tx" ? "text-teal" : e.dir === "note" ? "text-amber" : "text-muted")}>
              {e.dir === "tx" ? "> " : e.dir === "rx" ? "< " : "# "}
              {e.text}
            </li>
          ))}
        </ul>
        <ul className="value max-h-52 overflow-y-auto text-[10px] leading-relaxed" aria-label="Safety log" data-testid="safety-log">
          {safety.map((e, i) => (
            <li key={i} className={clsx("break-words", /REJECT|ESTOP|FAULT/.test(e.text) ? "text-danger" : "text-muted")}>
              {(e.t / 1000).toFixed(1)} s {e.text}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/** Viewpoints the learned planner chooses in an empty clear tank: no detections, so it is pure coverage. */
function learnedPlan(): [number, number][] {
  const state = new NavState({ environment: "tank", turbidity: 0.15, lighting: 0.8, gantrySpeed: 0.65, threshold: 0.6 });
  const out: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < 12; i++) {
    const { action } = state.plan(NAV_WEIGHTS, x, y, new Map());
    if (!action) break;
    state.visit(action);
    [x, y] = [action.x, action.y];
    out.push([x, y]);
  }
  return out;
}
const PLANS = { learned: learnedPlan, serpentine: () => TEST.scanWaypoints.map(([x, y]) => [x, y] as [number, number]), coverage: coveragePlan };
type PlanId = keyof typeof PLANS;

function LiveMap({ driver, emu, busy, act }: { driver: GrblDriver; emu: GrblEmulator | null; busy: string | null; act: Act }) {
  const [plan, setPlan] = useState<PlanId>("learned");
  const [approved, setApproved] = useState(false);
  const [done, setDone] = useState<{ ms: number; twin: number }[]>([]);
  const [pts, setPts] = useState<[number, number][]>(() => PLANS.learned());
  const p = driver.packet();
  const { min, max } = DEFAULT_LIMITS;
  const choose = (id: PlanId) => {
    setPlan(id);
    setPts(PLANS[id]());
    setDone([]);
    setApproved(false);
  };
  const fly = () =>
    act("Scan", async () => {
      setDone([]);
      const approvalId = `op-${Math.round(driver.now())}`;
      let [px, py] = [p.x, p.y];
      for (const [x, y] of pts) {
        const r = await driver.run({ kind: "MOVE", x, y, speed: 10, source: "controller", approvalId });
        setDone((d) => [...d, { ms: r.ms, twin: twinMs(Math.hypot(x - px, y - py), 10) }]);
        [px, py] = [x, y];
        await new Promise((f) => setTimeout(f, 300));
      }
      setApproved(false);
    });
  const ms = done.reduce((s, d) => s + d.ms, 0);
  const twin = done.reduce((s, d) => s + d.twin, 0);
  return (
    <Panel id="map" label="Digital twin" title="Reported position and scan plans" note={emu ? undefined : "GRBL is open loop: this is the commanded position, not a measurement."} right={<Seg label="Plan" value={plan} onChange={choose} options={[{ id: "learned", label: "Learned" }, { id: "serpentine", label: "Serpentine" }, { id: "coverage", label: "Coverage" }]} />}>
      <svg viewBox={`-4 -4 ${GANTRY.travelX + 8} ${GANTRY.travelY + 8}`} className="block w-full border border-line bg-ground" role="img" aria-label={`Gantry at X ${p.x.toFixed(1)}, Y ${p.y.toFixed(1)} cm`} data-testid="hw-map">
        <rect x={0} y={0} width={GANTRY.travelX} height={GANTRY.travelY} fill="#101922" stroke="#34465a" strokeWidth={0.3} />
        <rect x={min[0]} y={min[1]} width={max[0] - min[0]} height={max[1] - min[1]} fill="none" stroke="#34465a" strokeWidth={0.2} strokeDasharray="1 1" />
        <polyline points={pts.map((q) => q.join(",")).join(" ")} fill="none" stroke="#738496" strokeWidth={0.3} strokeDasharray="1 0.8" />
        {pts.map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r={1} fill={i < done.length ? "#3db9b0" : "#0b1219"} stroke="#3db9b0" strokeWidth={0.3} />
            <text x={x + 1.6} y={y - 1} fontSize={2} fill="#8b98a5" className="value">
              {i + 1}
            </text>
          </g>
        ))}
        {Number.isFinite(p.x) && Number.isFinite(p.y) && (
          <g style={{ transform: `translate(${p.x}px, ${p.y}px)` }}>
            <circle r={1.8} fill="none" stroke="#f2a93b" strokeWidth={0.5} />
            <line x1={-3} x2={3} y1={0} y2={0} stroke="#f2a93b" strokeWidth={0.3} />
            <line x1={0} x2={0} y1={-3} y2={3} stroke="#f2a93b" strokeWidth={0.3} />
          </g>
        )}
      </svg>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12px] text-text">
          <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} data-testid="approve-plan" />
          I approve these {pts.length} moves
        </label>
        <button type="button" className="btn btn-primary" disabled={!approved || !!busy || !driver.homed} onClick={fly} data-testid="fly-plan">
          {busy === "Scan" ? `Viewpoint ${Math.min(done.length + 1, pts.length)} of ${pts.length}` : "Run plan"}
        </button>
        {!driver.homed && <span className="text-[12px] text-dim">Arm and home first.</span>}
        {done.length > 0 && (
          <span className="value text-[12px] text-muted" data-testid="plan-timing">
            {done.length} of {pts.length}: {(ms / 1000).toFixed(1)} s, twin {(twin / 1000).toFixed(1)} s
          </span>
        )}
      </div>
    </Panel>
  );
}

function fmtMetric(m: Metric) {
  return m.value === null ? "not measured" : `${Math.abs(m.value) >= 100 || Number.isInteger(m.value) ? m.value.toFixed(0) : m.value.toFixed(2)} ${m.unit}`;
}

function VerdictTag({ v }: { v: Metric["verdict"] }) {
  return <span className={clsx("sim-tag whitespace-nowrap", v === "pass" ? "!border-ok/70 !text-ok" : v === "fail" ? "!border-danger/70 !text-danger" : "")}>{v === "pass" ? "PASS" : v === "fail" ? "FAIL" : v === "info" ? "INFO" : "NOT MEASURED"}</span>;
}

function Acceptance({ driver, emu, busy, act, tests, setTests, setAsk, onSave }: { driver: GrblDriver; emu: GrblEmulator | null; busy: string | null; act: Act; tests: TestRecord[]; setTests: React.Dispatch<React.SetStateAction<TestRecord[]>>; setAsk: (a: GaugeAsk | null) => void; onSave: (r: HardwareReport) => void }) {
  const [picked, setPicked] = useState<TestId[]>([...TEST_ORDER]);
  const [gauge, setGauge] = useState(true);
  const [progress, setProgress] = useState<{ id: TestId; f: number } | null>(null);
  const [notes, setNotes] = useState("");
  const run = () =>
    act("Acceptance", async () => {
      const read = !gauge
        ? null
        : emu
          ? async () => emu.readTrue()
          : (prompt: string) =>
              new Promise<[number, number] | null>((resolve) =>
                setAsk({
                  prompt,
                  resolve: (v) => {
                    setAsk(null);
                    resolve(v);
                  },
                }),
              );
      for (const id of TEST_ORDER.filter((t) => picked.includes(t))) {
        setProgress({ id, f: 0 });
        const rec = await runTest(id, driver, read, (f) => setProgress({ id, f }));
        setTests((all) => [...all.filter((t) => t.id !== id), rec]);
        if (driver.supervisor.state !== "ARMED" || driver.closed) break;
      }
      setProgress(null);
    });
  const ready = driver.homed && driver.supervisor.state === "ARMED";
  return (
    <Panel id="acceptance" label="Acceptance" title="Tests against the specification" right={emu ? <KindTag kind="simulated" /> : <KindTag kind="measured" />}>
      <ul className="flex flex-col">
        {TEST_ORDER.map((id) => {
          const rec = tests.find((t) => t.id === id);
          const on = progress?.id === id;
          return (
            <li key={id} className="flex flex-col gap-1.5 border-b border-line py-2 last:border-b-0" data-testid={`test-${id}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="flex items-center gap-2 text-[13px] text-text">
                  <input type="checkbox" checked={picked.includes(id)} disabled={!!busy} onChange={() => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))} />
                  {TESTS[id].name}
                </label>
                {TESTS[id].needsGauge && <span className="sim-tag">GAUGE</span>}
                {on && <span className="value text-[11px] text-amber">{Math.round(progress.f * 100)}%</span>}
              </div>
              <p className="text-[12px] leading-snug text-muted">{TESTS[id].what}</p>
              {rec && (
                <ul className="flex flex-col gap-1">
                  {rec.metrics.map((m) => (
                    <li key={m.name} className="flex flex-wrap items-center gap-2 text-[12px]">
                      <VerdictTag v={m.verdict} />
                      <span className="text-muted">{m.name}</span>
                      <span className="value text-text">{fmtMetric(m)}</span>
                      {m.limit && <span className="value text-[11px] text-dim">limit {m.limit}</span>}
                    </li>
                  ))}
                  {rec.findings.map((f) => (
                    <li key={f} className={clsx("text-[12px] leading-snug", rec.error ? "text-danger" : "text-muted")}>
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12px] text-text">
          <input type="checkbox" checked={gauge} onChange={(e) => setGauge(e.target.checked)} disabled={!!busy} />
          {emu ? "Read the emulated gauge" : "I have a gauge on the carriage"}
        </label>
        <button type="button" className="btn btn-primary" disabled={!ready || !!busy || !picked.length} onClick={run} data-testid="run-tests">
          {busy === "Acceptance" ? "Testing" : `Run ${picked.length} tests`}
        </button>
        {!ready && <span className="text-[12px] text-dim">Arm and home first.</span>}
      </div>
      {tests.length > 0 && !busy && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[12px] text-muted">
            Notes for the report
            <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={400} />
          </label>
          <button type="button" className="btn" onClick={() => onSave(buildReport(driver, tests, emu ? "Emulated rig" : "Physical gantry", notes))} data-testid="save-report">
            Save report
          </button>
        </div>
      )}
    </Panel>
  );
}

function GaugeDialog({ ask, onDone }: { ask: GaugeAsk; onDone: () => void }) {
  const [v, setV] = useState("");
  const num = Number(v.replace(",", "."));
  const ok = v.trim() !== "" && Number.isFinite(num);
  // both axes get the same number: each test reads only the axis it asked about
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="gauge-title" className="fixed inset-0 z-40 flex items-center justify-center bg-ground/80 p-4">
      <form
        className="panel w-full max-w-[420px] p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) {
            onDone();
            ask.resolve([num, num]);
          }
        }}
      >
        <h2 id="gauge-title" className="text-[14px] leading-snug text-text">
          {ask.prompt}
        </h2>
        <input className={`${inputCls} mt-3`} value={v} onChange={(e) => setV(e.target.value)} autoFocus inputMode="decimal" aria-label="Gauge reading, mm" />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => {
              onDone();
              ask.resolve(null);
            }}
          >
            Cancel test
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ok}>
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------- reports ---------- */

function Report({ r, history, onClose }: { r: HardwareReport; history: HardwareReport[]; onClose: () => void }) {
  const o = overall(r);
  const timing = r.tests.find((t) => t.id === "timing" && t.rows.length);
  const rep = r.tests.find((t) => t.id === "repeatability" && t.rows.length);
  const stop = r.tests.find((t) => t.id === "stop" && t.rows.length);
  const same = history.filter((h) => h.source === r.source && h.rig === r.rig).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const trend = (test: TestId, name: string): [number, number][] =>
    same.flatMap((h, i) => {
      const v = h.tests.find((t) => t.id === test)?.metrics.find((m) => m.name === name)?.value;
      return v === null || v === undefined ? [] : [[i + 1, v] as [number, number]];
    });
  const trends = [
    { title: "Backlash, mm", pts: trend("repeatability", "Backlash") },
    { title: "Drift after 24 moves, mm", pts: trend("endurance", "Drift after 24 moves") },
  ].filter((t) => t.pts.length > 1);
  const suggestions = suggest(r.tests, r.settings);
  return (
    <Panel
      id="report"
      testId="hw-report"
      label={`Report ${r.id}`}
      title={<span className={o.verdict === "ACCEPTED" ? "text-ok" : o.verdict === "NOT ACCEPTED" ? "text-danger" : "text-amber"}>{o.verdict}</span>}
      note={`${r.rig}, ${r.createdAt.slice(0, 16).replace("T", " ")} UTC${r.firmware ? `, GRBL ${r.firmware}` : ""}. ${o.pass} passed, ${o.fail} failed, ${o.unmeasured} not measured.`}
      right={
        <span className="flex flex-wrap gap-1.5 print:hidden">
          <KindTag kind={r.source} />
          <button type="button" className="btn !py-1.5" onClick={() => download(`${r.id}.json`, JSON.stringify(r, null, 2))}>
            JSON
          </button>
          <button type="button" className="btn !py-1.5" onClick={() => download(`${r.id}.csv`, toCsv(r), "text/csv")}>
            CSV
          </button>
          <button type="button" className="btn inline-flex items-center gap-1.5 !py-1.5" onClick={() => window.print()}>
            <Printer size={13} /> Print
          </button>
          <button type="button" className="btn !py-1.5" onClick={onClose}>
            Close
          </button>
        </span>
      }
    >
      {r.source === "simulated" && <p className="mb-4 border border-danger/60 px-3 py-2 text-[12px] text-text">SIMULATED: these rows came from the emulated rig. They are not evidence about the physical machine.</p>}
      <div className="grid grid-cols-2 items-start gap-5 max-[1099px]:grid-cols-1">
        <section>
          <h3 className="label mb-2">Results</h3>
          <table className="w-full text-left text-[12px]">
            <tbody>
              {r.tests.flatMap((t) =>
                t.metrics.map((m) => (
                  <tr key={t.id + m.name} className="border-t border-line">
                    <td className="py-1.5 pr-2">
                      <VerdictTag v={m.verdict} />
                    </td>
                    <td className="py-1.5 pr-2 text-muted">
                      {t.name}: {m.name}
                    </td>
                    <td className="value whitespace-nowrap py-1.5 text-right text-text">{fmtMetric(m)}</td>
                    <td className="value whitespace-nowrap py-1.5 pl-2 text-right text-dim">{m.limit ?? ""}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          {r.notes && <p className="mt-3 text-[12px] text-muted">Notes: {r.notes}</p>}
        </section>
        <section>
          <h3 className="label mb-2">What to change on the machine</h3>
          {suggestions.length === 0 ? (
            <p className="text-[12px] text-muted">Nothing: every measured value is inside its limit.</p>
          ) : (
            <ol className="flex flex-col gap-2" data-testid="hw-suggestions">
              {suggestions.map((s) => (
                <li key={s.title} className="border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={clsx("sim-tag", s.severity === "high" ? "!border-danger/70 !text-danger" : s.severity === "medium" ? "!border-amber/70 !text-amber" : "")}>{s.severity.toUpperCase()}</span>
                    <span className="text-[13px] font-medium text-text">{s.title}</span>
                  </div>
                  <p className="value mt-1.5 break-words border-l-2 border-amber/70 pl-2 text-[11px] leading-relaxed text-text">{s.change}</p>
                  <p className="mt-1.5 text-[12px] leading-snug text-muted">{s.evidence}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
        {timing && (
          <section>
            <h3 className="label mb-2">Move time against the twin, seconds</h3>
            <RankBars
              format={(v) => `${v.toFixed(2)} s`}
              rows={timing.rows.flatMap((row) => [
                { name: `${row[0]} cm at ${row[1]} cm/s, machine`, value: row[2]! / 1000, color: "#3987e5", strong: true },
                { name: "twin", value: row[3]! / 1000, color: "#34465a" },
              ]).map((x, i) => ({ ...x, name: i % 2 ? `twin, move ${(i + 1) / 2}` : x.name }))}
            />
          </section>
        )}
        {rep && (
          <section>
            <h3 className="label mb-2">Position error at X 50 cm by approach side</h3>
            <LineChart
              label="Gauge error at each visit, split by approach side"
              xLabel="visit"
              yLabel="error, mm"
              height={190}
              series={[
                { name: "from the left", color: "#3987e5", points: rep.rows.filter((x) => x[1] === 1).map((x) => [x[0]!, x[3]!]) },
                { name: "from the right", color: "#d95926", points: rep.rows.filter((x) => x[1] === -1).map((x) => [x[0]!, x[3]!]) },
              ]}
            />
          </section>
        )}
        {stop && (
          <section>
            <h3 className="label mb-2">Distance to rest after a stop, cm</h3>
            <RankBars format={(v) => `${v.toFixed(2)} cm`} rows={stop.rows.map((x) => ({ name: `Trial ${x[0]}`, value: x[1]!, color: "#3987e5", note: `${x[2]!.toFixed(0)} ms` }))} />
          </section>
        )}
        {trends.map((t) => (
          <section key={t.title}>
            <h3 className="label mb-2">{t.title}, over {t.pts.length} reports</h3>
            <LineChart label={t.title} xLabel="report" yLabel="mm" height={170} series={[{ name: t.title, color: "#3987e5", points: t.pts }]} />
          </section>
        ))}
      </div>
    </Panel>
  );
}

function History({ reports, open, onOpen, onDelete, onImport }: { reports: HardwareReport[]; open: HardwareReport | null; onOpen: (r: HardwareReport) => void; onDelete: (id: string) => void; onImport: (r: HardwareReport) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    try {
      const r = JSON.parse(await f.text()) as HardwareReport;
      if (r?.schema !== "gantrylab.hardware-report/1" || typeof r.id !== "string" || !Array.isArray(r.tests) || !r.tests.every((t) => Array.isArray(t.metrics) && Array.isArray(t.rows) && Array.isArray(t.findings)) || typeof r.settings !== "object") throw new Error("not a GANTRYLAB hardware report");
      onImport(r);
    } catch (e) {
      setErr(`Could not import ${f.name}: ${(e as Error).message}`);
    }
  };
  return (
    <Panel
      id="reports"
      label="Reports"
      title="Hardware reports"
      note="Kept in this browser. Export the JSON to share or archive one."
      className="print:hidden"
      right={
        <label className="btn cursor-pointer !py-1.5">
          Import
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void importFile(e.target.files?.[0])} />
        </label>
      }
    >
      {err && <p className="mb-2 text-[12px] text-danger">{err}</p>}
      {reports.length === 0 ? (
        <EmptyState title="No reports yet">Connect a machine, run the acceptance tests and save the report.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[12px]" data-testid="hw-history">
            <tbody>
              {reports.map((r) => {
                const o = overall(r);
                return (
                  <tr key={r.id} className={clsx("border-t border-line", open?.id === r.id && "bg-panel-2")}>
                    <td className="value whitespace-nowrap py-2 pr-3 text-muted">{r.createdAt.slice(0, 16).replace("T", " ")}</td>
                    <td className="py-2 pr-3 text-text">{r.rig}</td>
                    <td className="py-2 pr-3">
                      <KindTag kind={r.source} />
                    </td>
                    <td className={clsx("whitespace-nowrap py-2 pr-3", o.verdict === "ACCEPTED" ? "text-ok" : o.verdict === "NOT ACCEPTED" ? "text-danger" : "text-amber")}>{o.verdict}</td>
                    <td className="value whitespace-nowrap py-2 pr-3 text-muted">
                      {o.pass} pass, {o.fail} fail
                    </td>
                    <td className="py-2 text-right">
                      <button type="button" className="btn !px-2 !py-1" onClick={() => onOpen(r)}>
                        Open
                      </button>{" "}
                      <button type="button" className="btn !px-2 !py-1" onClick={() => onDelete(r.id)} aria-label={`Delete report ${r.id}`}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function PiPanel() {
  const [log, setLog] = useState<{ name: string; v: PiLog } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async (f: File | undefined) => {
    if (!f) return;
    try {
      setLog({ name: f.name, v: parsePiLog(await f.text()) });
      setErr(null);
    } catch (e) {
      setLog(null);
      setErr(`${f.name}: ${(e as Error).message}`);
    }
  };
  const bin = log ? Math.max(1, Math.floor(log.v.rows.length / 120)) : 1;
  const thin = log ? log.v.rows.filter((_, i) => i % bin === 0) : [];
  const temps = thin.filter((r) => r.temp !== null);
  return (
    <Panel
      id="pi"
      label="Raspberry Pi"
      title="Vision computer log"
      className="print:hidden"
      note="Run backend/pi_bench.py on the Pi with your model, then load the CSV here."
      right={
        <label className="btn cursor-pointer !py-1.5">
          Load CSV
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void load(e.target.files?.[0])} data-testid="pi-file" />
        </label>
      }
    >
      {err && <p className="text-[12px] text-danger">{err}</p>}
      {!log ? (
        !err && <p className="text-[12px] text-muted">No log loaded.</p>
      ) : (
        <div className="flex flex-col gap-4" data-testid="pi-result">
          <dl className="grid grid-cols-6 gap-3 max-[899px]:grid-cols-3">
            {(
              [
                ["Frames", String(log.v.frames)],
                ["Median", `${log.v.p50.toFixed(0)} ms`],
                ["95th percentile", `${log.v.p95.toFixed(0)} ms`],
                ["Rate", `${log.v.fps.toFixed(1)} fps`],
                ["Hottest", log.v.maxTempC === null ? "n/a" : `${log.v.maxTempC.toFixed(0)} C`],
                ["Throttled frames", String(log.v.throttled)],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="label text-[9px]">{k}</dt>
                <dd className="value text-[16px] text-text">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[12px] text-muted">
            {log.v.throttled > 0 || log.v.slowdown > 1.15 ? `The Pi slows down as it heats: the last quarter runs ${Math.round((log.v.slowdown - 1) * 100)}% slower than the first. Fit a heatsink and fan, or run a smaller model.` : "Latency is steady through the run."}
          </p>
          <div className="grid grid-cols-2 gap-5 max-[899px]:grid-cols-1">
            <LineChart label="Frame latency over time" xLabel="seconds" yLabel="latency, ms" height={170} digits={0} series={[{ name: "Latency", color: "#3987e5", points: thin.map((r) => [r.t, r.ms]) }]} />
            {temps.length > 1 && <LineChart label="Temperature over time" xLabel="seconds" yLabel="temperature, C" height={170} digits={1} series={[{ name: "Temperature", color: "#d95926", points: temps.map((r) => [r.t, r.temp!]) }]} />}
          </div>
        </div>
      )}
    </Panel>
  );
}
