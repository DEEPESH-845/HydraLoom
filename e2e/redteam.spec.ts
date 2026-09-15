import { expect, test } from "./lab";

/** Deliberate abuse. Every sequence must end in a consistent, recoverable state with no console errors. */
test.describe("red team", () => {
  test("rapid random clicking over every control keeps invariants", async ({ lab, page }) => {
    await lab.open();
    const seed = 7;
    let r = seed;
    const rand = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 60; i++) {
      const buttons = page.getByRole("button");
      const n = await buttons.count();
      const b = buttons.nth(Math.floor(rand() * n));
      if (await b.isEnabled().catch(() => false)) await b.click({ timeout: 2000, force: true }).catch(() => undefined);
      if (i % 10 === 9) {
        const g = await lab.state((s) => s.engine.gantry);
        expect(g.x.pos).toBeGreaterThanOrEqual(0);
        expect(g.x.pos).toBeLessThanOrEqual(100);
        expect(g.y.pos).toBeGreaterThanOrEqual(0);
        expect(g.y.pos).toBeLessThanOrEqual(40);
      }
    }
    await page.keyboard.press("Escape");
    const st = await lab.state((s) => s);
    if (st.demo.active) await lab.button(/exit demo/i).click();
    await lab.button(/^reset$/i).click();
    const after = await lab.state((s) => ({ mode: s.mode, phase: s.phase, x: s.telemetry.gantry.x, y: s.telemetry.gantry.y, rl: s.rl.active, demo: s.demo.active }));
    expect(after).toEqual({ mode: "IDLE", phase: "IDLE", x: 50, y: 20, rl: false, demo: false });
  });

  test("start twice, stop twice, reset during animation, resize during animation", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(4);
    await lab.button(/run test/i).dblclick();
    await lab.waitFor((s) => s.phase === "HOMING");
    await lab.fastForward(3);
    await page.setViewportSize({ width: 1100, height: 700 });
    await lab.rail(/^03/).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await lab.button(/^reset$/i).click();
    await lab.button(/^reset$/i).click();
    await lab.scene(4);
    await lab.button(/^stop$/i).click();
    await lab.button(/^stop$/i).click();
    await lab.fastForward(1);
    const s = await lab.state((s) => ({ mode: s.mode, phase: s.phase, moving: s.telemetry.gantry.moving, x: s.telemetry.gantry.x }));
    expect(s).toEqual({ mode: "IDLE", phase: "IDLE", moving: false, x: 50 });
    // the feed rect is re-measured after the resize: it still renders inside its DOM box
    const fb = (await page.locator("#gantry-camera-feed").boundingBox())!;
    expect(fb.width).toBeGreaterThan(200);
  });

  test("reload during a simulation starts fresh", async ({ lab }) => {
    await lab.open();
    await lab.scene(4);
    await lab.button(/run test/i).click();
    await lab.fastForward(10);
    await lab.open();
    const s = await lab.state((s) => ({ mode: s.mode, scene: s.scene, x: s.telemetry.gantry.x, result: s.result }));
    expect(s).toEqual({ mode: "IDLE", scene: 1, x: 50, result: null });
  });

  test("demo interrupts: exit mid-scan, replay mid-episode, reset after exit", async ({ lab }) => {
    await lab.open();
    await lab.button(/run demo/i).click();
    await lab.waitFor((s) => s.demo.active);
    await lab.waitFor((s) => s.mode === "TEST", 30_000);
    await lab.button(/exit demo/i).click();
    expect(await lab.state((s) => [s.demo.active, s.mode])).toEqual([false, "IDLE"]);
    await lab.button(/run demo/i).click();
    await lab.waitFor((s) => s.demo.active && s.mode === "TEST", 30_000);
    await lab.button(/replay/i).click();
    await lab.waitFor((s) => s.demo.active && s.demo.phase === 0 && s.scene === 1);
    expect(await lab.state((s) => s.telemetry.gantry.x)).toBe(50);
    await lab.button(/exit demo/i).click();
    await lab.button(/^reset$/i).click();
    expect(await lab.state((s) => [s.mode, s.demo.active, s.result])).toEqual(["IDLE", false, null]);
  });

  test("tab hidden and shown keeps the sim alive and bounded", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(4);
    await lab.button(/run test/i).click();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await lab.fastForward(2);
    const g = await lab.state((s) => s.engine.gantry);
    expect(Number.isFinite(g.x.pos) && g.x.pos >= 0 && g.x.pos <= 100).toBe(true);
    expect(await lab.state((s) => s.mode)).toBe("TEST");
  });
});
