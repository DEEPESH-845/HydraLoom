import { expect, test } from "./lab";

test.describe("demo", () => {
  test("runs the complete presentation to the result and the closing moment, then replays cleanly", async ({ lab, page }) => {
    // Software GL renders 2 to 3 fps, which slows the sim to about a quarter of wall time; a small
    // viewport roughly doubles that, and the budget covers the demo's documented 264 s upper bound.
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1024, height: 640 });
    await lab.open();
    await lab.button(/run demo/i).click();
    await lab.waitFor((s) => s.demo.active && s.scene === 1);
    await expect(lab.rail(/^02/)).toBeDisabled();
    // Wall clock, no fast-forward: the demo is a scripted presentation and must reach its
    // result on its own. Phases must only ever advance.
    const seen: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 1000 && !(await lab.state((s) => s.showVision)); i++) {
      const ph = await lab.state((s) => s.demo.phase);
      if (seen[seen.length - 1] !== ph) seen.push(ph);
      await page.waitForTimeout(500);
    }
    const simT = await lab.state((s) => s.telemetry.time);
    console.log(`demo phases ${seen.join(">")} wall ${((Date.now() - t0) / 1000).toFixed(0)} s, sim ${simT.toFixed(0)} s`);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen).toEqual(expect.arrayContaining([0, 1, 2, 3, 6, 7]));
    expect(await lab.state((s) => s.phase)).toBe("COMPLETE");
    expect(await lab.state((s) => s.result?.objectsDetected)).toBe(5);
    await expect(page.getByText(/From simulation to field/)).toBeVisible();
    await page.keyboard.press("Escape");
    await lab.waitFor((s) => !s.showVision && !s.demo.active);
    // replay from a clean state
    await lab.button(/run demo/i).click();
    await lab.waitFor((s) => s.demo.active && s.demo.phase === 0);
    await lab.button(/exit demo/i).click();
    await lab.waitFor((s) => !s.demo.active);
    expect(await lab.state((s) => s.mode)).toBe("IDLE");
  });

  test("pause freezes sim time and telemetry says so; reset is blocked", async ({ lab, page }) => {
    await lab.open();
    await lab.button(/run demo/i).click();
    await lab.waitFor((s) => s.demo.active);
    await lab.button(/^pause$/i).click();
    await lab.waitFor((s) => s.demo.paused);
    const t1 = await lab.state((s) => s.engine.time);
    await page.waitForTimeout(1200);
    const t2 = await lab.state((s) => s.engine.time);
    expect(t2).toBe(t1);
    await expect(page.getByText("PAUSED")).toBeVisible();
    await expect(lab.button(/^reset$/i)).toBeDisabled();
    await lab.button(/^resume$/i).click();
    await lab.button(/exit demo/i).click();
    await lab.waitFor((s) => !s.demo.active);
  });
});
