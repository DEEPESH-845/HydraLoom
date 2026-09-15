import { expect, test } from "./lab";

test.describe("boot", () => {
  test("loads, renders the scene and publishes canonical state", async ({ lab, page }) => {
    await lab.open();
    await expect(page.getByText("GANTRYLAB")).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.locator("#gantry-camera-feed")).toBeVisible();
    const t = await lab.state((s) => s.telemetry);
    expect(t.system.source).toBe("SIMULATED");
    expect(t.gantry.x).toBe(50);
    expect(t.gantry.y).toBe(20);
    const calls = await page.evaluate(() => window.__labStats?.calls ?? 0);
    expect(calls).toBeGreaterThan(10);
  });

  test("no horizontal overflow at desktop", async ({ lab, page }) => {
    await lab.open();
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(o.sw).toBeLessThanOrEqual(o.cw);
  });
});
