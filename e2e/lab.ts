import { expect, type Page, test as base } from "@playwright/test";
import type { useSimStore } from "@/lib/sim/store";

type Store = typeof useSimStore;
type State = ReturnType<Store["getState"]>;

declare global {
  interface Window {
    __labStore?: Store;
    __labStats?: { calls: number; triangles: number };
    /** dev-only: live main camera and orbit controls, plus whether a preset tween is running */
    __labCamera?: { camera: { position: { x: number; y: number; z: number } }; controls: { target: { x: number; y: number; z: number } } | null; tweening: () => boolean };
  }
}

/** Console errors, uncaught exceptions and failed requests collected for the whole test. */
export interface ConsoleAudit {
  errors: string[];
  warnings: string[];
}

/** Upstream warnings that are understood and harmless. Anything else fails the audit. */
const KNOWN_WARNINGS = [/THREE\.Clock: This module has been deprecated/, /GPU stall due to ReadPixels/];

export const test = base.extend<{ audit: ConsoleAudit; lab: Lab }>({
  audit: async ({ page }, provide) => {
    const audit: ConsoleAudit = { errors: [], warnings: [] };
    page.on("console", (m) => {
      const text = m.text();
      if (m.type() === "error") audit.errors.push(text);
      else if (m.type() === "warning" && !KNOWN_WARNINGS.some((re) => re.test(text))) audit.warnings.push(text);
    });
    page.on("pageerror", (e) => audit.errors.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) => audit.errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
    await provide(audit);
    expect(audit.errors, "console/page/request errors").toEqual([]);
  },
  lab: async ({ page }, provide) => {
    await provide(new Lab(page));
  },
});

export { expect };

/** Store-backed helpers. Reads go through the dev hook; actions go through the DOM unless noted. */
export class Lab {
  constructor(readonly page: Page) {}

  async open() {
    await this.page.goto("/");
    await this.page.waitForFunction(() => !!window.__labStore && !!document.querySelector("canvas"));
    // one published snapshot means the sim loop is alive
    await this.page.waitForFunction(() => (window.__labStore!.getState().telemetry.time ?? 0) > 0);
  }

  /** Read from canonical store state. `fn` is serialised, so it must not close over test variables. */
  state<T>(fn: (s: State) => T): Promise<T> {
    return this.page.evaluate(`(${fn.toString()})(window.__labStore.getState())`) as Promise<T>;
  }

  /** Wait until a predicate on store state holds. `pred` is serialised: pass test-scope values through `arg`. */
  async waitFor<A = undefined>(pred: (s: State, arg: A) => boolean, arg?: A, timeout = 60_000) {
    await this.page.waitForFunction(
      ({ src, arg }) => new Function("s", "arg", `return (${src})(s, arg)`)(window.__labStore!.getState(), arg) as boolean,
      { src: pred.toString(), arg },
      { timeout, polling: 100 },
    );
  }

  /**
   * Fast-forward the engine by `seconds` of simulated time. The scripted demo is
   * clocked separately, so this only accelerates engine-driven waits (tests, episodes, moves).
   */
  async fastForward(seconds: number) {
    await this.page.evaluate((secs) => {
      const s = window.__labStore!.getState();
      for (let t = 0; t < secs; t += 0.05) s.engine.tick(0.05);
      s.publish();
    }, seconds);
  }

  rail(name: string | RegExp) {
    return this.page.locator("nav[aria-label='Scenes']").getByRole("button", { name });
  }

  button(name: string | RegExp) {
    return this.page.getByRole("button", { name });
  }

  /**
   * Waits until the camera has stopped moving: no preset tween running and the pose unchanged across 600 ms.
   * Software GL renders the first seconds slowly, so a fixed sleep can capture a tween half way; screenshots wait on this.
   */
  async settleCamera(timeout = 30_000) {
    // Polled from Node: a waitForFunction predicate that returns a Promise counts as truthy at once and never waits.
    const read = () =>
      this.page.evaluate(() => {
        const c = window.__labCamera;
        if (!c) return null;
        const p = c.camera.position;
        return { moving: c.tweening(), x: p.x, y: p.y, z: p.z };
      });
    const end = Date.now() + timeout;
    let prev = await read();
    while (Date.now() < end) {
      await this.page.waitForTimeout(600);
      const cur = await read();
      if (prev && cur && !prev.moving && !cur.moving && Math.abs(prev.x - cur.x) + Math.abs(prev.y - cur.y) + Math.abs(prev.z - cur.z) < 1e-4) return;
      prev = cur;
    }
    throw new Error("camera did not settle");
  }

  async scene(n: number) {
    await this.rail(new RegExp(`^0${n}`)).click();
    await this.waitFor((s, n) => s.scene === n, n);
  }
}
