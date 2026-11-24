// GRBL 1.1 driver for the physical gantry (Arduino Uno + CNC shield, docs/BLUEPRINT.md section 2.5) over any line
// transport: Web Serial in the browser, or the emulator in lib/hardware/emulator.ts. Motion only ever arrives through
// SafeGantryLink (lib/hardware/safety.ts); this file turns validated commands into GRBL and status back into packets.

import { SafeGantryLink, SafetySupervisor, type GantryAdapter, type GantryCommand, type HardwareStatus } from "./safety";

export interface Transport {
  readonly kind: "serial" | "simulated";
  readonly label: string;
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): Promise<void> | void;
}

export interface GrblStatus {
  state: string;
  /** work position, mm, when it could be resolved */
  x: number | null;
  y: number | null;
  /** asserted input pins: X Y Z limits, P probe, D door, H hold, R reset, S start */
  pins: string;
  feed: number | null;
}

/** Parses `<Idle|MPos:1.000,2.000,0.000|FS:0,0|Pn:XY|WCO:0,0,0>`; null when the line is not a status report. */
export function parseStatus(line: string, wco: [number, number] | null): { status: GrblStatus; wco: [number, number] | null } | null {
  const m = /^<([^|>]+)((?:\|[^|>]*)*)>$/.exec(line.trim());
  if (!m) return null;
  const fields = new Map(
    m[2]
      .split("|")
      .filter(Boolean)
      .map((f) => {
        const i = f.indexOf(":");
        return i < 0 ? ([f, ""] as [string, string]) : ([f.slice(0, i), f.slice(i + 1)] as [string, string]);
      }),
  );
  const pair = (v: string | undefined): [number, number] | null => {
    const n = v?.split(",").map(Number) ?? [];
    return n.length >= 2 && Number.isFinite(n[0]) && Number.isFinite(n[1]) ? [n[0], n[1]] : null;
  };
  const off = pair(fields.get("WCO")) ?? wco;
  const w = pair(fields.get("WPos"));
  const mp = pair(fields.get("MPos"));
  const pos = w ?? (mp ? [mp[0] - (off?.[0] ?? 0), mp[1] - (off?.[1] ?? 0)] : null);
  const fs = fields.get("FS") ?? fields.get("F");
  return { status: { state: m[1], x: pos ? pos[0] : null, y: pos ? pos[1] : null, pins: fields.get("Pn") ?? "", feed: fs ? Number(fs.split(",")[0]) : null }, wco: off };
}

export interface DriverEvent {
  t: number;
  dir: "tx" | "rx" | "note";
  text: string;
}

const POLL_MS = 100;
/** GRBL does not answer status requests while it homes. */
const HOMING_LIMIT_MS = 90_000;
/** A connection that never reports GRBL within this is something else on the port. */
const IDENT_MS = 4000;

export class GrblDriver implements GantryAdapter {
  readonly kind: "serial" | "simulated";
  readonly supervisor: SafetySupervisor;
  readonly link: SafeGantryLink;
  status: GrblStatus | null = null;
  homed = false;
  version: string | null = null;
  closed: string | null = null;
  readonly settings = new Map<string, number>();
  readonly log: DriverEvent[] = [];
  /** round-trip times of status requests, ms, newest last */
  readonly rtt: number[] = [];
  onChange: (() => void) | null = null;

  private buffer = "";
  private wco: [number, number] | null = null;
  private waiting: { resolve: () => void; reject: (e: Error) => void; cmd: string }[] = [];
  private statusWaiters: { resolve: (s: GrblStatus) => void; reject: (e: Error) => void }[] = [];
  private askedAt: number | null = null;
  private homingSince: number | null = null;
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly port: Transport,
    readonly now: () => number = () => performance.now(),
  ) {
    this.kind = port.kind;
    this.supervisor = new SafetySupervisor(undefined, "live");
    this.link = new SafeGantryLink(this.supervisor, this);
    port.onData((c) => this.receive(c));
    port.onClose((why) => this.lost(why));
  }

  /** Wakes the controller, reads its settings and starts the heartbeat. Rejects when nothing on the port speaks GRBL. */
  async start(poll = true): Promise<void> {
    this.raw("\r\n");
    if (poll) this.timer = setInterval(() => this.tick(), POLL_MS);
    const deadline = this.now() + IDENT_MS;
    this.ask();
    await new Promise<void>((resolve, reject) => {
      const t = setInterval(() => {
        if (this.status) {
          clearInterval(t);
          resolve();
        } else if (this.closed || this.now() > deadline) {
          clearInterval(t);
          reject(new Error(this.closed ?? "No GRBL status from this port. Check the firmware (GRBL 1.1) and the baud rate (115200)."));
        }
      }, 25);
    });
    await this.command("$$");
    await this.command("G21 G90 G94");
  }

  /** One heartbeat: feeds the supervisor, trips on silence, asks for the next status. */
  tick(): void {
    const t = this.now();
    if (this.homingSince !== null) {
      if (t - this.homingSince > HOMING_LIMIT_MS) {
        this.homingSince = null;
        this.note("homing did not finish");
      } else this.beat(t); // silence is expected here, and only here
    }
    if (this.supervisor.watchdog(t)) this.send({ kind: "STOP", source: "operator" });
    this.ask();
    this.onChange?.();
  }

  private ask(): void {
    if (this.closed) return;
    if (this.askedAt === null || this.now() - this.askedAt > 1000) this.askedAt = this.now();
    this.port.write("?");
  }

  private beat(t: number): void {
    this.supervisor.heartbeat(this.packet(), t);
  }

  /** Status in the shape the safety layer checks, gantry cm. */
  packet(): HardwareStatus {
    const s = this.status;
    const pins = s?.pins ?? "";
    return { connected: !this.closed, homed: this.homed, limitX0: pins.includes("X"), limitY0: pins.includes("Y"), estopPressed: pins.includes("R") || pins.includes("D"), x: (s?.x ?? NaN) / 10, y: (s?.y ?? NaN) / 10 };
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.search(/[\r\n]/)) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.line(line);
    }
    if (this.buffer.length > 4096) this.buffer = ""; // line noise
  }

  private line(line: string): void {
    const parsed = line.startsWith("<") ? parseStatus(line, this.wco) : null;
    if (parsed) {
      this.wco = parsed.wco;
      this.status = parsed.status;
      if (this.askedAt !== null) {
        this.rtt.push(this.now() - this.askedAt);
        if (this.rtt.length > 500) this.rtt.shift();
        this.askedAt = null;
      }
      if (parsed.status.state.startsWith("Alarm")) this.homed = false;
      this.beat(this.now());
      // a hold that has come to rest is flushed, so the rest of a stopped move can never resume by itself
      if (this.stopping && parsed.status.state === "Hold:0") {
        this.stopping = false;
        this.failPending("stopped");
        this.raw("\x18");
      }
      const w = this.statusWaiters.splice(0);
      for (const f of w) f.resolve(parsed.status);
      this.onChange?.();
      return;
    }
    this.push("rx", line);
    const setting = /^\$(\d+)=(-?[\d.]+)/.exec(line);
    if (setting) this.settings.set(setting[1], Number(setting[2]));
    const id = /^Grbl ([\w.]+)/.exec(line);
    if (id) this.version = id[1];
    if (line === "ok") this.waiting.shift()?.resolve();
    else if (line.startsWith("error:")) {
      const w = this.waiting.shift();
      w?.reject(new Error(`${line} for ${w.cmd}`));
    } else if (line.startsWith("ALARM:")) {
      this.homed = false;
      this.homingSince = null;
      this.failPending(line);
    }
    this.onChange?.();
  }

  private failPending(why: string): void {
    for (const w of this.waiting.splice(0)) w.reject(new Error(`${why} during ${w.cmd}`));
  }

  private lost(why: string): void {
    if (this.closed) return;
    this.closed = why;
    this.homed = false;
    this.failPending(why);
    for (const w of this.statusWaiters.splice(0)) w.reject(new Error(why));
    this.note(`link lost: ${why}`);
    if (this.timer) clearInterval(this.timer);
    this.onChange?.();
  }

  private push(dir: DriverEvent["dir"], text: string): void {
    this.log.push({ t: this.now(), dir, text });
    if (this.log.length > 400) this.log.shift();
  }

  note(text: string): void {
    this.push("note", text);
  }

  private raw(s: string): void {
    if (!this.closed) this.port.write(s);
  }

  /** Sends one line and resolves on GRBL's `ok`. Not for motion: motion goes through `submit`. */
  command(cmd: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    this.push("tx", cmd);
    const p = new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject, cmd }));
    this.raw(cmd + "\n");
    return p;
  }

  nextStatus(): Promise<GrblStatus> {
    return this.closed ? Promise.reject(new Error(this.closed)) : new Promise((resolve, reject) => this.statusWaiters.push({ resolve, reject }));
  }

  /** Last promise of a motion command, for callers that wait for GRBL to accept it. */
  private accepted: Promise<void> = Promise.resolve();

  /** GantryAdapter: called by SafeGantryLink only, after validation. */
  send(cmd: GantryCommand): void {
    if (cmd.kind === "STOP") {
      this.push("tx", "! (feed hold)");
      this.stopping = true;
      this.raw("!");
      return;
    }
    if (cmd.kind === "HOME") {
      this.homed = false;
      this.homingSince = this.now();
      this.accepted = this.command("$H").then(
        async () => {
          this.homingSince = null;
          // work origin at the home corner, volatile: nothing is written to the controller's EEPROM
          await this.command("G92 X0 Y0");
          this.wco = null;
          this.homed = true;
        },
        (e) => {
          this.homingSince = null;
          throw e;
        },
      );
      this.accepted.catch(() => {});
      return;
    }
    // absolute every time, so a stray G91 can never turn a target into an offset
    this.accepted = this.command(`G90 G1 X${(cmd.x * 10).toFixed(3)} Y${(cmd.y * 10).toFixed(3)} F${(cmd.speed * 600).toFixed(1)}`);
    this.accepted.catch(() => {});
  }

  /** Validates, sends, and resolves when the machine is idle again. The duration is measured from acceptance to Idle. */
  async run(cmd: GantryCommand, timeoutMs = 120_000): Promise<{ ms: number }> {
    const r = this.link.submit(cmd, this.now());
    if (!r.ok) throw new Error(r.reason);
    const t0 = this.now();
    await this.accepted;
    const state = () => this.status?.state ?? "";
    let seen = 0;
    for (;;) {
      const s = await this.nextStatus();
      seen++;
      if (this.closed) throw new Error(this.closed);
      if (s.state.startsWith("Alarm")) throw new Error(s.state);
      if (this.supervisor.state === "ESTOP" || this.supervisor.state === "FAULT") throw new Error(this.supervisor.state);
      // GRBL acknowledges a line when it is planned, so the first report may still be Idle
      if (state() === "Idle" && (seen > 1 || cmd.kind === "HOME")) return { ms: this.now() - t0 };
      if (this.now() - t0 > timeoutMs) {
        this.link.submit({ kind: "STOP", source: "operator" }, this.now());
        throw new Error(`motion did not finish within ${timeoutMs / 1000} s`);
      }
    }
  }

  async stop(): Promise<void> {
    this.link.submit({ kind: "STOP", source: "operator" }, this.now());
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.lost("closed by the operator");
    await this.port.close();
  }
}

/* ---------- Web Serial ---------- */

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export const webSerialAvailable = () => typeof navigator !== "undefined" && "serial" in navigator;

/** Opens a serial port the operator picks. Must be called from a click. */
export async function openWebSerial(baudRate = 115200): Promise<Transport> {
  const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
  const port = await serial.requestPort();
  await port.open({ baudRate });
  const writer = port.writable!.getWriter();
  const reader = port.readable!.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let onData: (c: string) => void = () => {};
  let onClose: (w: string) => void = () => {};
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) onData(dec.decode(value, { stream: true }));
      }
      onClose("port closed");
    } catch (e) {
      onClose((e as Error).message || "read failed");
    }
  })();
  return {
    kind: "serial",
    label: `USB serial, ${baudRate} baud`,
    write: (d) => void writer.write(enc.encode(d)).catch((e) => onClose((e as Error).message)),
    onData: (cb) => (onData = cb),
    onClose: (cb) => (onClose = cb),
    close: async () => {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await writer.close().catch(() => {});
      await port.close().catch(() => {});
    },
  };
}
