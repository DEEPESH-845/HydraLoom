import { expect, test } from "./lab";

test.describe("test run", () => {
  test("full test: homing, scan, detect, track, complete; result and replay are deterministic", async ({ lab, page }) => {
    await lab.open();
    await lab.button(/run simulation/i).click();
    await lab.waitFor((s) => s.mode === "TEST" && s.scene === 4);
    await lab.waitFor((s) => s.phase === "HOMING");
    await lab.fastForward(12);
    await lab.waitFor((s) => s.phase === "SCANNING" || s.phase === "DETECTING");
    await lab.fastForward(60);
    await lab.waitFor((s) => s.phase === "COMPLETE", 90_000);
    const r1 = await lab.state((s) => s.result!);
    expect(r1.objectsDetected).toBe(5);
    expect(r1.successfulDetections).toBe(3);
    expect(r1.falsePositives).toBe(1);
    expect(r1.coverage).toBeCloseTo(0.9, 2);
    expect(r1.targetId).toBe("wreck-01");
    await page.getByRole("button", { name: /view result/i }).first().click();
    await expect(page.getByRole("heading", { name: /Test result/ })).toBeVisible();
    await expect(page.getByText("05").first()).toBeVisible();

    await lab.button(/replay test/i).click();
    await lab.waitFor((s) => s.phase === "HOMING");
    await lab.fastForward(80);
    await lab.waitFor((s) => s.phase === "COMPLETE", 90_000);
    const [r2, prev] = await lab.state((s) => [s.result!, s.previousResult!]);
    expect(r2).toEqual(r1);
    expect(prev).toEqual(r1);
    await expect(page.getByText(/deltas vs previous run/)).toBeVisible();
  });

  test("stop during scan keeps the previous result and returns to IDLE", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(4);
    await lab.button(/run test/i).click();
    await lab.fastForward(15);
    await lab.button(/^stop$/i).click();
    const s = await lab.state((s) => ({ mode: s.mode, phase: s.phase, moving: s.telemetry.gantry.moving }));
    expect(s.mode).toBe("IDLE");
    expect(s.phase).toBe("IDLE");
    await lab.fastForward(1);
    expect(await lab.state((s) => s.telemetry.gantry.moving)).toBe(false);
    await expect(page.getByText(/MODE/)).toContainText("IDLE");
  });

  test("run -> reset -> run three times gives identical results", async ({ lab }) => {
    await lab.open();
    const results = [];
    for (let i = 0; i < 3; i++) {
      await lab.scene(4);
      await lab.button(/run test/i).click();
      await lab.fastForward(80);
      await lab.waitFor((s) => s.phase === "COMPLETE", 90_000);
      results.push(await lab.state((s) => s.result));
      await lab.button(/^reset$/i).click();
      const fresh = await lab.state((s) => [s.result, s.previousResult, s.events.length, s.telemetry.gantry.x, s.telemetry.gantry.y, s.telemetry.time < 1]);
      expect(fresh).toEqual([null, null, 0, 50, 20, true]);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});
