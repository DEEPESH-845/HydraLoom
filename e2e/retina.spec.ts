import { expect, test, type Page } from "@playwright/test";

/**
 * High-density displays. three's setViewport takes CSS pixels: passing device pixels drew everything 1.5 times too large,
 * put the camera feed outside its panel, and captured frames that did not match their labels. Invisible at ratio 1.
 */

const viewport = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector("canvas")!;
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl"))!;
    return { v: Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array), buffer: [c.width, c.height], css: [c.clientWidth, c.clientHeight] };
  });

for (const scale of [1, 2, 3])
  test.describe(`device pixel ratio ${scale}`, () => {
    test.use({ deviceScaleFactor: scale, viewport: { width: 1280, height: 800 } });
    for (const path of ["/", "/lab"])
      test(`the picture fills the canvas on ${path}`, async ({ page }) => {
        test.setTimeout(180_000);
        await page.goto(path);
        await page.waitForFunction(() => !!document.querySelector("canvas") && document.querySelector("canvas")!.width > 300, null, { timeout: 120_000 });
        await page.waitForTimeout(4000);
        const s = await viewport(page);
        expect(s.v).toEqual([0, 0, ...s.buffer]);
        expect(s.css).toEqual([1280, 800]);
        await page.screenshot({ path: `e2e/.results/workbench/retina${path.replace("/", "-")}-${scale}.png` });
      });
  });

test("a captured frame and its labels are the same at every pixel ratio", async ({ browser }) => {
  test.setTimeout(300_000);
  const shoot = async (scale: number) => {
    const ctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => window.localStorage.setItem("gantrylab.field.selection.v1", JSON.stringify({ env: "reef", platform: "station" })));
    await page.route(/\/api\/v1\//, (r) => r.abort());
    await page.goto("/");
    await page.waitForFunction(() => !!window.__fieldStore && window.__fieldStore.getState().worldReady && window.__fieldStore.getState().telemetry.time > 0, null, { timeout: 120_000 });
    await page.evaluate(() => {
      (window as unknown as { __fieldFreezeWater: (t: number) => void }).__fieldFreezeWater(5);
      window.__fieldStore!.getState().reset();
      window.__fieldStore!.getState().setPaused(true);
      window.__fieldStore!.getState().setWorkspace("analysis");
    });
    await page.getByTestId("capture-frames").fill("1");
    await page.getByRole("button", { name: /^capture$/i }).click();
    await page.waitForFunction(() => ((window as unknown as { __fieldCapture?: { frames: unknown[] } }).__fieldCapture?.frames.length ?? 0) > 0, null, { timeout: 120_000 });
    const out = await page.evaluate(async () => {
      const cap = (window as unknown as { __fieldCapture: { frames: { png: Blob; frame: { annotations: { object_id: string; bbox_xywh: number[] }[] } }[] } }).__fieldCapture;
      const bmp = await createImageBitmap(cap.frames[0].png);
      const c = new OffscreenCanvas(64, 36);
      const g = c.getContext("2d")!;
      g.drawImage(bmp, 0, 0, 64, 36);
      return { px: Array.from(g.getImageData(0, 0, 64, 36).data), boxes: cap.frames[0].frame.annotations.map((a) => [a.object_id, ...a.bbox_xywh]) };
    });
    await ctx.close();
    return out;
  };
  const a = await shoot(1);
  const b = await shoot(2);
  expect(a.boxes.length).toBeGreaterThan(0);
  expect(b.boxes).toEqual(a.boxes);
  const diff = a.px.reduce((s, v, i) => s + Math.abs(v - b.px[i]), 0) / a.px.length;
  expect(diff, "mean pixel difference").toBeLessThan(3);
});
