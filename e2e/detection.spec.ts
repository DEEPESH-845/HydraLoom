import { expect, test } from "./lab";

test.describe("detection", () => {
  test("parked over the tank the feed shows labelled boxes that match the store", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(3);
    await lab.waitFor((s) => s.detections.length >= 2);
    // VISION widens the right column (300 to 440 px); measure the feed only once that animation and the camera are done
    await lab.settleCamera();
    const dets = await lab.state((s) => s.detections);
    const feed = page.locator("#gantry-camera-feed");
    // the column slides while it widens; wait until the feed box holds still before comparing positions to it
    await expect
      .poll(async () => {
        const a = await feed.boundingBox();
        await page.waitForTimeout(150);
        const b = await feed.boundingBox();
        return !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.width - b.width) < 0.5;
      })
      .toBe(true);
    for (const d of dets) {
      const fb = (await feed.boundingBox())!;
      expect(d.confidence).toBeGreaterThanOrEqual(0.6 - 0.05);
      expect(d.bbox.every((v) => v >= 0 && v <= 1)).toBe(true);
      // the DOM box for this detection sits where the normalised bbox says
      const label = feed.getByText(new RegExp(`^${d.class} `)).first();
      await expect(label).toBeVisible();
      const lb = (await label.boundingBox())!;
      expect(lb.x).toBeGreaterThanOrEqual(fb.x - 1);
      expect(lb.x + lb.width).toBeLessThanOrEqual(fb.x + fb.width + 1);
    }
    // vision card lists the same detections with confidence, coordinates and state
    for (const d of dets) {
      const row = page.locator("div.grid", { hasText: d.class }).filter({ hasText: "TRACK" }).first();
      await expect(row).toContainText(`${(d.confidence * 100).toFixed(1)}%`.slice(0, 3));
      await expect(row).toContainText(/LOCKED|DETECTED/);
    }
  });

  test("lock ages, and moving away clears detections", async ({ lab }) => {
    await lab.open();
    await lab.fastForward(2);
    const locked = await lab.state((s) => s.detections.filter((d) => d.state === "LOCKED").length);
    expect(locked).toBeGreaterThan(0);
    await lab.page.evaluate(() => window.__labStore!.getState().moveGantryTo(100, 40));
    await lab.fastForward(15);
    // the wreck and mine are more than a footprint away from (100, 40); only the crate at (93, 35) can remain
    const ids = await lab.state((s) => s.detections.map((d) => d.objectId));
    expect(ids).not.toContain("wreck-01");
    expect(ids).not.toContain("mine-01");
    expect(ids.every((id) => id === "debris-crate")).toBe(true);
  });

  test("turbidity 1 or lighting 0 detects nothing; threshold gates the count", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(6);
    const turb = page.locator("label", { hasText: "Turbidity" }).locator("input[type=range]");
    await turb.fill("1");
    await lab.fastForward(2);
    expect(await lab.state((s) => s.detections.length)).toBe(0);
    await turb.fill("0.15");
    const light = page.locator("label", { hasText: "Lighting" }).locator("input[type=range]");
    await light.fill("0");
    await lab.fastForward(2);
    expect(await lab.state((s) => s.detections.length)).toBe(0);
    await light.fill("0.8");
    const thr = page.locator("label", { hasText: "Detection threshold" }).locator("input[type=range]");
    await thr.fill("0.3");
    await lab.fastForward(2);
    const low = await lab.state((s) => s.detections.length);
    await thr.fill("0.95");
    await lab.fastForward(2);
    const high = await lab.state((s) => s.detections.length);
    expect(low).toBeGreaterThan(high);
  });
});
