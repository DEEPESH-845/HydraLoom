import { expect, test } from "./lab";

/** Composition snapshots of the important states. 3D is software-rendered, so the tolerance is loose. */
test.describe("visual", () => {
  test("initial, system, detection, gantry, control, scenario, result", async ({ lab, page }) => {
    await lab.open();
    // caustics, ripples and particles animate; freeze them so the frames are deterministic
    await page.evaluate(() => (window as unknown as { __labFreezeWater?: (t: number) => void }).__labFreezeWater?.(0));
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      await lab.scene(n);
      await page.waitForTimeout(1000); // card swap and any layout refit start inside this window
      await lab.settleCamera();
      await expect(page).toHaveScreenshot(`scene${n}.png`, { maxDiffPixelRatio: 0.04, animations: "disabled", timeout: 60_000 });
    }
  });
});
