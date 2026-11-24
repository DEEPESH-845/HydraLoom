// An emulated GRBL gantry behind the same transport as the real one: same protocol, same driver, same safety layer.
// It exists so the bench can be exercised and tested with no machine attached. Everything it produces is SIMULATED.
// Like real open-loop GRBL it reports the COMMANDED position; the true carriage differs by backlash, scale error and
// lost steps, which only a gauge (readTrue) can see.

import { GANTRY } from "../sim/constants";
import { mulberry32 } from "../sim/rng";
import type { Transport } from "./grbl";

export interface RigFaults {
  /** lost motion on reversal, mm */
  backlashMm: number;
  /** true mm per commanded mm on X */
  scaleX: number;
  scaleY: number;
  /** mm lost per fast X move */
  lostPerMoveMm: number;
  /** gauge and belt noise, mm, 1 sigma */
  noiseMm: number;
  /** controller acceleration setting, mm/s^2 */
  accel: number;
  /** reply latency, ms */
  latencyMs: number;
}

export const HEALTHY: RigFaults = { backlashMm: 0.08, scaleX: 1.0008, scaleY: 1.0004, lostPerMoveMm: 0, noiseMm: 0.03, accel: GANTRY.accel * 10, latencyMs: 8 };
export const WORN: RigFaults = { backlashMm: 0.9, scaleX: 1.012, scaleY: 1.001, lostPerMoveMm: 0.12, noiseMm: 0.06, accel: 180, latencyMs: 30 };

export class GrblEmulator implements Transport {
  readonly kind = "simulated" as const;
  readonly label: string;
  private out: (c: string) => void = () => {};
  private closeCb: (w: string) => void = () => {};
  private rand: () => number;
  private buf = "";
  private state: "Idle" | "Run" | "Hold" | "Home" | "Alarm" = "Alarm";
  private pos: [number, number] = [412, 187];
  private offset: [number, number] = [0, 0];
  private from: [number, number] = [0, 0];
  private to: [number, number] = [0, 0];
  private moveT = 0;
  private moveDur = 0;
  private v = 0;
  private queue: { to: [number, number]; feed: number }[] = [];
  private homeLeft = 0;
  private lost = 0;
  private dir: [number, number] = [1, 1];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: { at: number; text: string }[] = [];
  private clock = 0;
  pins = "";

  constructor(
    readonly faults: RigFaults = HEALTHY,
    seed = 5,
  ) {
    this.rand = mulberry32(seed);
    this.label = "Emulated rig";
  }

  /** Runs in real time (browser). Tests call advance() instead. `rate` speeds the machine up. */
  run(rate = 1): this {
    let last = performance.now();
    this.timer = setInterval(() => {
      const t = performance.now();
      this.advance(((t - last) / 1000) * rate);
      last = t;
    }, 10);
    return this;
  }

  onData(cb: (c: string) => void): void {
    this.out = cb;
    this.reply("Grbl 1.1h ['$' for help]");
  }
  onClose(cb: (w: string) => void): void {
    this.closeCb = cb;
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Test hook: the cable is pulled. */
  unplug(): void {
    this.close();
    this.closeCb("device disconnected");
  }

  private reply(text: string): void {
    this.pending.push({ at: this.clock + this.faults.latencyMs / 1000, text: text + "\r\n" });
  }

  write(data: string): void {
    for (const ch of data) {
      if (ch === "?") this.reply(this.report());
      else if (ch === "!") {
        if (this.state === "Run") this.hold();
      } else if (ch === "~") {
        // cycle start: nothing held may resume by itself, so it is ignored
      } else if (ch === "\x18") {
        this.queue = [];
        if (this.state === "Hold") this.state = "Idle";
        else if (this.state === "Run" || this.state === "Home") this.state = "Alarm";
        this.reply("Grbl 1.1h ['$' for help]");
      } else if (ch === "\n") {
        const l = this.buf.trim();
        this.buf = "";
        if (l) this.exec(l);
      } else if (ch !== "\r") this.buf += ch;
    }
  }

  private exec(l: string): void {
    if (l === "$$") {
      const s: [string, number][] = [["20", 0], ["21", 0], ["22", 1], ["100", 80], ["101", 80], ["110", 9000], ["111", 9000], ["120", this.faults.accel], ["121", this.faults.accel]];
      for (const [k, v] of s) this.reply(`$${k}=${v.toFixed(3)}`);
      this.reply("ok");
    } else if (l === "$H") {
      this.state = "Home";
      this.homeLeft = Math.max(this.pos[0], this.pos[1]) / 50 + 1.2;
    } else if (l === "$X") {
      if (this.state === "Alarm") this.state = "Idle";
      this.reply("ok");
    } else if (this.state === "Alarm" && l.startsWith("G90 G1")) this.reply("error:9");
    else if (l.startsWith("G92")) {
      this.offset = [...this.pos];
      this.reply("ok");
    } else if (/G1/.test(l)) {
      const g = (k: string) => Number(new RegExp(`${k}(-?[\\d.]+)`).exec(l)?.[1]);
      this.queue.push({ to: [g("X") + this.offset[0], g("Y") + this.offset[1]], feed: g("F") });
      this.reply("ok");
      if (this.state === "Idle") this.next();
    } else this.reply("ok");
  }

  private next(): void {
    const m = this.queue.shift();
    if (!m) {
      this.state = "Idle";
      return;
    }
    this.state = "Run";
    this.from = [...this.pos];
    this.to = m.to;
    const d = Math.hypot(this.to[0] - this.from[0], this.to[1] - this.from[1]);
    const v = Math.min(m.feed / 60, 150);
    const a = this.faults.accel;
    this.v = v;
    this.moveT = 0;
    this.moveDur = d <= (v * v) / a ? 2 * Math.sqrt(d / a) : d / v + v / a;
    for (const i of [0, 1] as const) if (Math.abs(this.to[i] - this.from[i]) > 1e-6) this.dir[i] = Math.sign(this.to[i] - this.from[i]);
    if (Math.abs(this.to[0] - this.from[0]) > 100) this.lost += this.faults.lostPerMoveMm;
  }

  private hold(): void {
    // decelerate along the line from the present speed
    const s = this.progress();
    const d = Math.hypot(this.to[0] - this.from[0], this.to[1] - this.from[1]);
    const a = this.faults.accel;
    const speed = Math.min(this.v, a * this.moveT, Math.max(0, a * (this.moveDur - this.moveT)));
    const stop = Math.min(d * (1 - s), (speed * speed) / (2 * a));
    const k = d > 0 ? s + stop / d : 1;
    const end: [number, number] = [this.from[0] + (this.to[0] - this.from[0]) * k, this.from[1] + (this.to[1] - this.from[1]) * k];
    this.pos = end;
    this.queue = [];
    this.state = "Hold";
    this.holdLeft = speed / a;
  }
  private holdLeft = 0;

  /** Fraction of the move done at moveT, trapezoidal. */
  private progress(): number {
    const d = Math.hypot(this.to[0] - this.from[0], this.to[1] - this.from[1]);
    if (d < 1e-9) return 1;
    const a = this.faults.accel;
    const T = this.moveDur;
    const t = Math.min(this.moveT, T);
    const ta = Math.min(this.v / a, T / 2);
    const vp = a * ta;
    const s = t < ta ? 0.5 * a * t * t : t < T - ta ? 0.5 * a * ta * ta + vp * (t - ta) : d - 0.5 * a * (T - t) ** 2;
    return Math.min(1, Math.max(0, s / d));
  }

  advance(dt: number): void {
    this.clock += dt;
    if (this.state === "Run") {
      this.moveT += dt;
      const s = this.progress();
      this.pos = [this.from[0] + (this.to[0] - this.from[0]) * s, this.from[1] + (this.to[1] - this.from[1]) * s];
      if (this.moveT >= this.moveDur) {
        this.pos = [...this.to];
        this.next();
      }
    } else if (this.state === "Hold") this.holdLeft = Math.max(0, this.holdLeft - dt);
    else if (this.state === "Home") {
      this.homeLeft -= dt;
      if (this.homeLeft <= 0) {
        this.pos = [0, 0];
        this.offset = [0, 0];
        this.lost = 0;
        this.dir = [1, 1];
        this.state = "Idle";
        this.reply("ok");
      }
    }
    const due = this.pending.filter((p) => p.at <= this.clock);
    this.pending = this.pending.filter((p) => p.at > this.clock);
    for (const p of due) this.out(p.text);
  }

  private report(): string {
    const st = this.state === "Hold" ? (this.holdLeft > 0 ? "Hold:1" : "Hold:0") : this.state;
    return `<${st}|MPos:${this.pos[0].toFixed(3)},${this.pos[1].toFixed(3)},0.000|FS:0,0${this.pins ? `|Pn:${this.pins}` : ""}|WCO:${this.offset[0].toFixed(3)},${this.offset[1].toFixed(3)},0.000>`;
  }

  /** What a dial gauge on the carriage would read, mm, work coordinates. */
  readTrue(): [number, number] {
    const g = () => Math.sqrt(-2 * Math.log(1 - this.rand())) * Math.cos(2 * Math.PI * this.rand()) * this.faults.noiseMm;
    const f = this.faults;
    return [(this.pos[0] - this.offset[0]) * f.scaleX - this.lost - (this.dir[0] < 0 ? -f.backlashMm : 0) + g(), (this.pos[1] - this.offset[1]) * f.scaleY - (this.dir[1] < 0 ? -f.backlashMm : 0) + g()];
  }
}
