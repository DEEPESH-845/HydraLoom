import { expect, type Page, type Route, test as base } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Fixtures for the Model Lab and Reports specs. Every API response is a real response captured from
 * the GANTRYLAB backend (e2e/fixtures/evaluation/*.json), so the UI is tested against the true contract
 * without needing the Python service in CI.
 */

const DIR = path.join(__dirname, "fixtures", "evaluation");
export const fx = <T = unknown>(name: string): T => JSON.parse(fs.readFileSync(path.join(DIR, name), "utf-8")) as T;
export const FRAME_PNG = fs.readFileSync(path.join(DIR, "frame-000000.png"));

export const MOCK_RUN = "run_9b59d5a31f3d";
export const REAL_RUN = "run_4e0b830d3c7e";
export const MOCK_REPORT = "rep_66031d3b3337";
export const REAL_REPORT = "rep_f028d8243e8d";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};

export type Handler = (route: Route, url: URL, method: string) => Promise<boolean | void> | boolean | void;

export async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers: CORS, body: JSON.stringify(body) });
}

/** Fulfil from an extra handler and mark the request handled. */
export async function respond(route: Route, body: unknown, status = 200) {
  await json(route, body, status);
  return true;
}

/**
 * Serve the captured backend. `extra` handlers run first; return true from one to mark the request handled.
 * Returns the list of API requests seen, for assertions on request bodies.
 */
export async function mockBackend(page: Page, extra: Handler[] = []) {
  const seen: { method: string; path: string; body: string | null }[] = [];
  await page.routeWebSocket(/\/api\/v1\/runs\/[^/]+\/events/, (ws) => {
    // No event stream in CI: close at once so the client falls back to polling GET /runs/{id}.
    ws.close({ code: 1011, reason: "no events in tests" });
  });
  await page.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const p = url.pathname.replace(/^\/api\/v1/, "");
    seen.push({ method, path: p + url.search, body: req.postData() });
    for (const h of extra) if (await h(route, url, method)) return;

    if (p === "/health") return json(route, fx("health.json"));
    if (p === "/compute-profiles") return json(route, fx("compute-profiles.json"));
    if (p === "/models" && method === "GET") return json(route, fx("models.json"));
    if (p.startsWith("/models/")) return json(route, fx("model.json"));
    if (p === "/datasets") return json(route, fx("datasets.json"));
    if (/^\/datasets\/[^/]+$/.test(p)) return json(route, fx("dataset.json"));
    if (/^\/datasets\/[^/]+\/manifest$/.test(p)) return json(route, fx("manifest.json"));
    if (/^\/datasets\/[^/]+\/frames\//.test(p)) return route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: FRAME_PNG });
    if (p === "/runs" && method === "GET") return json(route, fx("runs.json"));
    if (p === `/runs/${MOCK_RUN}`) return json(route, fx("run-mock.json"));
    if (p === `/runs/${REAL_RUN}`) return json(route, fx("run-real.json"));
    if (p === `/runs/${MOCK_RUN}/metrics`) return json(route, fx("metrics-mock.json"));
    if (p === `/runs/${REAL_RUN}/metrics`) return json(route, fx("metrics-real.json"));
    if (/^\/runs\/[^/]+\/predictions$/.test(p)) return json(route, { run_id: p.split("/")[2], mock: true, inference_conf_floor: 0.001, frames: [] });
    if (p === "/reports") {
      const all = fx<{ reports: { run_id: string }[] }>("reports.json");
      const runId = url.searchParams.get("run_id");
      return json(route, runId ? { reports: all.reports.filter((r) => r.run_id === runId) } : all);
    }
    if (p === `/reports/${MOCK_REPORT}`) return json(route, fx("report-mock.json"));
    if (p === `/reports/${REAL_REPORT}`) return json(route, fx("report-real.json"));
    if (/^\/reports\/[^/]+\/patches\/hyp\.yaml$/.test(p)) return json(route, fx("patch-hyp.json"));
    if (/^\/reports\/[^/]+\/ask$/.test(p)) {
      const q = JSON.parse(req.postData() ?? "{}").question as string;
      return json(route, { ...fx<object>("ask.json"), question: q });
    }
    if (p === "/compare") return json(route, fx("compare.json"));
    return json(route, { detail: `no fixture for ${method} ${p}` }, 404);
  });
  return seen;
}

/** Console errors, uncaught exceptions and failed requests. `allow` lists expected messages. */
export const test = base.extend<{ audit: { errors: string[]; allow: RegExp[] } }>({
  audit: async ({ page }, provide) => {
    const audit = { errors: [] as string[], allow: [] as RegExp[] };
    page.on("console", (m) => {
      if (m.type() === "error") audit.errors.push(m.text());
    });
    page.on("pageerror", (e) => audit.errors.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) => {
      const err = r.failure()?.errorText ?? "";
      // aborted image/fetch requests on navigation are not failures
      if (err.includes("ERR_ABORTED")) return;
      audit.errors.push(`requestfailed: ${r.url()} ${err}`);
    });
    await provide(audit);
    const unexpected = audit.errors.filter((e) => !audit.allow.some((re) => re.test(e)));
    expect(unexpected, "console/page/request errors").toEqual([]);
  },
});

export { expect };

/** The workspace page scrolls inside its own container; the document must never scroll sideways. */
export async function expectNoHorizontalOverflow(page: Page) {
  const o = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid=model-lab],[data-testid=reports-index],[data-testid=run-report]");
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const own = shell ? shell.scrollWidth - shell.clientWidth : 0;
    // anything wider than the viewport that is not inside a horizontal scroller
    const offenders: string[] = [];
    const vw = document.documentElement.clientWidth;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1) continue;
      let p: HTMLElement | null = el.parentElement;
      let scrolled = false;
      while (p && p !== shell) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") {
          scrolled = true;
          break;
        }
        p = p.parentElement;
      }
      if (!scrolled) offenders.push(`${el.tagName}.${String(el.className).slice(0, 60)}`);
    }
    return { doc, own, offenders: offenders.slice(0, 5) };
  });
  expect(o.doc, "document horizontal overflow").toBeLessThanOrEqual(0);
  expect(o.own, "workspace horizontal overflow").toBeLessThanOrEqual(0);
  expect(o.offenders, "elements wider than the viewport outside a scroller").toEqual([]);
}
