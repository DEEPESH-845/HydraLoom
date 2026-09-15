import { expect, test } from "./lab";

const SCENES = [
  [1, /Underwater robotics testbed/],
  [2, /^System$/],
  [3, /Object detection/],
  [4, /Gantry control/],
  [5, /^Controller$/],
  [6, /Test scenario/],
  [7, /Test result/],
] as const;

test.describe("navigation", () => {
  test("every scene opens from the rail with its card and camera preset", async ({ lab, page }) => {
    await lab.open();
    for (const [n, title] of SCENES) {
      await lab.scene(n);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      const preset = await lab.state((s) => s.cameraPreset);
      expect(preset).toMatch(/^[A-E]$/);
    }
  });

  test("keyboard 1..7 and arrows navigate; typing in inputs does not", async ({ lab, page }) => {
    await lab.open();
    await page.keyboard.press("4");
    await lab.waitFor((s) => s.scene === 4);
    await page.keyboard.press("ArrowDown");
    await lab.waitFor((s) => s.scene === 5);
    await page.keyboard.press("ArrowUp");
    await lab.waitFor((s) => s.scene === 4);
    await lab.scene(6);
    const input = page.locator("input[type=number]").first();
    await input.focus();
    await page.keyboard.press("3");
    expect(await lab.state((s) => s.scene)).toBe(6);
  });

  test("rapid scene switching ends in a consistent state", async ({ lab }) => {
    await lab.open();
    for (let i = 0; i < 12; i++) await lab.rail(new RegExp(`^0${(i % 7) + 1}`)).click({ delay: 0 });
    await lab.waitFor((s) => s.scene === 5);
    const p = await lab.state((s) => s.cameraPreset);
    expect(p).toBe("B");
  });
});
