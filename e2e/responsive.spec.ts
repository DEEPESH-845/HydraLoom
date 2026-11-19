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
    // caustics, ripples and particles animate; freeze them so the frames are deterministic
    await page.evaluate(() => (window as unknown as { __labFreezeWater?: (t: number) => void }).__labFreezeWater?.(0));
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
    // the brand sits in an overflow-hidden block, so visible is not enough: it must not be clipped by the header buttons
    const brand = await page.getByText("GANTRYLAB").evaluate((el) => ({ right: el.getBoundingClientRect().right, box: el.parentElement!.getBoundingClientRect().right }));
    expect(brand.right).toBeLessThanOrEqual(brand.box + 0.5);
    await expect(page.locator("#gantry-camera-feed")).toBeVisible();
    for (const n of [4, 6]) {
      await lab.scene(n);
      const card = page.locator(".panel", { has: page.getByRole("heading") }).first();
      await expect(card).toBeVisible(); // the card swap animates out and in, so it can be absent for a moment
      const cb = (await card.boundingBox())!;
      expect(cb.x).toBeGreaterThanOrEqual(0);
      expect(cb.x + cb.width).toBeLessThanOrEqual(w + 1);
      expect(cb.y + cb.height).toBeLessThanOrEqual(h + 1);
    }
    await page.waitForTimeout(1000); // card swap and any layout refit start inside this window
    await lab.settleCamera();
    // layout regression only: the software-rendered 3D view (and the feed drawn into it) is masked out
    await expect(page).toHaveScreenshot(`scene6-${w}x${h}.png`, { maxDiffPixelRatio: 0.05, mask: [page.locator("canvas")] });
  });
}
