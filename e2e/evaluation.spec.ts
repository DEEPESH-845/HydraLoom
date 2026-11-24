import fs from "node:fs";
import path from "node:path";
import { expect, expectNoHorizontalOverflow, fx, json, MOCK_RUN, mockBackend, REAL_RUN, respond, test } from "./evaluation";
import type { ModelRecord, RunRecord } from "@/lib/api/types";

/**
 * Workspace 04 Model Lab and Workspaces 05 / 06 Analysis and Reports.
 * The API is mocked with responses captured from the real backend; the `@backend` test at the end
 * drives the live service when GANTRYLAB_E2E_BACKEND=1.
 */

const SHOTS = "e2e/.results/evaluation";
const ready = fx<ModelRecord>("model.json");
const NEW_SHA = "ab".repeat(32);
const pending: ModelRecord = { ...ready, id: NEW_SHA, sha256: NEW_SHA, name: "best", version: 1, status: "pending", inspection: null, inspected_at: null, original_filename: "best.pt", versions: [] };

test.describe("Model Lab", () => {
  test("renders backend status, registry, dataset, mapping and runs", async ({ page, audit }) => {
    void audit;
    await mockBackend(page);
    await page.goto("/models");
    const banner = page.getByTestId("health-banner");
    await expect(banner).toContainText("Backend online");
    await expect(banner.locator('[data-flag="deterministic"]')).toHaveAttribute("data-on", "true");
    await expect(banner.locator('[data-flag="anthropic"]')).toHaveAttribute("data-on", "false");
    await expect(page.getByTestId("model-list")).toContainText("yolov8n");
    await expect(page.getByTestId("model-sha")).toHaveText(ready.sha256);
    await expect(page.getByTestId("model-classes")).toContainText("person");
    await expect(page.getByTestId("dataset-list")).toContainText("harbor reef sweep");
    await expect(page.getByTestId("frame-strip").locator("figure")).toHaveCount(8);
    await expect(page.getByTestId("runs-table").locator("tbody tr")).toHaveCount(2);
    await expect(page.getByTestId("runs-table")).toContainText("0.481");
    await expect(page.getByTestId("profile-info")).toContainText("auto");
    await page.getByLabel("Compute profile").selectOption("rpi4");
    await expect(page.getByTestId("profile-info")).toContainText("ESTIMATE ONLY");
    await expect(page.getByTestId("profile-info").locator('[data-kind="estimated"]')).toBeVisible();
  });

  test("upload shows progress, then inspection pending -> ready", async ({ page, audit }) => {
    void audit;
    let polls = 0;
    let uploaded = false;
    await mockBackend(page, [
      async (route, url, method) => {
        const p = url.pathname.replace("/api/v1", "");
        if (p === "/models" && method === "POST") {
          await new Promise((r) => setTimeout(r, 700));
          uploaded = true;
          await json(route, pending, 201);
          return true;
        }
        if (p === `/models/${NEW_SHA}`) {
          polls++;
          await json(route, polls < 2 ? pending : { ...ready, id: NEW_SHA, sha256: NEW_SHA, name: "best", status: "ready" });
          return true;
        }
        if (p === "/models" && method === "GET" && uploaded) {
          await json(route, { models: [polls < 2 ? pending : { ...ready, id: NEW_SHA, sha256: NEW_SHA, name: "best" }, ready] });
          return true;
        }
      },
    ]);
    await page.goto("/models");
    await expect(page.getByTestId("model-list")).toContainText("yolov8n");
    await page.getByTestId("model-file-input").setInputFiles({ name: "best.pt", mimeType: "application/octet-stream", buffer: Buffer.alloc(256 * 1024, 7) });
    await expect(page.getByTestId("upload-progress")).toBeVisible();
    await expect(page.getByTestId("upload-progress").getByRole("progressbar")).toBeVisible();
    const result = page.getByTestId("upload-result");
    await expect(result.locator('[data-status="pending"]')).toBeVisible();
    await expect(result.locator('[data-status="ready"]')).toBeVisible({ timeout: 10_000 });
    await expect(result).toContainText(NEW_SHA.slice(0, 24));
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  test("rejected upload shows the sandbox reason; bad extensions never leave the browser", async ({ page, audit }) => {
    void audit;
    const reason = "rejected by sandbox inspection: DisallowedGlobal: Disallowed pickle global os.system: not in allowlist";
    const seen = await mockBackend(page, [
      async (route, url, method) => {
        const p = url.pathname.replace("/api/v1", "");
        if (p === "/models" && method === "POST") return respond(route, pending, 201);
        if (p === `/models/${NEW_SHA}`) return respond(route, { ...pending, status: "rejected", status_reason: reason });
      },
    ]);
    await page.goto("/models");
    await page.getByTestId("model-file-input").setInputFiles({ name: "weights.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await expect(page.getByTestId("upload-invalid")).toContainText("not a .pt or .onnx");
    expect(seen.some((r) => r.method === "POST")).toBe(false);

    await page.getByTestId("model-file-input").setInputFiles({ name: "evil.pt", mimeType: "application/octet-stream", buffer: Buffer.alloc(2048, 1) });
    await expect(page.getByTestId("rejection-reason")).toHaveText(reason);
    await expect(page.getByTestId("upload-result").locator('[data-status="rejected"]')).toBeVisible();
  });

  test("class mapping suggests matches, edits flow into the run request, progress falls back to polling", async ({ page, audit }) => {
    void audit;
    const NEW_RUN = "run_0000000000aa";
    const base = fx<RunRecord>("run-real.json");
    let polls = 0;
    const seen = await mockBackend(page, [
      async (route, url, method) => {
        const p = url.pathname.replace("/api/v1", "");
        if (p === "/runs" && method === "POST") {
          await json(route, { id: NEW_RUN, status: "queued", events_url: `/api/v1/runs/${NEW_RUN}/events`, status_url: `/api/v1/runs/${NEW_RUN}` }, 202);
          return true;
        }
        if (p === `/runs/${NEW_RUN}`) {
          polls++;
          const stage =
            polls === 1
              ? { status: "running", progress: 0.3, message: "inference 7/24 frames" }
              : polls === 2
                ? { status: "running", progress: 0.9, message: "computing metrics" }
                : { status: "complete", progress: 1, message: "complete" };
          await json(route, { ...base, id: NEW_RUN, ...stage });
          return true;
        }
      },
    ]);
    await page.goto("/models");
    const map = page.getByTestId("classmap");
    await expect(map).toContainText("1 of 80 model classes mapped");
    const person = map.locator('[data-model-class="person"]');
    await expect(person.locator("select")).toHaveValue("PERSON");
    await expect(person).toContainText("AUTO");
    await expect(page.getByTestId("classmap-uncovered")).toContainText("SHIPWRECK, MINE, DEBRIS");

    await map.getByLabel("Filter model classes").fill("boat");
    await map.locator('[data-model-class="boat"] select').selectOption("SHIPWRECK");
    await map.getByLabel("Filter model classes").fill("");
    await expect(map).toContainText("2 of 80 model classes mapped");
    await expect(page.getByTestId("classmap-uncovered")).toContainText("MINE, DEBRIS");

    await page.getByTestId("start-run").click();
    const progress = page.getByTestId("run-progress");
    await expect(progress).toContainText("via status polling");
    await expect(progress.getByTestId("run-message")).toHaveText(/inference 7\/24 frames|computing metrics|complete/);
    await expect(page.getByTestId("run-result-link")).toHaveAttribute("href", `/reports/${NEW_RUN}`, { timeout: 15_000 });
    await expect(progress.locator('[data-status="complete"]')).toBeVisible();

    const post = seen.find((r) => r.method === "POST" && r.path === "/runs");
    const body = JSON.parse(post!.body!);
    expect(body.adapter).toBe("auto");
    expect(body.config.class_map.person).toBe("PERSON");
    expect(body.config.class_map.boat).toBe("SHIPWRECK");
    expect(body.config.class_map.car).toBeNull();
    expect(body.config.imgsz).toBe(640);
  });

  test("mock adapter is labelled and sends no class map", async ({ page, audit }) => {
    // the 409 below is deliberate, so Chrome logs the failed resource
    audit.allow.push(/status of 409/);
    const seen = await mockBackend(page, [
      async (route, url, method) => {
        if (url.pathname.endsWith("/runs") && method === "POST") return respond(route, { detail: "stop here" }, 409);
      },
    ]);
    await page.goto("/models");
    await page.getByText("Mock", { exact: true }).click();
    await expect(page.getByTestId("classmap-disabled")).toBeVisible();
    await expect(page.getByTestId("run-launcher")).toContainText("MOCK - not a real model evaluation");
    await page.getByTestId("start-run").click();
    await expect(page.getByTestId("run-launcher").getByRole("alert")).toContainText("stop here");
    const body = JSON.parse(seen.find((r) => r.method === "POST" && r.path === "/runs")!.body!);
    expect(body.adapter).toBe("mock");
    expect(body.config.class_map).toEqual({});
  });

  test("compare two runs side by side", async ({ page, audit }) => {
    void audit;
    await mockBackend(page);
    await page.goto("/models");
    await page.getByLabel(`Select ${MOCK_RUN} for comparison`).check();
    await page.getByLabel(`Select ${REAL_RUN} for comparison`).check();
    await page.getByTestId("compare-button").click();
    const cmp = page.getByTestId("compare-view");
    await expect(cmp).toContainText("Repeat (same model, same dataset)");
    await expect(cmp).toContainText("MOCK ADAPTER - not a real model evaluation");
    await expect(cmp).toContainText("-0.481");
  });

  test("backend unreachable shows the exact start command", async ({ page, audit }) => {
    audit.allow.push(/ERR_CONNECTION_REFUSED/, /Failed to load resource/);
    await page.route(/\/api\/v1\//, (route) => route.abort("connectionrefused"));
    await page.goto("/models");
    const down = page.getByTestId("backend-down");
    await expect(down).toBeVisible();
    await expect(down.locator("pre")).toHaveText("cd backend\n.venv/Scripts/python -m uvicorn gantrylab.app:app --port 8000");
    await page.goto(`/reports/${MOCK_RUN}`);
    await expect(page.getByTestId("backend-down")).toBeVisible();
  });
});

test.describe("Analysis and reports", () => {
  test("mock run report renders every section with the MOCK banner", async ({ page, audit }) => {
    void audit;
    await mockBackend(page);
    await page.goto(`/reports/${MOCK_RUN}`);
    await expect(page.getByTestId("mock-banner").first()).toHaveText("MOCK ADAPTER - not a real model evaluation");
    await expect(page.getByTestId("tile-precision")).toContainText("0.769");
    await expect(page.getByTestId("tile-map50")).toContainText("0.481");
    await expect(page.getByTestId("tile-precision").locator('[data-kind="simulated"]')).toBeVisible();
    await expect(page.getByTestId("tile-latency")).toContainText("n/a");
    await expect(page.getByTestId("tile-latency").locator('[data-kind="not_measured"]')).toBeVisible();
    await expect(page.getByTestId("pr-chart").locator("svg path")).toHaveCount(4);
    await expect(page.getByTestId("conf-sweep")).toContainText("best F1 0.606 at conf 0.32");
    await expect(page.getByTestId("confusion-matrix").locator("tbody tr")).toHaveCount(5);
    await expect(page.getByTestId("per-class-table").locator("tbody tr")).toHaveCount(4);
    const sens = page.getByTestId("slice-sensitivity");
    await expect(sens.locator('[data-slice-key="current_dir_deg"]')).toContainText("BEST");
    await expect(sens.locator('[data-slice-key="current_dir_deg"]')).toContainText("WORST");
    await expect(page.getByTestId("failure-analysis").locator("figure")).toHaveCount(12);
    await page.getByTestId("failure-analysis").getByRole("button", { name: /False pos 9/ }).click();
    await expect(page.getByTestId("failure-analysis").locator("figure")).toHaveCount(9);
    await expect(page.getByTestId("hardware-panel").locator('[data-profile="rpi4"] [data-kind="estimated"]')).toBeVisible();
    const report = page.getByTestId("report-view");
    await expect(report.getByTestId("report-provider")).toHaveText("deterministic");
    await expect(report.getByTestId("mock-banner")).toBeVisible();
    await expect(report.getByTestId("recommendations").locator("li")).toHaveCount(6);
    await expect(page.getByTestId("report-exports").getByRole("link", { name: /Print \/ Save as PDF/ })).toHaveAttribute("href", /\/reports\/rep_66031d3b3337\/export\.html$/);
  });

  test("patch diff view and patched copy download", async ({ page, audit }) => {
    void audit;
    await mockBackend(page);
    await page.goto(`/reports/${MOCK_RUN}`);
    await page.getByRole("button", { name: "View patch: hyp.yaml" }).click();
    const diff = page.getByTestId("patch-diff");
    await expect(diff).toContainText("+hsv_v: 0.6  # gantrylab sg-02");
    await expect(diff).toContainText("-hsv_v: 0.4  # brightness");
    await expect(page.getByTestId("patch-viewer")).toContainText("the original upload is unchanged");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-patched").click()]);
    expect(dl.suggestedFilename()).toBe("hyp.gantrylab.yaml");
    const text = fs.readFileSync((await dl.path())!, "utf-8");
    expect(text).toContain("hsv_v: 0.6");
  });

  test("follow-up assistant answers with evidence and uncertainty", async ({ page, audit }) => {
    void audit;
    const seen = await mockBackend(page);
    await page.goto(`/reports/${MOCK_RUN}`);
    await page.getByRole("button", { name: "Which training configuration should I test next?" }).click();
    const answer = page.getByTestId("ask-answer");
    await expect(answer).toContainText("Which training configuration should I test next?");
    await expect(answer).toContainText("Uncertainty");
    await expect(answer.getByLabel("Evidence references")).toBeVisible();
    const post = seen.find((r) => r.method === "POST" && r.path.endsWith("/ask"));
    expect(JSON.parse(post!.body!)).toEqual({ question: "Which training configuration should I test next?" });
  });

  test("generate a report with provider, consent toggle and YAML originals", async ({ page, audit }) => {
    void audit;
    const seen = await mockBackend(page, [
      async (route, url, method) => {
        const p = url.pathname.replace("/api/v1", "");
        if (p === "/reports" && url.searchParams.get("run_id") === REAL_RUN) return respond(route, { reports: [] });
        if (p === `/runs/${REAL_RUN}/report` && method === "POST") return respond(route, fx("report-real.json"), 201);
      },
    ]);
    await page.goto(`/reports/${REAL_RUN}`);
    const gen = page.getByTestId("report-generator");
    await expect(gen.getByLabel(/Anthropic/)).toBeDisabled();
    await gen.getByLabel(/Deterministic/).check();
    await gen.getByTestId("include-failures").uncheck();
    await gen.getByRole("button", { name: "hyp.yaml" }).click();
    await gen.getByLabel("hyp.yaml contents").fill("lr0: 0.01\nhsv_v: 0.4\n");
    await gen.getByTestId("generate-report").click();
    await expect(page.getByTestId("report-view")).toBeVisible();
    await expect(page.getByTestId("report-view").getByTestId("mock-banner")).toHaveCount(0);
    const body = JSON.parse(seen.find((r) => r.method === "POST" && r.path.endsWith("/report"))!.body!);
    expect(body).toEqual({ provider: "deterministic", include_failure_examples: false, user_files: { "hyp.yaml": "lr0: 0.01\nhsv_v: 0.4\n" } });
  });

  test("reports index lists runs and reports and compares environments", async ({ page, audit }) => {
    void audit;
    await mockBackend(page);
    await page.goto("/reports");
    await expect(page.getByTestId("runs-table").locator("tbody tr")).toHaveCount(2);
    await expect(page.getByTestId("reports-table").locator("tbody tr")).toHaveCount(2);
    await page.getByTestId("env-compare").click();
    await expect(page.getByTestId("compare-view")).toContainText("delta = B - A");
  });
});

test.describe("Responsive", () => {
  for (const vp of [
    { name: "390x844", width: 390, height: 844 },
    { name: "1440x900", width: 1440, height: 900 },
  ]) {
    test(`no horizontal overflow at ${vp.name}`, async ({ page, audit }) => {
      void audit;
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockBackend(page);
      for (const url of ["/models", "/reports", `/reports/${MOCK_RUN}`]) {
        await page.goto(url);
        await expect(page.locator("main").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await expectNoHorizontalOverflow(page);
      }
      await expect(page.getByRole("navigation", { name: "Workspaces" })).toBeVisible();
    });
  }
});

/**
 * Live backend, end to end through the UI: upload backend/yolov8n.pt, run the mock adapter, open the
 * report page, generate a deterministic report and ask a question. Opt in with GANTRYLAB_E2E_BACKEND=1.
 */
test("live backend: upload, mock run, report @backend", async ({ page, audit, request }) => {
  test.skip(process.env.GANTRYLAB_E2E_BACKEND !== "1", "set GANTRYLAB_E2E_BACKEND=1 with the backend on :8000");
  test.setTimeout(300_000);
  void audit;
  const API = (process.env.NEXT_PUBLIC_GANTRYLAB_API ?? "http://localhost:8000") + "/api/v1";
  // datasets are captured from the 3D twin; seed one small dataset through the API if the registry is empty
  const ds = await (await request.get(`${API}/datasets`)).json();
  if (!ds.datasets.length) {
    const manifest = fx<{ frames: { file: string }[] }>("manifest.json");
    const one = { ...manifest, frames: manifest.frames.slice(0, 1) };
    const r = await request.post(`${API}/datasets`, {
      multipart: {
        manifest: JSON.stringify(one),
        files: { name: one.frames[0].file, mimeType: "image/png", buffer: fs.readFileSync(path.join(__dirname, "fixtures/evaluation/frame-000000.png")) },
      },
    });
    expect(r.status()).toBe(201);
  }

  await page.goto("/models");
  await expect(page.getByTestId("health-banner")).toContainText("Backend online");
  await page.getByTestId("model-file-input").setInputFiles(path.join(__dirname, "..", "backend", "yolov8n.pt"));
  await expect(page.getByTestId("upload-result").locator('[data-status="ready"]')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("model-detail")).toContainText("DetectionModel");

  await page.getByText("Mock", { exact: true }).click();
  await page.getByTestId("start-run").click();
  const link = page.getByTestId("run-result-link");
  await expect(link).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("run-progress")).toContainText("via live events");
  await link.click();

  await expect(page.getByTestId("mock-banner").first()).toBeVisible();
  await expect(page.getByTestId("overview-tiles")).toBeVisible();
  const gen = page.getByTestId("report-generator");
  if (await gen.isVisible()) {
    await gen.getByLabel(/Deterministic/).check();
    await gen.getByTestId("generate-report").click();
  }
  await expect(page.getByTestId("report-view")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Which environmental parameter caused the largest degradation?" }).click();
  await expect(page.getByTestId("ask-answer")).toContainText("Uncertainty");
  await page.screenshot({ path: `${SHOTS}/live-report-viewport.png` });

  // real inference with the auto adapter (Ultralytics in the sandbox worker)
  await page.goto("/models");
  await expect(page.getByTestId("classmap")).toBeVisible();
  // CPU keeps the test independent of whatever else holds GPU memory on the host
  await page.getByLabel("Device").selectOption("cpu");
  await page.getByTestId("start-run").click();
  const progress = page.getByTestId("run-progress");
  await expect(progress.locator('[data-status="complete"], [data-status="failed"]')).toBeVisible({ timeout: 240_000 });
  await expect(progress.locator('[data-status="failed"]'), await progress.innerText()).toHaveCount(0);
  await page.getByTestId("run-result-link").click();
  await expect(page.getByTestId("tile-latency").locator('[data-kind="measured"]')).toBeVisible();
  await expect(page.getByTestId("mock-banner")).toHaveCount(0);
});
