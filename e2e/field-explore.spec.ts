import type { Page } from "@playwright/test";
import { expect, test } from "./field";

/*
 * Free exploration of the open-water sites. Regression for "the environments cannot be freely explored and are stuck":
 * the overview used to lock the orbit pivot at the site centre (no pan, horizon clamp at 0.49 pi) and refit itself
 * whenever the layout changed, so the user could only spin around one point.
 */

interface Pose {
  view: string;
  exploring: boolean;
  p: [number, number, number];
  t: [number, number, number];
}

const pose = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as { __fieldCamera: { camera: { position: { x: number; y: number; z: number } }; rig: { controls: { target: { x: number; y: number; z: number } } } } }).__fieldCamera;
    const s = window.__fieldStore!.getState();
    const p = c.camera.position;
    const t = c.rig.controls.target;
    return { view: s.view, exploring: s.exploring, p: [p.x, p.y, p.z], t: [t.x, t.y, t.z] } as Pose;
  });

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Polls from Node until the camera holds still (damping and glides finished). */
async function settle(page: Page) {
  let prev = await pose(page);
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(300);
    const cur = await pose(page);
    if (dist(prev.p, cur.p) < 1e-3 && dist(prev.t, cur.t) < 1e-3) return cur;
    prev = cur;
  }
  throw new Error("camera did not settle");
}

async function drag(page: Page, dx: number, dy: number, button: "left" | "right" = "left") {
  const vp = page.viewportSize()!;
  const x = vp.width * 0.4;
  const y = vp.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + (dx * i) / 12, y + (dy * i) / 12);
  await page.mouse.up({ button });
}

test.describe("field exploration", () => {
  test("pan moves the pivot, the first gesture hands the camera to the free view, recenter brings the overview back", async ({ page, field }) => {
    test.setTimeout(240_000);
    await field.open();
    const home = await settle(page);
    expect(home.view).toBe("overview");

    await drag(page, 220, 0, "right");
    const panned = await settle(page);
    expect(panned.view).toBe("free");
    expect(dist(panned.t, home.t), "right-drag must pan the pivot").toBeGreaterThan(2);

    // a layout change (another workspace card) must not pull the camera back to the overview fit
    await page.getByLabel("02 Platform").first().click();
    await page.waitForTimeout(600);
    const after = await settle(page);
    expect(dist(after.t, panned.t)).toBeLessThan(0.5);

    await page.keyboard.press("c");
    const back = await settle(page);
    expect(back.view).toBe("overview");
    expect(dist(back.t, home.t)).toBeLessThan(0.5);
  });

  test("arrow keys glide the pivot; the camera can look up from the seabed and never goes through it", async ({ page, field }) => {
    test.setTimeout(240_000);
    await field.open();
    const home = await settle(page);
    await page.keyboard.down("ArrowUp");
    await page.waitForTimeout(1200);
    await page.keyboard.up("ArrowUp");
    const glided = await settle(page);
    expect(glided.view).toBe("free");
    expect(dist(glided.t, home.t)).toBeGreaterThan(2);
    // a forward glide stays level, except where the pivot rides up over a higher bed
    expect(glided.t[1]).toBeGreaterThanOrEqual(home.t[1] - 1e-6);

    // orbit far below the old horizon clamp: the camera stops on the bed, inside the site
    for (let i = 0; i < 3; i++) await drag(page, 0, -350);
    const low = await settle(page);
    const check = await page.evaluate(([x, z]) => {
      const e = window.__fieldStore!.getState().engine as unknown as { bed: (x: number, z: number) => number; env: { geometry: { extentM: [number, number] } } };
      return { bed: e.bed(x, z), extent: e.env.geometry.extentM };
    }, [low.p[0], low.p[2]] as const);
    expect(low.p[1], "camera below the surface").toBeLessThan(0);
    expect(low.p[1], "camera above the seabed").toBeGreaterThanOrEqual(check.bed + 0.35);
    expect(Math.abs(low.p[0])).toBeLessThanOrEqual(check.extent[0] / 2 + 1e-6);
    expect(Math.abs(low.p[2])).toBeLessThanOrEqual(check.extent[1] / 2 + 1e-6);
  });

  test("explore hides the panels and the feed pass, H and Esc toggle it, switching site reopens the overview", async ({ page, field }) => {
    test.setTimeout(240_000);
    await field.open();
    await settle(page);
    await page.getByRole("button", { name: /explore/i }).click();
    await expect(page.getByTestId("explore-hint")).toBeVisible();
    for (const sel of ["[data-field='column']", "[data-field='card']"]) await expect(page.locator(sel)).toBeHidden();
    // the feed pass stops with the panels, so no camera image is painted where the hidden column was
    await expect.poll(() => page.evaluate(() => window.__fieldStats!.feedCalls), { timeout: 10_000 }).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("explore-hint")).toBeHidden();
    await expect(page.locator("[data-field='card']")).toBeVisible();
    await page.keyboard.press("h");
    await expect(page.getByTestId("explore-hint")).toBeVisible();
    await page.keyboard.press("h");
    await expect(page.getByTestId("explore-hint")).toBeHidden();

    await drag(page, 200, 0);
    await expect.poll(async () => (await pose(page)).view).toBe("free");
    await page.locator('button[data-env="deepsea"]').click();
    await field.waitWorld("deepsea");
    const deep = await settle(page);
    expect(deep.view).toBe("overview");
    // framed on the deep site, 1.5 km below the harbour
    expect(deep.t[1]).toBeLessThan(-1000);
  });
});
