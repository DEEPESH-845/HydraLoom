// Rig contract v1. Mirrors backend/gantrylab/rig/models.py; validation runs on the
// generated schemas in contracts/rig/v1, and contract.test.ts pins the fixtures.
import telemetrySchema from "../../contracts/rig/v1/telemetry.schema.json";
import commandSchema from "../../contracts/rig/v1/command.schema.json";
import replySchema from "../../contracts/rig/v1/reply.schema.json";
import healthSchema from "../../contracts/rig/v1/health.schema.json";

export type RigSource = "real" | "sim";
export type GantryState =
  | "DISARMED" | "ARMED" | "HOMING" | "IDLE" | "MOVING" | "HOLD" | "ESTOP" | "FAULT";
export type SearchStatus = "idle" | "running" | "aligning" | "confirming" | "parking" | "done";

export interface RigDetection {
  x1: number; y1: number; x2: number; y2: number; conf: number; label: "shipwreck";
}
export interface RigFound {
  id: string; x_mm: number; y_mm: number; conf: number; centred: boolean;
}
export interface RigTelemetry {
  v: 1;
  t: string;
  source: RigSource;
  rig: "bench-v1";
  gantry: { state: GantryState; x_mm: number; y_mm: number; target: [number, number] | null };
  search: {
    status: SearchStatus; step: number; cell: [number, number] | null;
    visited: (0 | 1)[][]; found: RigFound[];
  };
  detections: RigDetection[];
  fps: number;
  throttled: string;
  temp_c: number;
}
export type RigCommand = { id: string } & (
  | { cmd: "arm"; phrase: "ARM GANTRY" }
  | { cmd: "disarm" | "estop" | "reset_fault" | "set_origin_here" | "park" | "stop" | "heartbeat" }
  | { cmd: "move"; x_mm: number; y_mm: number }
  | { cmd: "start_search"; policy: "rl" | "sweep"; conf: number; model: string }
);
export interface RigReply { id: string; ok: boolean; error?: string | null }
export interface RigHealth {
  v: 1; source: RigSource; rig: "bench-v1"; dry_run: boolean;
  versions: Record<string, string>; model: string | null;
  camera: boolean; serial: boolean; throttled: string | null;
}
/** results.json and calib.json are passed through; their real shapes are not known here. */
export type RigOpenObject = Record<string, unknown>;

type Schema = Record<string, unknown>;
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

// ponytail: only the JSON Schema keywords the generated files use; use ajv if models need more.
function valid(s: Schema, x: unknown, root: Schema): boolean {
  if (typeof s.$ref === "string") {
    const defs = root.$defs as Record<string, Schema>;
    return valid(defs[s.$ref.replace("#/$defs/", "")], x, root);
  }
  if ("const" in s && x !== s.const) return false;
  if (s.enum && !(s.enum as unknown[]).includes(x)) return false;
  for (const k of ["anyOf", "oneOf"]) {
    const alts = s[k] as Schema[] | undefined;
    if (alts && !alts.some((a) => valid(a, x, root))) return false;
  }
  switch (s.type) {
    case "null": return x === null;
    case "boolean": return typeof x === "boolean";
    case "number":
    case "integer":
      return typeof x === "number" && Number.isFinite(x)
        && (s.type === "number" || Number.isInteger(x))
        && (s.minimum === undefined || x >= (s.minimum as number))
        && (s.maximum === undefined || x <= (s.maximum as number));
    case "string":
      return typeof x === "string"
        && (s.minLength === undefined || x.length >= (s.minLength as number))
        && (s.maxLength === undefined || x.length <= (s.maxLength as number))
        && (s.pattern === undefined || new RegExp(s.pattern as string).test(x))
        && (s.format !== "date-time"
          || (/(Z|[+-]\d\d:\d\d)$/.test(x) && !Number.isNaN(Date.parse(x))));
    case "array":
      return Array.isArray(x)
        && (s.minItems === undefined || x.length >= (s.minItems as number))
        && (s.maxItems === undefined || x.length <= (s.maxItems as number))
        && (!s.items || x.every((v) => valid(s.items as Schema, v, root)));
    case "object": {
      if (!isObj(x)) return false;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      if (((s.required ?? []) as string[]).some((k) => !Object.hasOwn(x, k))) return false;
      return Object.entries(x).every(([k, v]) => {
        if (Object.hasOwn(props, k)) return valid(props[k], v, root);
        if (s.additionalProperties === false) return false;
        return isObj(s.additionalProperties) ? valid(s.additionalProperties, v, root) : true;
      });
    }
  }
  return true;
}

const guard = <T>(schema: unknown) => (x: unknown): x is T =>
  valid(schema as Schema, x, schema as Schema);
export const isRigTelemetry = guard<RigTelemetry>(telemetrySchema);
export const isRigCommand = guard<RigCommand>(commandSchema);
export const isRigReply = guard<RigReply>(replySchema);
export const isRigHealth = guard<RigHealth>(healthSchema);
