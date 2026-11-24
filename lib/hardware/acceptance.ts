// Acceptance tests of the physical gantry against docs/BLUEPRINT.md section 2, and the analysis of what they show.
// Each test drives the machine only through the safety link. GRBL is open loop: it reports the commanded position, so
// anything about the TRUE position needs an outside reading (dial gauge, calliper or the overhead camera) and is
// reported as not measured without one.

import { GANTRY } from "../sim/constants";
import type { GrblDriver } from "./grbl";

export type Verdict = "pass" | "fail" | "info" | "not measured";

export interface Metric {
  name: string;
  value: number | null;
  unit: string;
  /** acceptance limit, e.g. "<= 1.5" */
  limit: string | null;
  verdict: Verdict;
}

export interface TestRecord {
  id: TestId;
  name: string;
  startedAt: string;
  metrics: Metric[];
  /** raw rows behind the metrics, for charts and CSV */
  columns: string[];
  rows: (number | null)[][];
  findings: string[];
  error: string | null;
}

export interface Suggestion {
  title: string;
  change: string;
  evidence: string;
  severity: "high" | "medium" | "low";
}

export interface HardwareReport {
  schema: "gantrylab.hardware-report/1";
  id: string;
  createdAt: string;
  /** "measured" only when a real serial machine produced the rows */
  source: "measured" | "simulated";
  rig: string;
  firmware: string | null;
  settings: Record<string, number>;
  tests: TestRecord[];
  suggestions: Suggestion[];
  notes: string;
}

export type TestId = "link" | "timing" | "stop" | "repeatability" | "scale" | "endurance";

export const TESTS: Record<TestId, { name: string; what: string; needsGauge: boolean }> = {
  link: { name: "Link latency", what: "40 status round trips. The safety heartbeat times out at 500 ms.", needsGauge: false },
  timing: { name: "Motion against the twin", what: "Moves of 5 to 80 cm; measured time against the simulated gantry's trapezoid.", needsGauge: false },
  stop: { name: "Emergency stop", what: "Feed hold at full speed: time and distance to rest.", needsGauge: false },
  repeatability: { name: "Repeatability and backlash", what: "Ten visits to X 50 cm from alternating sides, read on a gauge.", needsGauge: true },
  scale: { name: "Travel scale", what: "10 to 90 cm on X, 5 to 35 cm on Y, measured against commanded.", needsGauge: true },
  endurance: { name: "Endurance", what: "24 moves over the bed, then back to the reference: lost steps show as drift.", needsGauge: true },
};
export const TEST_ORDER = Object.keys(TESTS) as TestId[];

/** Reads the true carriage position, mm work coordinates, or null when nobody can measure it. */
export type Gauge = (prompt: string) => Promise<[number, number] | null>;

/** The twin's time for a move, ms. */
export function twinMs(cm: number, speed: number): number {
  const a = GANTRY.accel;
  return (cm <= (speed * speed) / a ? 2 * Math.sqrt(cm / a) : cm / speed + speed / a) * 1000;
}

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
const sd = (v: number[]) => (v.length < 2 ? 0 : Math.sqrt(v.reduce((s, x) => s + (x - mean(v)) ** 2, 0) / (v.length - 1)));
export const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};

const metric = (name: string, value: number | null, unit: string, max: number | null): Metric => ({
  name,
  value,
  unit,
  limit: max === null ? null : `<= ${max}`,
  verdict: value === null ? "not measured" : max === null ? "info" : value <= max ? "pass" : "fail",
});

/** Acceptance limits. BLUEPRINT: 0.15 cm arrival tolerance, 15 cm/s, 30 cm/s^2, 500 ms heartbeat. */
export const LIMITS = { rttP95Ms: 100, timingErrorPct: 4, stopCm: 4.5, repeatabilityMm: 0.5, backlashMm: 0.5, scalePct: 0.3, driftMm: 0.5 };

const FULL = GANTRY.maxSpeed;

export async function runTest(id: TestId, d: GrblDriver, gauge: Gauge | null, onProgress: (f: number) => void): Promise<TestRecord> {
  const rec: TestRecord = { id, name: TESTS[id].name, startedAt: new Date().toISOString(), metrics: [], columns: [], rows: [], findings: [], error: null };
  const go = (x: number, y: number, speed = 10) => d.run({ kind: "MOVE", x, y, speed, source: "operator" });
  try {
    if (TESTS[id].needsGauge && !gauge) {
      rec.findings.push("Skipped: GRBL is open loop, so the true position needs a gauge reading.");
      rec.metrics.push({ name: "Result", value: null, unit: "", limit: null, verdict: "not measured" });
      return rec;
    }
    switch (id) {
      case "link": {
        rec.columns = ["sample", "rtt ms"];
        const before = d.rtt.length;
        for (let i = 0; i < 40; i++) {
          await d.nextStatus();
          onProgress((i + 1) / 40);
        }
        const v = d.rtt.slice(Math.min(before, d.rtt.length - 1)).slice(-40);
        v.forEach((ms, i) => rec.rows.push([i, ms]));
        rec.metrics.push(metric("Round trip, median", quantile(v, 0.5), "ms", null), metric("Round trip, 95th percentile", quantile(v, 0.95), "ms", LIMITS.rttP95Ms));
        break;
      }
      case "timing": {
        rec.columns = ["distance cm", "speed cm/s", "measured ms", "twin ms", "error %"];
        const plan: [number, number][] = [[5, 10], [10, 10], [20, 10], [40, 12], [80, FULL], [80, 8]];
        await go(10, 20);
        for (let i = 0; i < plan.length; i++) {
          const [cm, sp] = plan[i];
          const out = await go(10 + cm, 20, sp);
          const twin = twinMs(cm, sp);
          rec.rows.push([cm, sp, out.ms, twin, ((out.ms - twin) / twin) * 100]);
          await go(10, 20);
          onProgress((i + 1) / plan.length);
        }
        // the poll interval blurs each time by up to one period, so only longer moves judge the machine
        const long = rec.rows.filter((r) => r[3]! > 1500).map((r) => r[4]!);
        rec.metrics.push(metric("Time error on moves over 1.5 s, mean", Math.abs(mean(long)), "%", LIMITS.timingErrorPct), metric("Worst move", Math.max(...rec.rows.map((r) => Math.abs(r[4]!))), "%", null));
        if (mean(long) > LIMITS.timingErrorPct) rec.findings.push(`Moves take ${mean(long).toFixed(0)}% longer than the twin: the controller's acceleration or maximum rate is below the specification.`);
        break;
      }
      case "stop": {
        rec.columns = ["trial", "distance to rest cm", "time to rest ms"];
        for (let i = 0; i < 3; i++) {
          await go(10, 20);
          const r = d.link.submit({ kind: "MOVE", x: 90, y: 20, speed: FULL, source: "operator" }, d.now());
          if (!r.ok) throw new Error(r.reason);
          let s = await d.nextStatus();
          while ((s.x ?? 0) < 400) {
            if (s.state.startsWith("Alarm") || d.closed) throw new Error(d.closed ?? s.state);
            s = await d.nextStatus();
          }
          const x0 = s.x!;
          const t0 = d.now();
          await d.stop();
          while (s.state !== "Hold:0" && s.state !== "Idle") s = await d.nextStatus();
          rec.rows.push([i + 1, ((s.x ?? x0) - x0) / 10, d.now() - t0]);
          while (s.state !== "Idle") s = await d.nextStatus();
          onProgress((i + 1) / 3);
        }
        rec.metrics.push(metric("Distance to rest, worst", Math.max(...rec.rows.map((r) => r[1]!)), "cm", LIMITS.stopCm), metric("Time to rest, worst", Math.max(...rec.rows.map((r) => r[2]!)), "ms", null));
        rec.findings.push(`At ${FULL} cm/s and ${GANTRY.accel} cm/s^2 the ideal stop is ${((FULL * FULL) / (2 * GANTRY.accel)).toFixed(2)} cm; the rest is link delay. This is the software stop: the mains E-stop must be tested by hand.`);
        break;
      }
      case "repeatability": {
        rec.columns = ["visit", "approach (+1 from left, -1 from right)", "read mm", "error mm"];
        const left: number[] = [];
        const right: number[] = [];
        for (let i = 0; i < 10; i++) {
          const fromLeft = i % 2 === 0;
          await go(fromLeft ? 40 : 60, 20);
          await go(50, 20);
          const g = await gauge!(`Visit ${i + 1} of 10: carriage at X 50 cm. Enter the gauge X reading, mm from home.`);
          if (!g) throw new Error("cancelled at the gauge");
          (fromLeft ? left : right).push(g[0]);
          rec.rows.push([i + 1, fromLeft ? 1 : -1, g[0], g[0] - 500]);
          onProgress((i + 1) / 10);
        }
        // a trend over the visits is drift (lost steps), not scatter, so it is removed before judging repeatability
        const detrend = (v: number[]) => {
          const n = v.length;
          const mx = (n - 1) / 2;
          const slope = v.reduce((s, y, k) => s + (k - mx) * (y - mean(v)), 0) / v.reduce((s, _, k) => s + (k - mx) ** 2, 0);
          return v.map((y, k) => y - slope * (k - mx));
        };
        rec.metrics.push(
          metric("Repeatability, 2 sigma, one direction", 2 * Math.max(sd(detrend(left)), sd(detrend(right))), "mm", LIMITS.repeatabilityMm),
          metric("Backlash", Math.abs(mean(right) - mean(left)), "mm", LIMITS.backlashMm),
        );
        break;
      }
      case "scale": {
        rec.columns = ["axis (0 X, 1 Y)", "commanded mm", "measured mm", "error %"];
        // both ends approached from the same side, so backlash cancels
        for (const [axis, a, b, via] of [[0, 10, 90, 5], [1, 5, 35, 2]] as const) {
          const at = (v: number) => (axis === 0 ? go(v, 20) : go(50, v));
          await at(via);
          await at(a);
          const g0 = await gauge!(`Axis ${"XY"[axis]} at ${a} cm. Enter its gauge reading, mm from home.`);
          await at(b);
          const g1 = await gauge!(`Axis ${"XY"[axis]} at ${b} cm. Enter its gauge reading, mm from home.`);
          if (!g0 || !g1) throw new Error("cancelled at the gauge");
          const cmd = (b - a) * 10;
          const got = g1[axis] - g0[axis];
          rec.rows.push([axis, cmd, got, ((got - cmd) / cmd) * 100]);
          onProgress((axis + 1) / 2);
        }
        rec.metrics.push(metric("X scale error", Math.abs(rec.rows[0][3]!), "%", LIMITS.scalePct), metric("Y scale error", Math.abs(rec.rows[1][3]!), "%", LIMITS.scalePct));
        break;
      }
      case "endurance": {
        rec.columns = ["move", "x cm", "y cm", "measured ms", "twin ms"];
        await go(20, 20);
        await go(30, 20);
        const g0 = await gauge!("Reference: carriage at X 30 cm. Enter the gauge X reading, mm from home.");
        let px = 30;
        let py = 20;
        for (let i = 0; i < 24; i++) {
          const x = 5 + ((i * 37) % 91);
          const y = 4 + ((i * 17) % 33);
          const r = await go(x, y, 12);
          rec.rows.push([i + 1, x, y, r.ms, twinMs(Math.hypot(x - px, y - py), 12)]);
          [px, py] = [x, y];
          onProgress((i + 1) / 25);
        }
        await go(20, 20);
        await go(30, 20);
        const g1 = await gauge!("Back at the reference, X 30 cm. Enter the gauge X reading, mm from home.");
        if (!g0 || !g1) throw new Error("cancelled at the gauge");
        onProgress(1);
        rec.metrics.push(metric("Drift after 24 moves", Math.abs(g1[0] - g0[0]), "mm", LIMITS.driftMm), metric("Moves completed", 24, "", null));
        break;
      }
    }
  } catch (e) {
    rec.error = (e as Error).message;
    rec.findings.push(`Stopped: ${rec.error}`);
  }
  return rec;
}

/** Specific changes to the machine, each from a measured row. */
export function suggest(tests: TestRecord[], settings: ReadonlyMap<string, number> | Record<string, number>): Suggestion[] {
  const get = (k: string) => (settings instanceof Map ? settings.get(k) : (settings as Record<string, number>)[k]);
  const out: Suggestion[] = [];
  const t = (id: TestId) => tests.filter((x) => x.id === id && !x.error).at(-1);
  const m = (id: TestId, name: string) => t(id)?.metrics.find((x) => x.name === name);
  const scale = t("scale");
  if (scale)
    for (const r of scale.rows) {
      const key = r[0] === 0 ? "100" : "101";
      const now = get(key);
      if (Math.abs(r[3]!) <= LIMITS.scalePct / 3 || now === undefined) continue;
      const next = (now * r[1]!) / r[2]!;
      out.push({ title: `Recalibrate ${r[0] === 0 ? "X" : "Y"} steps per mm`, change: `$${key}=${next.toFixed(3)} (now ${now.toFixed(3)})`, evidence: `Commanded ${r[1]!.toFixed(0)} mm, measured ${r[2]!.toFixed(2)} mm (${r[3]! > 0 ? "+" : ""}${r[3]!.toFixed(2)}%).`, severity: Math.abs(r[3]!) > LIMITS.scalePct ? "high" : "low" });
    }
  const back = m("repeatability", "Backlash");
  if (back?.value != null && back.value > LIMITS.backlashMm) out.push({ title: "Take up the X backlash", change: "Re-tension the GT2 belt and check the pulley grub screws; until then approach every viewpoint from the same side", evidence: `Readings from the two sides differ by ${back.value.toFixed(2)} mm (limit ${LIMITS.backlashMm}).`, severity: "high" });
  const drift = m("endurance", "Drift after 24 moves");
  if (drift?.value != null && drift.value > LIMITS.driftMm) {
    const a = get("120");
    out.push({ title: "The X axis is losing steps", change: `${a !== undefined ? `Lower acceleration: $120=${Math.round(a * 0.7)} (now ${a}); ` : ""}raise the A4988 current limit in small steps, checking motor temperature; re-home every scan until fixed`, evidence: `The reference moved ${drift.value.toFixed(2)} mm after 24 moves (limit ${LIMITS.driftMm}).`, severity: "high" });
  }
  const timing = m("timing", "Time error on moves over 1.5 s, mean");
  const acc = get("120");
  if (timing?.value != null && timing.verdict === "fail") {
    const slow = acc !== undefined && acc < GANTRY.accel * 10 * 0.95;
    out.push({ title: "The machine does not match the twin's timing", change: slow && drift?.verdict === "fail" ? `Lower GANTRY.accel in lib/sim/constants.ts to ${(acc! / 10).toFixed(0)} cm/s^2 so the twin tells the truth; do not raise $120 while steps are being lost` : slow ? `Either set $120=$121=${GANTRY.accel * 10} (if no steps are lost) or lower GANTRY.accel in lib/sim/constants.ts to ${(acc! / 10).toFixed(0)} cm/s^2 so the twin tells the truth` : "Compare $110/$111 (max rate, mm/min) and $120/$121 (acceleration, mm/s^2) with docs/BLUEPRINT.md 2.5", evidence: `Measured moves differ from the twin by ${timing.value.toFixed(0)}% (limit ${LIMITS.timingErrorPct}%)${acc !== undefined ? `; $120 is ${acc} mm/s^2 against ${GANTRY.accel * 10} in the specification` : ""}.`, severity: "medium" });
  }
  const rtt = m("link", "Round trip, 95th percentile");
  if (rtt?.verdict === "fail") out.push({ title: "The link is slow", change: "Use a shorter USB cable, a direct port rather than a hub, and close other serial monitors", evidence: `95th percentile round trip ${rtt.value!.toFixed(0)} ms (limit ${LIMITS.rttP95Ms} ms).`, severity: "medium" });
  const stop = m("stop", "Distance to rest, worst");
  if (stop?.verdict === "fail") out.push({ title: "The stop is too long", change: "Lower the maximum speed, or raise the deceleration if no steps are lost", evidence: `${stop.value!.toFixed(1)} cm to rest (limit ${LIMITS.stopCm} cm).`, severity: "high" });
  if (get("21") === 0) out.push({ title: "Hard limits are off", change: "$21=1 once the limit switches are wired and noise-free", evidence: "Controller setting $21 is 0: a missed home or a lost step can drive the carriage into the frame.", severity: "medium" });
  return out;
}

export function buildReport(d: GrblDriver, tests: TestRecord[], rig: string, notes: string): HardwareReport {
  const createdAt = new Date().toISOString();
  return { schema: "gantrylab.hardware-report/1", id: `hw-${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}`, createdAt, source: d.kind === "serial" ? "measured" : "simulated", rig, firmware: d.version, settings: Object.fromEntries(d.settings), tests, suggestions: suggest(tests, d.settings), notes };
}

export function overall(r: Pick<HardwareReport, "tests">): { pass: number; fail: number; unmeasured: number; verdict: "ACCEPTED" | "NOT ACCEPTED" | "INCOMPLETE" } {
  const all = r.tests.flatMap((t) => t.metrics);
  const pass = all.filter((x) => x.verdict === "pass").length;
  const fail = all.filter((x) => x.verdict === "fail").length + r.tests.filter((t) => t.error).length;
  const unmeasured = all.filter((x) => x.verdict === "not measured").length;
  const complete = TEST_ORDER.every((id) => r.tests.some((t) => t.id === id)) && unmeasured === 0;
  return { pass, fail, unmeasured, verdict: fail > 0 ? "NOT ACCEPTED" : complete ? "ACCEPTED" : "INCOMPLETE" };
}

export function toCsv(r: HardwareReport): string {
  const lines = [`# ${r.schema},${r.id},${r.source},${r.createdAt}`, "test,metric,value,unit,limit,verdict"];
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  for (const t of r.tests) for (const m of t.metrics) lines.push([t.name, m.name, m.value ?? "", m.unit, m.limit ?? "", m.verdict].map((v) => q(String(v))).join(","));
  for (const t of r.tests) {
    if (!t.rows.length) continue;
    lines.push("", `# ${t.name}`, t.columns.map(q).join(","));
    for (const row of t.rows) lines.push(row.map((v) => v ?? "").join(","));
  }
  return lines.join("\n") + "\n";
}

/* ---------- Raspberry Pi vision log ---------- */

export interface PiLog {
  frames: number;
  p50: number;
  p95: number;
  fps: number;
  maxTempC: number | null;
  throttled: number;
  /** latency of the last quarter over the first quarter: above 1 means it slows as it heats */
  slowdown: number;
  rows: { t: number; ms: number; temp: number | null }[];
}

/** Parses the CSV backend/pi_bench.py writes: t_s,latency_ms,temp_c,throttled. Throws with a readable reason. */
export function parsePiLog(text: string): PiLog {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const head = lines.shift()?.split(",").map((s) => s.trim()) ?? [];
  const col = (n: string) => head.indexOf(n);
  if (col("t_s") < 0 || col("latency_ms") < 0) throw new Error("Expected a CSV with columns t_s, latency_ms (and optionally temp_c, throttled).");
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const rows: PiLog["rows"] = [];
  let throttled = 0;
  for (const l of lines) {
    const c = l.split(",");
    const t = num(c[col("t_s")]);
    const ms = num(c[col("latency_ms")]);
    if (t === null || ms === null || ms <= 0) continue;
    rows.push({ t, ms, temp: col("temp_c") >= 0 ? num(c[col("temp_c")]) : null });
    if (col("throttled") >= 0 && num(c[col("throttled")])) throttled++;
  }
  if (rows.length < 10) throw new Error(`Only ${rows.length} usable frames; at least 10 are needed.`);
  const ms = rows.map((r) => r.ms);
  const q = Math.max(1, Math.floor(rows.length / 4));
  const temps = rows.map((r) => r.temp).filter((x): x is number => x !== null);
  return { frames: rows.length, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), fps: 1000 / mean(ms), maxTempC: temps.length ? Math.max(...temps) : null, throttled, slowdown: mean(ms.slice(-q)) / mean(ms.slice(0, q)), rows };
}
