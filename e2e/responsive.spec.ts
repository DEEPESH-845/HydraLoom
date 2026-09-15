import { expect, test } from "./lab";

const SIZES = [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [1024, 768],
  [768, 1024],
  [390, 844],
] as const;

for (const [w, h] of SIZES) {
  test(`${w}x${h}: primary controls usable, nothing overflows`, async ({ lab, page }) => {
    await page.setViewportSize({ width: w, height: h });
    await lab.open();
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(o.sw).toBeLessThanOrEqual(o.cw);
    const inView = async (name: RegExp) => {
      const b = (await lab.button(name).first().boundingBox())!;
      expect(b, name.source).not.toBeNull();
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(w + 1);
      expect(b.y + b.height).toBeLessThanOrEqual(h + 1);
    };
    await inView(/run demo/i);
    await inView(/^reset$/i);
    await inView(/run simulation/i);
    await expect(page.getByText("GANTRYLAB")).toBeVisible();
    await expect(page.locator("#gantry-camera-feed")).toBeVisible();
    for (const n of [4, 6]) {
      await lab.scene(n);
      const card = page.locator(".panel", { has: page.getByRole("heading") }).first();
      const cb = (await card.boundingBox())!;
      expect(cb.x).toBeGreaterThanOrEqual(0);
      expect(cb.x + cb.width).toBeLessThanOrEqual(w + 1);
      expect(cb.y + cb.height).toBeLessThanOrEqual(h + 1);
    }
    await expect(page).toHaveScreenshot(`scene6-${w}x${h}.png`, { maxDiffPixelRatio: 0.05 });
  });
}
