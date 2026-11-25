// Sensitivity test: the same mission at several values of one parameter, everything else held. Headless engines, so the
// live simulation is untouched; run in slices so the page stays responsive.

import type { MissionId } from "../missions";
import type { PlatformId } from "../platforms";
import { ntuAt } from "../world/environments";
import type { FieldEnvironmentId } from "../world/schema";
import { FieldEngine, type ConditionsPatch, type FieldConditions } from "./engine";
import { SITE_KEYS, SITE_SPEC, type SiteKey } from "./site";

export interface SweepParam {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  digits: number;
  patch: (v: number) => ConditionsPatch;
  read: (c: FieldConditions) => number;
}

const num = (id: "turbidity" | "lighting" | "lamps" | "speedMps" | "altitudeM" | "threshold", label: string, unit: string, min: number, max: number, digits = 2): SweepParam => ({ id, label, unit, min, max, digits, patch: (v) => ({ [id]: v }) as ConditionsPatch, read: (c) => c[id] });

export const SWEEP_PARAMS: SweepParam[] = [
  num("turbidity", "Turbidity", "", 0, 0.6),
  num("lighting", "Light", "", 0, 1),
  num("lamps", "Vehicle lamps", "", 0, 1),
  { id: "current", label: "Current speed", unit: "m/s", min: 0, max: 1.6, digits: 2, patch: (v) => ({ current: { speedMps: v } }), read: (c) => c.current.speedMps },
  { id: "turbulence", label: "Turbulence", unit: "", min: 0, max: 0.5, digits: 2, patch: (v) => ({ current: { turbulence: v } }), read: (c) => c.current.turbulence },
  num("speedMps", "Cruise speed", "m/s", 0.2, 2),
  num("altitudeM", "Survey altitude", "m", 0.5, 6, 1),
  num("threshold", "Detection threshold", "", 0.3, 0.9),
  ...SITE_KEYS.filter((k) => k !== "waveHeadingDeg").map((k): SweepParam => {
    const s = SITE_SPEC[k];
    return { id: `site.${k}`, label: s.label, unit: k === "exposureS" ? "s" : s.unit, min: s.min, max: s.max, digits: s.digits, patch: (v) => ({ site: { [k]: v } as Partial<Record<SiteKey, number>> }), read: (c) => c.site[k] };
  }),
];

export interface SweepRow {
  value: number;
  ntu: number;
  visibilityM: number;
  altitudeM: number;
  /** means over the seeds */
  found: number;
  classified: number;
  wreck: number;
  meanConfidence: number;
  contacts: number;
  durationS: number;
  /** share of runs that finished inside the time limit */
  finished: number;
  total: number;
}

export interface SweepOptions {
  env: FieldEnvironmentId;
  platform: PlatformId;
  mission: MissionId;
  base: FieldConditions;
  param: SweepParam;
  values: number[];
  seeds: number;
  /** fly the altitude each value's water calls for, as a pilot would */
  replan: boolean;
}

const LIMIT_S = 1300;

/** Evenly spaced values, ends included, rounded so that they read well. */
export function sweepValues(lo: number, hi: number, n: number, digits: number): number[] {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const k = 10 ** Math.max(digits, 2);
  return [...new Set(Array.from({ length: Math.max(2, n) }, (_, i) => Math.round((a + ((b - a) * i) / (Math.max(2, n) - 1)) * k) / k))];
}

export async function runSweep(o: SweepOptions, onRow: (r: SweepRow, done: number) => void, signal?: AbortSignal): Promise<SweepRow[]> {
  const rows: SweepRow[] = [];
  for (const value of o.values) {
    const acc = { ntu: 0, vis: 0, alt: 0, found: 0, classified: 0, wreck: 0, conf: 0, contacts: 0, dur: 0, fin: 0, total: 0 };
    for (let s = 0; s < o.seeds; s++) {
      const e = new FieldEngine(o.env, o.platform);
      const { obstacles: _obstacles, ...current } = o.base.current;
      void _obstacles;
      e.setConditions({ ...o.base, current, site: o.base.site });
      e.setConditions({ ...o.param.patch(value), seed: o.base.seed + s * 101 });
      if (o.replan && o.param.id !== "altitudeM") e.setConditions({ altitudeM: e.plannedAltitude() });
      e.reset();
      e.setMission(o.mission);
      e.startMission();
      while (e.phase === "RUNNING" && e.time < LIMIT_S) {
        if (signal?.aborted) throw new DOMException("sweep cancelled", "AbortError");
        const t0 = Date.now();
        // a few milliseconds of work, then back to the page
        while (e.phase === "RUNNING" && e.time < LIMIT_S && Date.now() - t0 < 12) e.advance(1);
        await new Promise((r) => setTimeout(r, 0));
      }
      const finished = e.phase === "COMPLETE";
      if (!finished) e.abortMission();
      const finds = e.finds();
      acc.ntu += ntuAt(e.env, e.conditions.turbidity);
      acc.vis += e.visibility();
      acc.alt += e.conditions.altitudeM;
      acc.found += finds.length;
      acc.classified += finds.filter((f) => f.correct).length;
      acc.wreck += finds.some((f) => f.class === "SHIPWRECK") ? 1 : 0;
      acc.conf += finds.length ? finds.reduce((a, f) => a + f.confidence, 0) / finds.length : 0;
      acc.contacts += e.result?.contacts ?? 0;
      acc.dur += e.result?.durationS ?? 0;
      acc.fin += finished ? 1 : 0;
      acc.total = e.targets.length;
    }
    const n = o.seeds;
    const row: SweepRow = { value, ntu: acc.ntu / n, visibilityM: acc.vis / n, altitudeM: acc.alt / n, found: acc.found / n, classified: acc.classified / n, wreck: acc.wreck / n, meanConfidence: acc.conf / n, contacts: acc.contacts / n, durationS: acc.dur / n, finished: acc.fin / n, total: acc.total };
    rows.push(row);
    onRow(row, rows.length);
  }
  return rows;
}

/** The values at which at least `share` of the targets are classified, and where that stops. */
export function envelope(rows: SweepRow[], share = 0.8): { inside: SweepRow[]; text: (fmt: (v: number) => string) => string } {
  const inside = rows.filter((r) => r.total > 0 && r.classified / r.total >= share - 1e-9);
  return {
    inside,
    text: (fmt) => {
      if (!rows.length) return "";
      if (!inside.length) return `Never reaches ${Math.round(share * 100)}% of targets classified in this range.`;
      if (inside.length === rows.length) return `Classifies at least ${Math.round(share * 100)}% of targets over the whole range tested.`;
      const lo = rows.indexOf(inside[0]);
      const hi = rows.indexOf(inside[inside.length - 1]);
      const gaps = hi - lo + 1 > inside.length;
      return `Classifies at least ${Math.round(share * 100)}% of targets from ${fmt(inside[0].value)} to ${fmt(inside[inside.length - 1].value)}${gaps ? ", with gaps in between" : ""}.`;
    },
  };
}
