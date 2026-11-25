import { expect, expectNoHorizontalOverflow, fx, json, mockBackend, test } from "./evaluation";
import { DEFAULT_SWITCH, SwitchLearner, SwitchWorld, evaluatePolicies } from "@/lib/autonomy/switching";
import { SIMULATED_ROSTER } from "@/lib/bench/profile";
import type { RunList, RunMetrics, RunRecord } from "@/lib/api/types";

/** Workspaces 07 Benchmark, 08 Autonomy and 09 Hardware. */

const SHOTS = "e2e/.results/workbench";
const offline = async (page: import("@playwright/test").Page) => page.route(/\/api\/v1\//, (r) => r.abort("connectionrefused"));
const OFFLINE = [/ERR_CONNECTION_REFUSED/, /connectionrefused/i, /requestfailed: .*\/api\/v1\/health/];

test.describe("Benchmark", () => {
  test("offline it shows the simulated roster, labelled, and every view works", async ({ page, audit }) => {
    audit.allow.push(...OFFLINE);
    await offline(page);
    await page.goto("/benchmark");
    await expect(page.getByTestId("source-bar")).toContainText("SIMULATED - NOT REAL MODELS");
    await expect(page.getByTestId("scorecard")).toHaveCount(4);
    await expect(page.getByTestId("scorecard").first()).toContainText("Best at");
    await page.screenshot({ path: `${SHOTS}/benchmark.png`, fullPage: false });
    await page.getByTestId("winner-map").getByRole("button").first().click();
    await expect(page.getByTestId("drill")).toContainText("SIM General");
    await page.getByRole("button", { name: "Object class" }).click();
    await expect(page.getByTestId("matrix")).toContainText("SHIPWRECK");
    // the threshold slider recomputes the scores
    const before = await page.getByTestId("whatif-F1").innerText();
    await page.getByTestId("threshold-slider").fill("0.6");
    await expect(page.getByTestId("whatif-F1")).not.toHaveText(before);
    await expect(page.getByTestId("changes-list").locator("li").first()).toContainText("Trade-off");
    const dl = page.waitForEvent("download");
    await page.locator("#changes").getByRole("button", { name: "Export" }).click();
    expect((await dl).suggestedFilename()).toBe("gantrylab-changes.json");
    await page.locator("#matrix").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/benchmark-matrix.png` });
    await page.locator("#changes").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/benchmark-changes.png` });
    await expectNoHorizontalOverflow(page);
  });

  test("measured runs replace the roster, mock runs never do, and several models launch together", async ({ page, audit }) => {
    void audit;
    const real = fx<RunRecord>("run-real.json");
    const metrics = fx<RunMetrics>("metrics-real.json");
    const cells = ["clear", "light", "moderate", "heavy"].flatMap((turbidity) => ["dark", "dim", "bright"].map((lighting) => ({ turbidity, lighting, n_frames: 5, n_gt: 20, tp: 10, fp: 3, fn: 10 })));
    const second: RunRecord = { ...real, id: "run_second", model: { ...real.model, name: "second", sha256: "cd".repeat(32) } };
    const seen = await mockBackend(page, [
      async (route, url, method) => {
        const p = url.pathname.replace("/api/v1", "");
        if (p === "/runs" && method === "POST") {
          await json(route, { id: "run_new", status: "queued", events_url: "", status_url: "" }, 202);
          return true;
        }
        if (p === "/runs") {
          const all = fx<RunList>("runs.json").runs;
          await json(route, { runs: [...all, second] });
          return true;
        }
        if (p === "/runs/run_second/metrics" || p === `/runs/${real.id}/metrics`) {
          await json(route, { ...metrics, mock: false, condition_cells: p.includes("second") ? cells.map((c) => ({ ...c, tp: 15, fn: 5 })) : cells });
          return true;
        }
      },
    ]);
    await page.goto("/benchmark");
    await expect(page.getByTestId("source-bar")).toContainText("MEASURED ON THE BACKEND");
    await expect(page.getByTestId("scorecard")).toHaveCount(2);
    await expect(page.getByTestId("winner-map")).toContainText("second");
    const box = page.locator("#evaluate").getByRole("checkbox").first();
    await box.check();
    await page.getByTestId("batch-run").click();
    await expect.poll(() => seen.filter((r) => r.method === "POST" && r.path === "/runs").length).toBe(1);
  });
});

test.describe("Autonomy", () => {
  test("learned switching beats each fixed model on screen, the mission plays and the policy exports", async ({ page, audit }) => {
    audit.allow.push(...OFFLINE);
    await offline(page);
    await page.goto("/autonomy");
    // training is deterministic: the browser must reach exactly the value Node does
    const world = new SwitchWorld(SIMULATED_ROSTER, DEFAULT_SWITCH);
    const learner = new SwitchLearner(world);
    learner.step(Infinity);
    const expected = evaluatePolicies(world, learner)[0].reward.toFixed(3);
    for (let i = 0; i < 4; i++) {
      await expect(page.getByTestId("autonomy-stats")).toContainText(expected);
      await page.reload();
    }
    await expect(page.getByTestId("autonomy-stats")).toBeVisible();
    const rows = await page.getByTestId("switch-eval").locator("li").allInnerTexts();
    const order = rows.map((r) => r.split("\n")[0]);
    expect(order[0]).toContain("Oracle");
    expect(order[1]).toBe("Learned switching");
    await page.screenshot({ path: `${SHOTS}/autonomy.png` });
    await page.getByTestId("mission-play").click();
    await expect(page.getByTestId("mission-timeline").locator('[aria-current="step"]')).toHaveAttribute("aria-label", /Viewpoint [4-9]/, { timeout: 15_000 });
    await page.getByTestId("mission-timeline").getByRole("button").last().click();
    await expect(page.locator("#mission")).toContainText("Leg 4 of 4");
    await page.screenshot({ path: `${SHOTS}/autonomy-mission.png` });
    const dl = page.waitForEvent("download");
    await page.getByTestId("export-policy").click();
    expect((await dl).suggestedFilename()).toBe("gantrylab-switch-policy.json");
    // raising the switch cost changes the learned behaviour
    const stat = page.getByTestId("autonomy-stats").getByText(/^\d+\.\d$/);
    const before = Number(await stat.innerText());
    await page.getByTestId("cfg-switchCost").fill("2");
    await expect.poll(async () => Number(await stat.innerText())).toBeLessThan(before);
    await page.getByTestId("score-missions").click();
    await expect(page.getByTestId("mission-scores")).toContainText("Learned switching", { timeout: 60_000 });
    await page.locator("#policy").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/autonomy-policy.png` });
    await expectNoHorizontalOverflow(page);
  });

  test("navigation reports its held-out verdict and trains live", async ({ page, audit }) => {
    audit.allow.push(...OFFLINE);
    await offline(page);
    await page.goto("/autonomy");
    await expect(page.getByTestId("nav-verdict")).toContainText("hand-written plan still beats it");
    await page.locator("#navigation").getByRole("button", { name: "River" }).click();
    await expect(page.getByTestId("nav-eval").locator("li").first()).toContainText("Learned");
    await page.getByTestId("nav-train").click();
    await expect(page.locator("#nav-training")).toContainText(/Training here: episode [1-9]\d* of/, { timeout: 30_000 });
    await page.locator("#nav-training").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/autonomy-nav.png` });
    await page.getByTestId("nav-train").click();
  });
});

test.describe("Hardware", () => {
  const bring = async (page: import("@playwright/test").Page, which: "healthy" | "worn") => {
    await page.goto("/hardware");
    await page.getByTestId(`connect-${which}`).click();
    await expect(page.getByTestId("hw-safety")).toHaveText("DISARMED");
    await page.getByTestId("arm-phrase").fill("ARM GANTRY");
    await page.getByTestId("arm").click();
    await expect(page.getByTestId("hw-safety")).toHaveText("ARMED");
    await page.getByTestId("home").click();
    await expect(page.getByTestId("hw-homed")).toHaveText("yes", { timeout: 30_000 });
  };

  test("the safety layer gates motion: phrase, homing, limits and a latched stop", async ({ page, audit }) => {
    void audit;
    await page.goto("/hardware");
    await page.getByTestId("connect-healthy").click();
    await page.screenshot({ path: `${SHOTS}/hardware-connected.png` });
    await page.getByTestId("arm-phrase").fill("please");
    await page.getByTestId("arm").click();
    await expect(page.locator("#machine")).toContainText('type "ARM GANTRY" to arm');
    await page.getByTestId("arm-phrase").fill("ARM GANTRY");
    await page.getByTestId("arm").click();
    await page.getByTestId("home").click();
    await expect(page.getByTestId("hw-homed")).toHaveText("yes", { timeout: 30_000 });
    await page.getByTestId("move-x").fill("140");
    await page.getByTestId("move").click();
    await expect(page.getByTestId("hw-error")).toContainText("outside soft limits");
    await page.getByTestId("move-x").fill("90");
    await page.getByTestId("move").click();
    await expect.poll(async () => parseFloat(await page.getByTestId("hw-x").innerText())).toBeGreaterThan(10);
    await page.getByTestId("estop").click();
    await expect(page.getByTestId("hw-safety")).toHaveText("ESTOP");
    await expect.poll(async () => page.getByTestId("hw-x").innerText()).not.toBe("n/a");
    const rest = async () => {
      const a = await page.getByTestId("hw-x").innerText();
      await page.waitForTimeout(500);
      return a === (await page.getByTestId("hw-x").innerText());
    };
    await expect.poll(rest).toBe(true);
    expect(parseFloat(await page.getByTestId("hw-x").innerText())).toBeLessThan(89);
    await page.getByTestId("reset-latch").click();
    await expect(page.getByTestId("hw-safety")).toHaveText("DISARMED");
  });

  test("a scan plan needs approval and runs against the twin", async ({ page, audit }) => {
    void audit;
    await bring(page, "healthy");
    await expect(page.getByTestId("fly-plan")).toBeDisabled();
    await page.locator("#map").getByRole("button", { name: "Serpentine" }).click();
    await page.getByTestId("approve-plan").check();
    await page.getByTestId("fly-plan").click();
    await expect(page.getByTestId("plan-timing")).toContainText("6 of 6", { timeout: 90_000 });
    await page.screenshot({ path: `${SHOTS}/hardware-map.png` });
  });

  test("a worn rig is rejected with named fixes, and the report persists and exports", async ({ page, audit }) => {
    test.setTimeout(420_000);
    void audit;
    await bring(page, "worn");
    await page.getByTestId("run-tests").click();
    await expect(page.getByTestId("save-report")).toBeVisible({ timeout: 360_000 });
    await page.getByTestId("save-report").click();
    const report = page.getByTestId("hw-report");
    await expect(report).toContainText("NOT ACCEPTED");
    await expect(report).toContainText("SIMULATED");
    for (const t of ["Recalibrate X steps per mm", "backlash", "losing steps", "twin's timing"]) await expect(page.getByTestId("hw-suggestions")).toContainText(t);
    await report.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/hardware-report.png`, fullPage: false });
    const dl = page.waitForEvent("download");
    await report.getByRole("button", { name: "CSV" }).click();
    expect((await dl).suggestedFilename()).toMatch(/^hw-\d+\.csv$/);
    await page.reload();
    await expect(page.getByTestId("hw-history").locator("tr")).toHaveCount(1);
  });

  test("a Pi log is analysed and a bad one is refused", async ({ page, audit }) => {
    void audit;
    await page.goto("/hardware");
    const rows = Array.from({ length: 60 }, (_, i) => `${i * 0.5},${400 + i * 4},${50 + i / 2},${i > 50 ? 1 : 0}`).join("\n");
    await page.getByTestId("pi-file").setInputFiles({ name: "pi-log.csv", mimeType: "text/csv", buffer: Buffer.from(`t_s,latency_ms,temp_c,throttled\n${rows}`) });
    await expect(page.getByTestId("pi-result")).toContainText("slows down as it heats");
    await page.getByTestId("pi-file").setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2") });
    await expect(page.locator("#pi")).toContainText("Expected a CSV");
  });
});

for (const [w, h] of [[390, 844], [768, 1024], [1024, 768], [1440, 900]] as const)
  test(`pages fit ${w} x ${h} with no sideways scroll`, async ({ page, audit }) => {
    audit.allow.push(...OFFLINE);
    await offline(page);
    await page.setViewportSize({ width: w, height: h });
    for (const p of ["benchmark", "autonomy", "hardware"]) {
      await page.goto(`/${p}`);
      await expect(page.getByTestId(p).getByRole("heading", { level: 1 })).toBeVisible();
      if (p !== "hardware") await expect(page.getByTestId("source-bar")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: `${SHOTS}/${p}-${w}.png` });
    }
  });
