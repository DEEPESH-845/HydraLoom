import { expect, test } from "./field";

/*
 * Field workspace (/field): open-water environments, platforms, water current, particles, missions, the platform
 * camera's projection and the synthetic dataset capture. State is read through the dev-only window.__fieldStore hook;
 * actions go through the UI unless a test needs an exact pose.
 */

const ENVS = ["harbor", "river", "deepsea", "reef", "lake", "ocean"] as const;


test("boots without console errors and shows the workspace", async ({ page, field, audit }) => {
  await field.open();
  await expect(page.getByText("GANTRYLAB", { exact: true })).toBeVisible();
  await expect(page.locator("#field-camera-feed")).toBeVisible();
  for (const name of ["01 Environment", "02 Platform", "03 Simulation", "04 Model Lab", "05 Analysis", "06 Reports"]) await expect(page.getByLabel(name).first()).toBeAttached();
  const stats = await page.evaluate(() => window.__fieldStats!);
  expect(stats.mainCalls).toBeGreaterThan(5);
  expect(stats.calls).toBeLessThan(300);
  expect(audit.warnings).toEqual([]);
});

test("no gantry, rail or beam exists in any field environment and the lab is not mounted", async ({ page, field }) => {
  await field.open();
  for (const env of ENVS) {
    await page.locator(`button[data-env="${env}"]`).click();
    await field.waitWorld(env);
    const bad = await page.evaluate(() => {
      const scene = (window as unknown as { __fieldScene: import("three").Scene }).__fieldScene;
      const names: string[] = [];
      scene.traverse((o) => {
        if (/gantry|rail|beam|carriage/i.test(o.name)) names.push(o.name);
      });
      return names;
    });
    expect(bad, env).toEqual([]);
    expect(await page.evaluate(() => "__labStore" in window)).toBe(false);
  }
});

test("switches through all six environments, each with its own site", async ({ page, field }) => {
  await field.open();
  for (const env of ENVS) {
    await page.locator(`button[data-env="${env}"]`).click();
    await field.waitWorld(env);
    const info = await page.evaluate(() => {
      const scene = (window as unknown as { __fieldScene: import("three").Scene }).__fieldScene;
      const sites: string[] = [];
      let targets = 0;
      let seabed = 0;
      scene.traverse((o) => {
        if (o.name.startsWith("field-site-")) sites.push(o.name);
        if (o.userData.gtId) targets++;
        if (o.name === "seabed") seabed++;
      });
      return { sites, targets, seabed };
    });
    expect(info.sites).toEqual([`field-site-${env}`]);
    expect(info.seabed).toBe(1);
    expect(info.targets).toBe(await field.state((s) => s.engine.targets.length));
    expect(await page.evaluate(() => window.__fieldStats!.calls)).toBeLessThan(300);
  }
});

test("platform compatibility is respected", async ({ page, field }) => {
  await field.open("harbor", "rov");
  await field.workspace("02").click();
  const auv = page.locator('button[data-platform="auv"]');
  await expect(auv).toBeDisabled();
  await expect(auv).toContainText(/too confined/i);
  await auv.click({ force: true }).catch(() => {});
  expect(await field.state((s) => s.platformId)).toBe("rov");
  await field.workspace("01").click();
  await page.locator('button[data-env="ocean"]').click();
  await field.waitWorld("ocean");
  await field.workspace("02").click();
  await page.locator('button[data-platform="auv"]').click();
  await field.waitFor((s) => s.platformId === "auv" && s.worldReady);
  await page.locator('button[data-platform="station"]').click();
  await field.waitFor((s) => s.platformId === "station" && s.worldReady);
  expect(await field.state((s) => s.engine.vehicle === null)).toBe(true);
});

test("current controls change the engine's current and the flow arrows", async ({ page, field }) => {
  await field.open("harbor");
  const speed = page.getByTestId("current-speed");
  await speed.fill("0.9");
  await page.getByTestId("current-dir").fill("200");
  await field.waitFor((s) => Math.abs(s.conditions.current.speedMps - 0.9) < 1e-6 && Math.abs(s.conditions.current.headingDeg - 200) < 1e-6);
  expect(await field.state((s) => s.engine.current.config.speedMps)).toBeCloseTo(0.9, 6);
  // the arrows refresh four times per second from the same field
  await page.waitForFunction(() => {
    const f = (window as unknown as { __fieldFlow: { heading: number; meanSpeed: number; meanDir: number[] } }).__fieldFlow;
    return Math.abs(f.heading - 200) < 1e-6 && f.meanSpeed > 0.3;
  });
  const dir = await page.evaluate(() => (window as unknown as { __fieldFlow: { meanDir: number[] } }).__fieldFlow.meanDir);
  const heading = ((Math.atan2(dir[0], -dir[2]) * 180) / Math.PI + 360) % 360;
  expect(Math.abs(((heading - 200 + 540) % 360) - 180)).toBeLessThan(15);
  // the dial is keyboard operable
  await page.getByTestId("current-dial").focus();
  await page.keyboard.press("ArrowRight");
  await field.waitFor((s) => Math.abs(s.conditions.current.headingDeg - 205) < 1e-6);
});

test("particles move with the water along the configured heading", async ({ page, field }) => {
  await field.open("harbor");
  await page.evaluate(() => window.__fieldStore!.getState().setConditions({ current: { speedMps: 0.5, headingDeg: 60, turbulence: 0.02, variability: 0, verticalMps: 0 } }));
  await page.evaluate(() => (window as unknown as { __fieldParticles: { reset: () => void } }).__fieldParticles.reset());
  // let a few seconds of simulated time pass in the live loop
  const t0 = await field.state((s) => s.engine.time);
  await field.waitFor((s, t) => s.engine.time > t + 3, t0, 120_000);
  const travel = await page.evaluate(() => (window as unknown as { __fieldParticles: { travel: number[] } }).__fieldParticles.travel);
  const h = Math.hypot(travel[0], travel[2]);
  expect(h).toBeGreaterThan(0.2);
  const heading = ((Math.atan2(travel[0], -travel[2]) * 180) / Math.PI + 360) % 360;
  expect(Math.abs(((heading - 60 + 540) % 360) - 180)).toBeLessThan(25);
});

test("ROV manual surge moves the vehicle forward", async ({ page, field }) => {
  await field.open("harbor", "rov");
  await page.evaluate(() => window.__fieldStore!.getState().setConditions({ current: { speedMps: 0 } }));
  const x0 = await field.state((s) => s.engine.vehicle!.position[0]);
  await page.locator("canvas").click({ position: { x: 600, y: 200 } });
  await page.keyboard.down("w");
  const t0 = await field.state((s) => s.engine.time);
  await field.waitFor((s, t) => s.engine.time > t + 4, t0, 120_000);
  await page.keyboard.up("w");
  const r = await field.state((s) => ({ x: s.engine.vehicle!.position[0], mode: s.engine.pilotTarget.mode, stick: s.engine.pilotTarget.stick.surge }));
  expect(r.mode).toBe("MANUAL");
  expect(r.stick).toBe(0);
  // heading 090: forward is east (+x)
  expect(r.x - x0).toBeGreaterThan(0.5);
});

test("a mission starts and progresses", async ({ page, field }) => {
  await field.open("harbor", "rov");
  await field.workspace("03").click();
  await page.getByRole("button", { name: /start mission/i }).click();
  await field.waitFor((s) => s.phase === "RUNNING");
  expect(await field.state((s) => s.engine.route().length)).toBeGreaterThan(1);
  const d0 = await field.state((s) => s.telemetry.pilot.distanceM);
  await field.fastForward(40);
  const r = await field.state((s) => ({ wp: s.telemetry.pilot.waypoint, d: s.telemetry.pilot.distanceM, phase: s.phase, events: s.events.map((e) => e.kind) }));
  expect(r.wp > 0 || r.d < d0 - 1).toBe(true);
  expect(r.events).toContain("MISSION");
  await page.getByRole("button", { name: /abort/i }).click();
  await field.waitFor((s) => s.phase === "COMPLETE" && !!s.result);
  await field.workspace("05").click();
  await expect(page.getByTestId("result")).toContainText("Targets found");
});

/** Puts the ROV 2.6 m west of a target, level, heading east, holding station, with the simulation paused. */
async function faceTarget(page: import("@playwright/test").Page, id: string, back = 2.6, up = 1.2) {
  await page.evaluate(
    ({ id, back, up }) => {
      const s = window.__fieldStore!.getState();
      const e = s.engine;
      e.setConditions({ current: { speedMps: 0 } });
      const t = e.targets.find((x) => x.id === id)!;
      const v = e.vehicle!;
      v.position = [t.position[0] - back, t.position[1] + up, t.position[2]];
      v.attitude = [0, 0, 0, 1];
      v.velocity = [0, 0, 0];
      v.angularVelocity = [0, 0, 0];
      e.setPilotMode("HOLD");
      e.tick(1 / 60);
      e.paused = true;
      s.publish();
    },
    { id, back, up },
  );
  await page.waitForTimeout(300);
}

test("the analytic projection of a target matches its rendered instance-id box", async ({ page, field }) => {
  await field.open("harbor", "rov");
  for (const id of ["crate-h1", "mine-h1"]) {
    await faceTarget(page, id);
    const p = await page.evaluate((id) => (window as unknown as { __fieldProbe: (id: string) => { rendered: number[] | null; pixels: number; analyticModel: number[] | null; analyticDeclared: number[] | null } }).__fieldProbe(id), id);
    expect(p.pixels, id).toBeGreaterThan(500);
    const r = p.rendered!;
    const a = p.analyticModel!;
    // a mesh's projected silhouette lies inside the projection of its bounding box and touches it on at least the
    // nearest edges; for a box-shaped crate every edge coincides
    const edges = [r[0] - a[0], r[1] - a[1], r[0] + r[2] - (a[0] + a[2]), r[1] + r[3] - (a[1] + a[3])];
    if (id === "crate-h1") for (const e of edges) expect(Math.abs(e), `${id} ${edges}`).toBeLessThan(3);
    else {
      expect(edges[0]).toBeGreaterThan(-3);
      expect(edges[1]).toBeGreaterThan(-3);
      expect(edges[2]).toBeLessThan(3);
      expect(edges[3]).toBeLessThan(3);
    }
    // the crate fills its declared box, so the engine's box (what the detector projects) lands on it too
    if (id === "crate-h1") {
      const d = p.analyticDeclared!;
      expect(Math.abs(r[0] + r[2] / 2 - (d[0] + d[2] / 2))).toBeLessThan(3);
      expect(Math.abs(r[1] + r[3] / 2 - (d[1] + d[3] / 2))).toBeLessThan(3);
    }
  }
});

test("dataset capture produces annotated frames matching the analytic projection and uploads them", async ({ page, field }) => {
  let posted: { manifest: string | null; files: number } | null = null;
  await page.route("**/api/v1/datasets", async (route) => {
    const body = route.request().postDataBuffer()?.toString("latin1") ?? "";
    posted = { manifest: /name="manifest"/.test(body) ? "yes" : null, files: (body.match(/name="files"; filename="\d{6}\.png"/g) ?? []).length };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "ds_test", n_frames: 3 }) });
  });
  await field.open("harbor", "rov");
  await faceTarget(page, "crate-h1", 3.2, 1.3);
  await field.workspace("05").click();
  await page.getByTestId("capture-frames").fill("3");
  await page.getByRole("button", { name: /^capture$/i }).click();
  await expect(page.getByTestId("capture-status")).toContainText(/Stored by the backend as ds_test/, { timeout: 120_000 });
  expect(posted).toEqual({ manifest: "yes", files: 3 });
  const cap = await page.evaluate(() => {
    const c = (window as unknown as { __fieldCapture: { manifest: unknown; frames: { frame: { annotations: { object_id: string; bbox_xywh: number[] }[] }; analytic: Record<string, number[]>; png: Blob }[] } }).__fieldCapture;
    return { manifest: c.manifest, frames: c.frames.map((f) => ({ analytic: f.analytic, annotations: f.frame.annotations, png: f.png.size, type: f.png.type })) };
  });
  const m = cap.manifest as { schema: string; seed: number; classes: string[]; generator: { app: string }; frames: { file: string; width: number; height: number; camera: { fx: number; hfov_deg: number }; conditions: Record<string, unknown> }[] };
  expect(m.schema).toBe("gantrylab.dataset/1");
  expect(m.generator.app).toBe("gantrylab-web");
  expect(m.classes).toEqual(["SHIPWRECK", "MINE", "DEBRIS", "TIRE", "PIPELINE"]);
  expect(m.frames.map((f) => f.file)).toEqual(["000001.png", "000002.png", "000003.png"]);
  expect(m.frames[0].width).toBe(640);
  expect(m.frames[0].height).toBe(360);
  expect(m.frames[0].camera.fx).toBeCloseTo(320 / Math.tan((80 * Math.PI) / 360), 2);
  expect(m.frames[0].conditions.environment).toBe("harbor");
  const crate = cap.frames[0].annotations.find((a) => a.object_id === "crate-h1");
  expect(crate, "crate annotated in the first (unjittered) frame").toBeTruthy();
  for (const f of cap.frames) {
    expect(f.type).toBe("image/png");
    expect(f.png).toBeGreaterThan(5000);
    for (const a of f.annotations) {
      const an = f.analytic[a.object_id];
      expect(an, a.object_id).toBeTruthy();
      const [x, y, w, h] = a.bbox_xywh;
      // visible pixels lie inside the analytic box of the model (occlusion and the frame edge only shrink them)
      expect(x).toBeGreaterThanOrEqual(Math.max(0, an[0]) - 3);
      expect(y).toBeGreaterThanOrEqual(Math.max(0, an[1]) - 3);
      expect(x + w).toBeLessThanOrEqual(Math.min(640, an[0] + an[2]) + 3);
      expect(y + h).toBeLessThanOrEqual(Math.min(360, an[1] + an[3]) + 3);
    }
  }
  // the unoccluded crate in the first frame fills its analytic box to within a few pixels on the top and sides
  const an = cap.frames[0].analytic["crate-h1"];
  const b = crate!.bbox_xywh;
  expect(Math.abs(b[0] - an[0])).toBeLessThan(4);
  expect(Math.abs(b[0] + b[2] - (an[0] + an[2]))).toBeLessThan(4);
  expect(Math.abs(b[1] - an[1])).toBeLessThan(4);
});

test("capture reports an unreachable backend and still allows saving the manifest", async ({ page, field }) => {
  await page.route("**/api/v1/datasets", (route) => route.abort("connectionrefused"));
  await field.open("reef", "rov");
  await field.workspace("05").click();
  await page.getByTestId("capture-frames").fill("1");
  await page.getByRole("button", { name: /^capture$/i }).click();
  await expect(page.getByTestId("capture-upload-error")).toContainText(/not reachable/i, { timeout: 120_000 });
  await expect(page.getByRole("button", { name: /save manifest/i })).toBeVisible();
});

for (const vp of [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
]) {
  test(`responsive at ${vp.width}x${vp.height}: no overflow and no overlapping panels`, async ({ page, field }) => {
    await page.setViewportSize(vp);
    await field.open("harbor", "rov");
    for (const ws of ["01", "02", "03", "05"]) {
      await field.workspace(ws).click();
      const id = { "01": "environment", "02": "platform", "03": "simulation", "05": "analysis" }[ws]!;
      await expect(page.getByTestId(`card-${id}`)).toBeVisible();
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const names = ["header", "column", "card", "nav", "site-tag", "compass"];
        const rects = names
          .map((n) => {
            const el = document.querySelector(`[data-field="${n}"]`) as HTMLElement | null;
            if (!el) return null;
            const b = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (b.width === 0 || b.height === 0 || cs.display === "none" || cs.visibility === "hidden") return null;
            return { n, x0: b.left, y0: b.top, x1: b.right, y1: b.bottom };
          })
          .filter(Boolean) as { n: string; x0: number; y0: number; x1: number; y1: number }[];
        const overlaps: string[] = [];
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i];
            const b = rects[j];
            if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1) overlaps.push(`${a.n}/${b.n}`);
          }
        const outside = rects.filter((q) => q.x0 < -1 || q.x1 > window.innerWidth + 1 || q.y1 > window.innerHeight + 1).map((q) => q.n);
        return { overlaps, outside, scrollW: document.documentElement.scrollWidth, w: window.innerWidth };
      });
      expect(r.overlaps, ws).toEqual([]);
      expect(r.outside, ws).toEqual([]);
      expect(r.scrollW).toBeLessThanOrEqual(r.w);
    }
    await page.screenshot({ path: `e2e/.results/field/responsive-${vp.width}x${vp.height}.png` });
  });
}

test("flying by hand to the wreck finds a SHIPWRECK in every environment", async ({ page, field }) => {
  test.setTimeout(600_000);
  await field.open("harbor", "rov");
  await field.workspace("05").click();
  for (const env of ["harbor", "river", "deepsea", "reef", "lake", "ocean"] as const) {
    if (env !== "harbor") {
      await page.evaluate((e) => window.__fieldStore!.getState().selectEnvironment(e), env);
      await field.waitWorld(env);
    }
    // something else may already be in view; the wreck must not be
    expect(await field.state((s) => s.finds.some((f) => f.trueClass === "SHIPWRECK")), env).toBe(false);
    // start 4 m off the hull at survey altitude, looking at it, then drive forward on the stick like a pilot
    await page.evaluate(() => {
      const s = window.__fieldStore!.getState();
      const e = s.engine;
      const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
      // broadside, from the side nearer the middle of the site (the other may be a river bank)
      const d = w.halfExtents[2] + 4;
      const sides = [Math.PI / 2, -Math.PI / 2].map((k) => k - (w.yawDeg * Math.PI) / 180);
      const at = (k: number) => [w.position[0] - Math.cos(k) * d, w.position[2] - Math.sin(k) * d];
      const a = sides.sort((p, q) => Math.hypot(...at(p)) - Math.hypot(...at(q)))[0];
      const [x, z] = at(a);
      // at deck height: the ground it starts over may be higher than the wreck's bed (the river bank)
      const deck = w.position[1] + w.halfExtents[1] * (1 - w.burial);
      e.vehicle!.position = [x, Math.max(deck - 0.1, e.floor(x, z) + 0.45), z];
      const yaw = Math.atan2(-Math.sin(a), Math.cos(a));
      e.vehicle!.attitude = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      e.vehicle!.velocity = [0, 0, 0];
      // no current: an unattended stick would be swept off the approach, which is correct but not what is tested here
      s.setConditions({ current: { speedMps: 0 } });
      s.setPilotMode("MANUAL");
      s.setStick({ surge: 0.2 });
    });
    for (let i = 0; i < 24 && !(await field.state((s) => s.finds.some((f) => f.class === "SHIPWRECK"))); i++) await field.fastForward(0.5);
    await expect(page.getByTestId("finds"), env).toContainText("SHIPWRECK");
    await expect(page.getByTestId("events"), env).toContainText("SHIPWRECK");
    if (env === "reef") await page.screenshot({ path: "e2e/.results/workbench/field-wreck.png" });
  }
});

test("roaming with the keyboard stays in the site, the chase camera too, and boxes stay on their objects", async ({ page, field }) => {
  test.setTimeout(400_000);
  await field.open("reef", "rov");
  await page.evaluate(() => {
    const s = window.__fieldStore!.getState();
    s.setView("follow");
    s.setTimeScale(8);
  });
  const inside = () =>
    page.evaluate(() => {
      const e = window.__fieldStore!.getState().engine;
      const b = e.bounds();
      const p = e.vehicle!.position;
      const c = (window as unknown as { __fieldCamera: { camera: { position: { x: number; y: number; z: number } } } }).__fieldCamera.camera.position;
      const [ex, ez] = e.env.geometry.extentM;
      return { vehicle: p[0] >= b.x0 && p[0] <= b.x1 && p[2] >= b.z0 && p[2] <= b.z1 && p[1] < 0, camera: Math.abs(c.x) <= ex / 2 + 0.01 && Math.abs(c.z) <= ez / 2 + 0.01 && c.y < 0 && c.y > e.floor(c.x, c.z) };
    });
  // the first frames still show the overview
  await expect.poll(async () => (await inside()).camera).toBe(true);
  for (const key of ["w", "q", "s", "e"]) {
    await page.keyboard.down(key);
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500);
      expect(await inside(), key).toEqual({ vehicle: true, camera: true });
    }
    await page.keyboard.up(key);
  }
  // hover over the wreck, moving: each drawn box is where the engine projects its object this very frame
  await page.evaluate(() => {
    const s = window.__fieldStore!.getState();
    s.setTimeScale(1);
    const e = s.engine;
    const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
    e.vehicle!.position = [w.position[0] - 5, w.position[1] + 2, w.position[2]];
    e.vehicle!.attitude = [0, 0, 0, 1];
    e.vehicle!.velocity = [0, 0, 0];
    s.setConditions({ current: { speedMps: 0 } });
    s.setPilotMode("MANUAL");
    s.setStick({ sway: 0.3 });
  });
  await field.waitFor((s) => s.detections.some((d) => d.class === "SHIPWRECK"));
  await expect(page.getByTestId("detection-strip")).toContainText("SHIPWRECK");
  await page.screenshot({ path: "e2e/.results/workbench/field-follow.png" });
  const gap = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let worst = 0;
        let n = 0;
        const tick = () => {
          const id = window.__fieldStore!.getState().engine.targets.find((t) => t.class === "SHIPWRECK")!.id;
          const el = document.querySelector<HTMLElement>(`[data-testid=feed-boxes] [data-target="${id}"]`);
          const d = window.__fieldStore!.getState().detections.find((q) => q.targetId === id);
          // the drawn box against the detector's last one: at 0.3 m/s they may differ by the motion of one reading at most
          if (el && d) worst = Math.max(worst, Math.abs(parseFloat(el.style.left) / 100 - d.bbox[0]));
          if (++n < 60) requestAnimationFrame(tick);
          else resolve(worst);
        };
        tick();
      }),
  );
  expect(gap).toBeLessThan(0.12);
  // explore mode hides the panels but not what is being detected
  await page.keyboard.press("h");
  await expect(page.getByTestId("detection-strip")).toContainText("SHIPWRECK");
  await expect(page.getByTestId("feed-boxes").locator("[data-target]").first()).toBeHidden();
  await page.keyboard.press("h");
  await page.evaluate(() => window.__fieldStore!.getState().setView("pilot"));
  await expect(page.getByTestId("pilot-boxes").locator("[data-target]").first()).toBeVisible();
  await page.screenshot({ path: "e2e/.results/workbench/field-pilot.png" });
});

test("site parameters, presets, checks and the sensitivity test drive the simulation", async ({ page, field }) => {
  test.setTimeout(240_000);
  await field.open("harbor", "rov");
  const vis0 = await field.state((s) => s.telemetry.visibilityM);
  // a preset changes water, light and current together and plans the altitude for it
  await page.locator("[data-preset=after-storm]").click();
  await field.waitFor((s) => s.conditions.site.waveHeightM === 0.4 && s.conditions.site.salinityPsu === 22);
  expect(await field.state((s) => s.telemetry.visibilityM)).toBeLessThan(vis0 * 0.7);
  const alt = await field.state((s) => [s.conditions.altitudeM, s.engine.plannedAltitude()]);
  expect(alt[0]).toBe(alt[1]);
  // a slider reaches the physics
  const rho = await field.state((s) => s.telemetry.densityKgM3);
  await page.locator("[data-group=Water] summary").click({ trial: true });
  if (!(await page.getByTestId("site-salinityPsu").isVisible())) await page.locator("[data-group=Water] summary").click();
  await page.getByTestId("site-salinityPsu").fill("0");
  await field.waitFor((s, r) => s.telemetry.densityKgM3 < (r as number) - 10, rho);
  await expect(page.locator("[data-testid=card-environment]")).toContainText("Fresh water");
  // what will not work is said before the run
  await page.evaluate(() => window.__fieldStore!.getState().setConditions({ altitudeM: 6, current: { speedMps: 1.6 } }));
  await expect(page.getByTestId("checks")).toContainText("Fly lower");
  await expect(page.getByTestId("checks")).toContainText("cannot hold station");
  await page.getByRole("button", { name: /^fly at/i }).click();
  await expect(page.getByTestId("checks")).not.toContainText("Fly lower");
  // defaults put everything back
  await page.getByTestId("conditions-default").click();
  await field.waitFor((s, v) => Math.abs(s.telemetry.visibilityM - (v as number)) < 1e-6, vis0);
  await page.screenshot({ path: "e2e/.results/workbench/field-parameters.png" });
  // a sweep runs beside the live engine and names the envelope
  await field.workspace("05").click();
  await page.getByTestId("sweep-param").selectOption("site.cPerNtu");
  await page.getByTestId("sweep-lo").fill("9");
  await expect(page.getByRole("button", { name: /run test/i })).toBeDisabled();
  await page.getByTestId("sweep-lo").fill("0.3");
  await page.getByTestId("sweep-hi").fill("2.5");
  const before = await field.state((s) => s.conditions.site.cPerNtu);
  await page.getByRole("button", { name: /run test/i }).click();
  await expect(page.getByRole("button", { name: /^csv$/i })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("sweep-result")).toContainText(/Classifies|Never/);
  expect(await field.state((s) => s.conditions.site.cPerNtu)).toBe(before);
});

test("letting go of a key stops the rover and keeps it there, however the key was let go", async ({ page, field }) => {
  test.setTimeout(240_000);
  await field.open("reef", "rov");
  const now = () =>
    field.state((s) => {
      const p = s.engine.vehicle!.position;
      return { t: s.engine.time, p: [p[0], p[1], p[2]], stick: { ...s.engine.pilotTarget.stick }, speed: s.telemetry.speedOverGround };
    });
  const after = async (dt: number) => {
    const t = (await now()).t;
    await field.waitFor((s, until) => s.engine.time > until, t + dt, 120_000);
    return now();
  };
  const stopped = async (label: string) => {
    expect((await now()).stick, label).toEqual({ surge: 0, sway: 0, heave: 0, yaw: 0 });
    const a = await after(2);
    const b = await after(6);
    expect(Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]), label).toBeLessThan(0.15);
  };
  await page.locator("canvas").click({ position: { x: 600, y: 200 } });

  await page.keyboard.down("w");
  expect((await after(1)).speed).toBeGreaterThan(0.6);
  await page.keyboard.up("w");
  await stopped("key up");

  // Option changes the letter the key comes up with; Cmd swallows the key up altogether
  const key = (type: string, init: { key: string; code: string; altKey?: boolean; metaKey?: boolean }) => page.evaluate((a) => window.dispatchEvent(new KeyboardEvent(a.type, a.init)), { type, init });
  await key("keydown", { key: "w", code: "KeyW" });
  await after(0.5);
  await key("keyup", { key: "∑", code: "KeyW", altKey: true });
  await stopped("Option");
  await key("keydown", { key: "e", code: "KeyE" });
  await after(0.5);
  await key("keydown", { key: "Meta", code: "MetaLeft", metaKey: true });
  await stopped("Cmd");

  // the card closing under a pressed pad
  await field.workspace("03").click();
  const pad = page.getByRole("button", { name: "Surge forward" });
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  expect((await after(0.5)).stick.surge).toBe(1);
  await page.evaluate(() => window.__fieldStore!.getState().setWorkspace("environment"));
  await expect(pad).toHaveCount(0);
  await stopped("card closed");
  await page.mouse.up();
});

test("in every environment the wreck is named as soon as the camera can see it, in a box that fits the drawn hull", async ({ page, field }) => {
  test.setTimeout(400_000);
  await field.open("harbor", "rov");
  const off: Record<string, number> = { harbor: 1.8, river: 1.1, deepsea: 3.5, reef: 4, lake: 2.6, ocean: 5 };
  for (const env of Object.keys(off)) {
    await page.evaluate((id) => window.__fieldStore!.getState().selectEnvironment(id as never), env);
    await field.waitFor((s, id) => s.envId === id && !!s.engine.vehicle, env);
    await page.waitForTimeout(1500);
    await page.evaluate((d0) => {
      const s = window.__fieldStore!.getState();
      const e = s.engine;
      s.setConditions({ current: { speedMps: 0 } });
      const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
      const a = (w.yawDeg * Math.PI) / 180 + 0.25;
      const d = w.halfExtents[2] + d0;
      const x = w.position[0] + Math.sin(a) * d;
      const z = w.position[2] + Math.cos(a) * d;
      e.vehicle!.position = [x, Math.max(e.floor(x, z) + e.conditions.altitudeM + 0.15, w.position[1] + 0.3), z];
      const yaw = Math.atan2(-(w.position[2] - z), w.position[0] - x);
      e.vehicle!.attitude = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      e.vehicle!.velocity = [0, 0, 0];
      s.setPilotMode("MANUAL");
    }, off[env]);
    await field.waitFor((s) => s.detections.some((d) => d.class === "SHIPWRECK"), null, 60_000);
    await expect(page.getByTestId("detection-strip"), env).toContainText("SHIPWRECK");
    const t = await field.state((s) => s.engine.time);
    await field.waitFor((s, until) => s.engine.time > until, t + 3, 60_000);
    await page.evaluate(() => window.__fieldStore!.getState().setPaused(true));
    const r = await page.evaluate(() => {
      const s = window.__fieldStore!.getState();
      const w = s.engine.targets.find((q) => q.class === "SHIPWRECK")!;
      const p = (window as unknown as { __fieldProbe: (id: string) => { width: number; height: number; rendered: number[] | null } }).__fieldProbe(w.id);
      const d = s.detections.find((q) => q.targetId === w.id);
      return { p, bbox: d?.bbox ?? null, cls: d?.class };
    });
    expect(r.cls, env).toBe("SHIPWRECK");
    const a = [r.bbox![0] * r.p.width, r.bbox![1] * r.p.height, r.bbox![2] * r.p.width, r.bbox![3] * r.p.height];
    const b = r.p.rendered!;
    const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    const iou = (ix * iy) / (a[2] * a[3] + b[2] * b[3] - ix * iy);
    expect(iou, `${env}: box ${a.map(Math.round)} on hull ${b.map(Math.round)}`).toBeGreaterThan(0.75);
    await page.evaluate(() => window.__fieldStore!.getState().setPaused(false));
  }
  // too far off in murk: the page says why instead of showing nothing
  await page.evaluate(() => {
    const s = window.__fieldStore!.getState();
    s.selectEnvironment("harbor");
  });
  await field.waitFor((s) => s.envId === "harbor" && !!s.engine.vehicle, null);
  await page.evaluate(() => {
    const s = window.__fieldStore!.getState();
    const e = s.engine;
    s.setConditions({ current: { speedMps: 0 } });
    const w = e.targets.find((t) => t.class === "SHIPWRECK")!;
    const a = (w.yawDeg * Math.PI) / 180;
    const d = w.halfExtents[2] + 3.4;
    const x = w.position[0] + Math.sin(a) * d;
    const z = w.position[2] + Math.cos(a) * d;
    e.vehicle!.position = [x, e.floor(x, z) + 1, z];
    const yaw = Math.atan2(-(w.position[2] - z), w.position[0] - x);
    e.vehicle!.attitude = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    s.setPilotMode("MANUAL");
  });
  await expect(page.getByTestId("out-of-range")).toContainText("in this water");
});
