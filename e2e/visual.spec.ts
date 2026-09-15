import { expect, test } from "./lab";

/** Composition snapshots of the important states. 3D is software-rendered, so the tolerance is loose. */
test.describe("visual", () => {
  test("initial, system, detection, gantry, control, scenario, result", async ({ lab, page }) => {
    await lab.open();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      await lab.scene(n);
      await page.waitForTimeout(2200);
      await expect(page).toHaveScreenshot(`scene${n}.png`, { maxDiffPixelRatio: 0.04, animations: "disabled" });
    }
  });
});
