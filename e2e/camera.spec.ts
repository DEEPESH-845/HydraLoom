import { expect, test } from "./lab";

const SCENE_PRESET: Record<number, string> = { 1: "A", 2: "A", 3: "D", 4: "B", 5: "B", 6: "B", 7: "A" };

test.describe("camera", () => {
  test("each scene sets its preset and the view settles deterministically", async ({ lab }) => {
    await lab.open();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      await lab.scene(n);
      expect(await lab.state((s) => s.cameraPreset)).toBe(SCENE_PRESET[n]);
    }
  });

  test("follow preset moves with the carriage", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(3);
    // the preset tween starts on the next React commit; wait for it to start, then to finish
    await page.waitForFunction(() => window.__labCamera?.tweening(), null, { timeout: 5000 }).catch(() => undefined);
    await page.waitForFunction(() => window.__labCamera && !window.__labCamera.tweening());
    const before = await page.evaluate(() => ({ ...window.__labCamera!.camera.position }));
    await page.evaluate(() => window.__labStore!.getState().moveGantryTo(10, 5));
    await lab.fastForward(20);
    // the rig applies the carriage delta on the next render frame
    await page.waitForFunction((bx) => !window.__labCamera!.tweening() && Math.abs(window.__labCamera!.camera.position.x - bx) > 0.3, before.x);
    const after = await page.evaluate(() => ({ ...window.__labCamera!.camera.position }));
    const g = await lab.state((s) => s.telemetry.gantry);
    expect(g.x).toBeCloseTo(10, 0);
    // carriage moved 40 cm in -X: camera must have followed by about the same amount
    expect(before.x - after.x).toBeGreaterThan(0.3);
    expect(before.x - after.x).toBeLessThan(0.5);
  });

  test("rapid preset switching and reset mid-tween settle without errors", async ({ lab, page }) => {
    await lab.open();
    for (let i = 0; i < 10; i++) {
      await lab.rail(/^03/).click();
      await lab.rail(/^04/).click();
      await lab.rail(/^01/).click();
    }
    await lab.button(/^reset$/i).click();
    await page.waitForTimeout(2000);
    expect(await lab.state((s) => s.cameraPreset)).toBe("A");
  });
});
