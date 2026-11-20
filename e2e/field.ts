import { expect, type Page, test as base } from "@playwright/test";
import type { useFieldStore } from "@/lib/field/store";

type Store = typeof useFieldStore;
type State = ReturnType<Store["getState"]>;

declare global {
  interface Window {
    __fieldStore?: Store;
    __fieldStats?: { calls: number; triangles: number; mainCalls: number; feedCalls: number; fps: number };
  }
}

/** Upstream warnings that are understood and harmless. Anything else fails the audit. */
const KNOWN_WARNINGS = [/KHR_parallel_shader_compile extension not supported/, /THREE\.Clock: This module has been deprecated/, /GPU stall due to ReadPixels/, /GL_INVALID_OPERATION.*ReadPixels/i];

export interface ConsoleAudit {
  errors: string[];
  warnings: string[];
}

export const test = base.extend<{ audit: ConsoleAudit; field: Field }>({
  audit: async ({ page }, provide) => {
    const audit: ConsoleAudit = { errors: [], warnings: [] };
    page.on("console", (m) => {
      const text = m.text();
      if (m.type() === "error") audit.errors.push(text);
      else if (m.type() === "warning" && !KNOWN_WARNINGS.some((re) => re.test(text))) audit.warnings.push(text);
    });
    page.on("pageerror", (e) => audit.errors.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) => {
      // the dataset upload is mocked or deliberately unreachable in some tests
      if (r.url().includes("/api/v1/datasets")) return;
      audit.errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`);
    });
    await provide(audit);
    expect(audit.errors, "console/page/request errors").toEqual([]);
  },
  field: async ({ page }, provide) => {
    await provide(new Field(page));
  },
});

export { expect };

/** Store-backed helpers for the field workspace at /field. Reads go through the dev-only window.__fieldStore hook. */
export class Field {
  constructor(readonly page: Page) {}

  async open(env = "harbor", platform = "rov") {
    // a clean selection every test: the store remembers the last one in localStorage
    await this.page.addInitScript(
      ([e, p]) => {
        try {
          window.localStorage.setItem("gantrylab.field.selection.v1", JSON.stringify({ env: e, platform: p }));
        } catch {}
      },
      [env, platform],
    );
    await this.page.goto("/");
    await this.page.waitForFunction(() => !!window.__fieldStore && !!document.querySelector("canvas"), null, { timeout: 120_000 });
    await this.page.waitForFunction(() => (window.__fieldStore!.getState().telemetry.time ?? 0) > 0 && window.__fieldStore!.getState().worldReady, null, { timeout: 120_000 });
  }

  /** Read from canonical store state. `fn` is serialised, so it must not close over test variables. */
  state<T>(fn: (s: State) => T): Promise<T> {
    return this.page.evaluate(`(${fn.toString()})(window.__fieldStore.getState())`) as Promise<T>;
  }

  async waitFor<A = undefined>(pred: (s: State, arg: A) => boolean, arg?: A, timeout = 60_000) {
    await this.page.waitForFunction(
      ({ src, arg }) => new Function("s", "arg", `return (${src})(s, arg)`)(window.__fieldStore!.getState(), arg) as boolean,
      { src: pred.toString(), arg },
      { timeout, polling: 100 },
    );
  }

  /** Advances the simulation by `seconds` of simulated time in frame-sized steps, then publishes. */
  async fastForward(seconds: number) {
    await this.page.evaluate((secs) => {
      const s = window.__fieldStore!.getState();
      for (let t = 0; t < secs; t += 0.05) s.engine.tick(0.05);
      s.publish();
    }, seconds);
  }

  workspace(n: string) {
    return this.page.locator("header nav[aria-label='Workspaces'], nav[data-field='nav']").getByRole("button", { name: new RegExp(`^${n}`) }).filter({ visible: true }).first();
  }

  /** Waits until the given environment's site is the one in the scene and the veil has lifted. */
  async waitWorld(env: string) {
    await this.page.waitForFunction(
      (e) => {
        const s = window.__fieldStore!.getState();
        const scene = (window as unknown as { __fieldScene?: { getObjectByName: (n: string) => unknown } }).__fieldScene;
        return s.envId === e && s.worldReady && !!scene?.getObjectByName(`field-site-${e}`);
      },
      env,
      { timeout: 120_000, polling: 100 },
    );
  }
}
