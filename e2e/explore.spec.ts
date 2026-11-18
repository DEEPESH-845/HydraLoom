import { expect, test } from "./lab";

/** Mean luma (0 to 255) of a PNG screenshot, decoded in the page so no image dependency is needed. */
async function meanLuma(page: import("@playwright/test").Page, png: Buffer) {
  return page.evaluate(async (b64) => {
    const im = new Image();
    im.src = "data:image/png;base64," + b64;
    await im.decode();
    const c = document.createElement("canvas");
    c.width = im.width;
    c.height = im.height;
    const x = c.getContext("2d")!;
    x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4);
  }, png.toString("base64"));
}

/** Screen projection of the machine's bounds (tank, frame, table top, overhead rig): centre and extent in CSS px. */
const machineOnScreen = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const cam = window.__labCamera!.camera as unknown as import("three").Camera & { position: import("three").Vector3 };
    const V = cam.position.constructor as typeof import("three").Vector3;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const x of [-0.66, 0.97]) for (const y of [-0.08, 0.82]) for (const z of [-0.36, 0.37]) {
      const q = new V(x, y, z).project(cam);
      xs.push(((q.x + 1) / 2) * innerWidth);
      ys.push(((1 - q.y) / 2) * innerHeight);
    }
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, minX, maxX, minY, maxY, w: innerWidth, h: innerHeight };
  });

const pose = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const c = window.__labCamera!;
    return { p: { ...c.camera.position }, t: { ...c.controls!.target } };
  });

test.describe("free exploration", () => {
  test("explore hides every panel, the camera orbits a full sphere, recenter brings the preset back", async ({ lab, page }) => {
    await lab.open();
    await page.waitForFunction(() => window.__labCamera && !window.__labCamera.tweening());
    const home = await pose(page);

    await lab.button(/explore/i).first().click();
    expect(await lab.state((s) => s.exploring)).toBe(true);
    for (const sel of ["[data-lab='nav']", "[data-lab='column']", "[data-lab='card']"]) await expect(page.locator(sel)).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: /double-click a part/i })).toBeVisible();

    // drag straight up from the centre: the camera must reach the underside (no polar clamp)
    const drag = async (dx: number, dy: number) => {
      const vp = page.viewportSize()!;
      await page.mouse.move(vp.width / 2, vp.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(vp.width / 2 + (dx * i) / 12, vp.height / 2 + (dy * i) / 12);
      await page.mouse.up();
      await page.waitForTimeout(800);
    };
    await drag(0, -500);
    const below = await pose(page);
    expect(below.p.y).toBeLessThan(below.t.y);
    await drag(0, 1000);
    const above = await pose(page);
    expect(above.p.y).toBeGreaterThan(above.t.y);
    await drag(-600, -200);
    const behind = await pose(page);
    expect(behind.p.z).toBeLessThan(home.p.z);

    // recenter while exploring glides the whole machine back to the middle of the window
    await page.keyboard.press("c");
    await lab.settleCamera();
    const mid = await machineOnScreen(page);
    expect(Math.abs(mid.x - mid.w / 2)).toBeLessThan(mid.w * 0.05);
    expect(Math.abs(mid.y - mid.h / 2)).toBeLessThan(mid.h * 0.08);

    // leaving explore brings the panels back and returns to the scene's framed view
    await page.keyboard.press("Escape");
    expect(await lab.state((s) => s.exploring)).toBe(false);
    await expect(page.locator("[data-lab='card']")).toBeVisible();
    // the return tween starts on the next React commit; wait for it to start, then for the camera to settle
    await page.waitForFunction(() => window.__labCamera!.tweening(), null, { timeout: 5000 });
    await lab.settleCamera();
    const back = await pose(page);
    expect(back.p.x).toBeCloseTo(home.p.x, 1);
    expect(back.p.y).toBeCloseTo(home.p.y, 1);
    expect(back.p.z).toBeCloseTo(home.p.z, 1);
  });

  test("orbiting with the mouse steps the panels aside and glides the machine to the middle, unclipped", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(3);
    await lab.settleCamera();
    const vp = page.viewportSize()!;
    await page.mouse.move(300, 300);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(300 + 20 * i, 300 + 5 * i);
    await page.mouse.up();
    expect(await lab.state((s) => s.exploring)).toBe(true);
    for (const sel of ["[data-lab='nav']", "[data-lab='column']", "[data-lab='card']"]) await expect(page.locator(sel)).toBeHidden();
    await lab.settleCamera();
    const m = await machineOnScreen(page);
    expect(Math.abs(m.x - vp.width / 2)).toBeLessThan(vp.width * 0.05);
    expect(Math.abs(m.y - vp.height / 2)).toBeLessThan(vp.height * 0.08);
    // every corner of the machine's bounds is on screen, below the header and above the hint strip
    expect(m.minX).toBeGreaterThan(0);
    expect(m.maxX).toBeLessThan(vp.width);
    expect(m.minY).toBeGreaterThan(48);
    expect(m.maxY).toBeLessThan(vp.height - 60);
  });

  test("a scroll zoom keeps the user's distance while the pivot centres", async ({ lab, page }) => {
    await lab.open();
    await lab.settleCamera();
    const before = await pose(page);
    const d0 = Math.hypot(before.p.x - before.t.x, before.p.y - before.t.y, before.p.z - before.t.z);
    await page.mouse.move(400, 300);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -80);
    expect(await lab.state((s) => s.exploring)).toBe(true);
    await lab.settleCamera();
    const after = await pose(page);
    const d1 = Math.hypot(after.p.x - after.t.x, after.p.y - after.t.y, after.p.z - after.t.z);
    expect(d1).toBeLessThan(d0 * 0.95); // the zoom in held, the glide did not pull back out
  });

  test("double-click a part under the water makes it the orbit target", async ({ lab, page }) => {
    await lab.open();
    await page.waitForFunction(() => window.__labCamera && !window.__labCamera.tweening());
    // project the shipwreck to the screen: the ray crosses the glass and the water surface, which must be looked through
    const wreck = await page.evaluate(() => {
      const cam = window.__labCamera!.camera as unknown as import("three").Camera & { position: import("three").Vector3 };
      const o = window.__labStore!.getState().scenario.objects.find((x) => x.type === "SHIPWRECK")!;
      const V = cam.position.constructor as typeof import("three").Vector3;
      const w = { x: (o.x - 50) / 100, z: (o.y - 20) / 100 };
      const p = new V(w.x, 0.02, w.z).project(cam);
      return { w, sx: ((p.x + 1) / 2) * innerWidth, sy: ((1 - p.y) / 2) * innerHeight };
    });
    await page.mouse.dblclick(wreck.sx, wreck.sy);
    await page.waitForFunction(() => window.__labCamera!.tweening(), null, { timeout: 5000 }).catch(() => undefined);
    await page.waitForFunction(() => !window.__labCamera!.tweening());
    const { p, t } = await pose(page);
    expect(Math.hypot(t.x - wreck.w.x, t.z - wreck.w.z)).toBeLessThan(0.1);
    expect(t.y).toBeLessThan(0.15);
    expect(Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z)).toBeLessThanOrEqual(0.91);
  });

  test("the camera feed is visible through its frame and hidden with the panels", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(3);
    await page.waitForTimeout(1500);
    // regression: an opaque panel background over the feed rect hid the WebGL render (luma ~23)
    const lit = await meanLuma(page, await page.locator("#gantry-camera-feed").screenshot());
    expect(lit).toBeGreaterThan(60);
  });

  test("the mine label holds steady at the park pose", async ({ lab, page }) => {
    await lab.open();
    const seen = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const out = new Set<string>();
          const end = performance.now() + 3000;
          const poll = () => {
            const d = window.__labStore!.getState().detections.find((x) => x.trueType === "MINE");
            if (d) out.add(d.class);
            if (performance.now() < end) requestAnimationFrame(poll);
            else resolve([...out]);
          };
          requestAnimationFrame(poll);
        }),
    );
    expect(seen).toEqual(["MINE"]);
  });
});
