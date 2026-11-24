import type { Page } from "@playwright/test";
import type { EnvironmentId } from "@/lib/sim/environments";
import { expect, test } from "./lab";

/** Mean luma (0 to 255) of a PNG screenshot, decoded in the page so no image dependency is needed. */
async function meanLuma(page: Page, png: Buffer) {
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

/** Which tank groups are mounted in the live three.js scene: "aquarium" and the "tank-dressing-<id>" of the environment. */
const sites = (page: Page) =>
  page.evaluate(() => {
    const scene = (window as unknown as { __labScene?: import("three").Scene }).__labScene!;
    const names: string[] = [];
    scene.traverse((o) => {
      if (o.name === "aquarium" || o.name.startsWith("tank-dressing-")) names.push(o.name);
    });
    return names.sort();
  });

const switchTo = (page: Page, environment: EnvironmentId) =>
  page.evaluate((environment) => window.__labStore!.getState().setScenario({ environment }), environment);

// Mean feed luma: the default tank reads about 100, the default harbor (dark green water) about 25, a black feed below 5.
const FIELD: EnvironmentId[] = ["harbor", "river", "deepsea"];
const NOT_BLACK = 10;

test.describe("environment switching keeps GPU memory flat", () => {
  test("cycling every environment releases the previous dressing's geometries", async ({ lab, page }) => {
    // regression: each switch built a new dressing (scatter, props) and a new particle cloud and never disposed the
    // old ones, about 13 geometries per cycle
    test.setTimeout(600_000);
    await lab.open();
    const cycle = async () => {
      for (const id of [...FIELD, "tank"] as EnvironmentId[]) {
        await switchTo(page, id);
        // the dressing actually mounted (siteReady alone can still read true before the veil drops)
        await expect.poll(() => sites(page), { timeout: 120_000 }).toEqual(["aquarium", `tank-dressing-${id}`]);
        await lab.waitFor((s) => s.siteReady, undefined, 120_000);
      }
    };
    const geometries = () => page.evaluate(() => (window.__labStats as unknown as { geometries: number }).geometries);
    // two warm-up cycles: every dressing and the idle-time shader warm-up have run once
    await cycle();
    await cycle();
    // disposal is deferred 4 s (StrictMode-safe); wait it out before every reading
    await page.waitForTimeout(6000);
    const first = await geometries();
    await cycle();
    await cycle();
    await page.waitForTimeout(6000);
    expect(await geometries()).toBeLessThanOrEqual(first);
  });
});

test.describe("environments", () => {
  test("each environment dresses the same tank, renders a lit feed, and the lab tank comes back", async ({ lab, page }) => {
    // software GL renders the lamp-lit deep sea at a few frames per second; a single feed screenshot can take long
    test.setTimeout(600_000);
    await lab.open();
    await lab.scene(3);
    await expect.poll(() => sites(page)).toEqual(["aquarium", "tank-dressing-tank"]);
    const feed = page.locator("#gantry-camera-feed");
    await expect(feed).toBeVisible();

    for (const id of FIELD) {
      await switchTo(page, id);
      await lab.waitFor((s, id) => s.scenario.environment === id, id);
      // the same tank, dressed for this environment and no other
      await expect.poll(() => sites(page), { timeout: 30_000 }).toEqual(["aquarium", `tank-dressing-${id}`]);
      await expect
        .poll(async () => meanLuma(page, await feed.screenshot()), { message: `${id} feed is black`, timeout: 120_000 })
        .toBeGreaterThan(NOT_BLACK);
      // still the same dressing: a dev-server reload would have put the lab tank back
      expect(await sites(page)).toEqual(["aquarium", `tank-dressing-${id}`]);
    }

    await switchTo(page, "tank");
    await lab.waitFor((s) => s.scenario.environment === "tank" && s.scenario.turbidity === 0.15 && s.scenario.lighting === 0.8);
    await expect.poll(() => sites(page), { timeout: 30_000 }).toEqual(["aquarium", "tank-dressing-tank"]);
    await expect.poll(async () => meanLuma(page, await feed.screenshot()), { timeout: 30_000 }).toBeGreaterThan(60);
  });
});
