import { expect, test } from "./lab";

/*
 * Regressions from the 2026-11-24 bug audit (docs/BUG_AUDIT.md). Each test reproduces the defect through the UI and
 * fails on the code before its fix.
 */

test.describe("audit regressions", () => {
  test("BUG-04: after a manual move the gantry card shows MANUAL, not the last episode's target", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(5);
    await lab.button(/run episode/i).click();
    await lab.waitFor((s) => s.rl.active);
    await lab.fastForward(90);
    await lab.waitFor((s) => s.rl.done && s.rl.targetId === "wreck-01");
    await lab.scene(4);
    const pad = page.locator("[title='Click to move the gantry']");
    const box = (await pad.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.3);
    await lab.waitFor((s) => s.mode === "MANUAL");
    const card = page.locator("[data-lab='card']");
    await expect(card.getByText("MANUAL", { exact: true }).first()).toBeVisible();
    await expect(card.getByText("Shipwreck section")).toHaveCount(1); // only the Track chip, no longer the Target row
    await expect(card.getByRole("button", { name: "Shipwreck section" })).not.toHaveClass(/border-amber/);
  });

  test("BUG-05: the result card says a test is running, or that it was stopped, never 'no test has run'", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(4);
    await lab.button(/run test/i).click();
    await lab.fastForward(80);
    await lab.waitFor((s) => s.phase === "COMPLETE", 90_000);
    await lab.button(/run test/i).click();
    await lab.fastForward(15);
    await lab.waitFor((s) => s.phase === "SCANNING" || s.phase === "DETECTING");
    await lab.scene(7);
    await expect(page.getByText(/A test is running/)).toBeVisible();
    await lab.scene(4);
    await lab.button(/^stop$/i).click();
    await lab.scene(7);
    await expect(page.getByText(/stopped before it completed/)).toBeVisible();
    await expect(page.getByText("No test has run yet.")).toHaveCount(0);
  });

  test("BUG-06: leaving a 3D callout returns to the pinned component's highlight", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(2);
    await lab.settleCamera();
    const card = page.locator("[data-lab='card']");
    await card.getByRole("button", { name: /gantry/i }).first().click();
    await lab.waitFor((s) => s.highlight === "gantry" && s.pinnedHighlight === "gantry");
    const callout = page.locator(".panel.label", { hasText: "ARDUINO" });
    // Callouts are re-laid out every frame and the software-GL layout can tuck one under the card, so the pointer
    // events go to the callout itself (React's enter/leave are built from pointerover/pointerout).
    await callout.dispatchEvent("pointerover", { pointerType: "mouse" });
    await lab.waitFor((s) => s.highlight === "arduino");
    await callout.dispatchEvent("pointerout", { pointerType: "mouse" });
    await lab.waitFor((s) => s.highlight === "gantry");
    // leaving the scene clears the pin with the highlight
    await lab.scene(3);
    expect(await lab.state((s) => [s.highlight, s.pinnedHighlight])).toEqual([null, null]);
  });

  test("BUG-07: the XY pad shows the selected strategy's viewpoints", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(4);
    const dots = page.locator("[title='Click to move the gantry'] [data-waypoint]");
    await expect(dots).toHaveCount(6);
    await page.evaluate(() => window.__labStore!.getState().setScenario({ strategy: "coverage" }));
    await expect.poll(() => dots.count()).toBeGreaterThan(6);
    await page.evaluate(() => window.__labStore!.getState().setScenario({ strategy: "uncertainty" }));
    await expect(dots).toHaveCount(0);
    await page.evaluate(() => window.__labStore!.getState().setScenario({ strategy: "waypoints", waypoints: [[20, 10], [80, 30]] }));
    await expect(dots).toHaveCount(2);
  });

  test("BUG-08: a turbidity sweep capture never changes the live scenario", async ({ lab, page }) => {
    test.setTimeout(300_000);
    await page.route("**/api/v1/datasets", (route) => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "ds_sweep" }) }));
    await lab.open();
    await lab.scene(3);
    await lab.settleCamera();
    const before = await lab.state((s) => [s.scenario.turbidity, s.scenario.lighting]);
    // record every turbidity the store publishes while the sweep runs
    await page.evaluate(() => {
      const w = window as unknown as { __seen: number[] };
      w.__seen = [];
      window.__labStore!.subscribe((s) => w.__seen.push(s.scenario.turbidity));
    });
    await page.getByRole("button", { name: /capture dataset/i }).click();
    await page.getByLabel("Capture preset").selectOption("turbidity");
    await page.getByRole("button", { name: /capture and upload/i }).click();
    await expect(page.getByTestId("lab-capture").getByRole("status")).toContainText("Dataset ds_sweep", { timeout: 180_000 });
    const seen = await page.evaluate(() => [...new Set((window as unknown as { __seen: number[] }).__seen)]);
    expect(seen).toEqual([before[0]]);
    expect(await lab.state((s) => [s.scenario.turbidity, s.scenario.lighting])).toEqual(before);
  });
});
