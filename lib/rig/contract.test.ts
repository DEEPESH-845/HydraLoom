import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRigCommand, isRigHealth, isRigReply, isRigTelemetry } from "./types";

const DIR = join(process.cwd(), "contracts/rig/v1/fixtures");
const guards: Record<string, (x: unknown) => boolean> = {
  telemetry: isRigTelemetry, command: isRigCommand, reply: isRigReply, health: isRigHealth,
};
for (const kind of ["valid", "invalid"] as const) {
  const files = readdirSync(join(DIR, kind)).filter((f) => f.endsWith(".json"));
  test(`${kind} fixtures exist`, () => assert.ok(files.length > 0));
  for (const f of files) {
    test(`${kind}: ${f}`, () => {
      const x: unknown = JSON.parse(readFileSync(join(DIR, kind, f), "utf8"));
      assert.equal(guards[f.split(".")[0]](x), kind === "valid");
    });
  }
}
