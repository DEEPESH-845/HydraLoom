import { expect, test } from "./lab";

test.describe("scenario", () => {
  test("sliders and object fields commit clamped values; junk reverts", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(6);
    const turb = page.locator("label", { hasText: "Turbidity" }).locator("input[type=range]");
    await turb.fill("0.6");
    expect(await lab.state((s) => s.scenario.turbidity)).toBeCloseTo(0.6, 5);
    const x = page.locator("input[type=number]").first();
    await x.fill("500");
    await x.press("Enter");
    expect(await lab.state((s) => s.scenario.objects[0].x)).toBe(97);
    // letters are rejected by the number input, which leaves it blank: blank must revert, not jump to the minimum
    await x.click({ clickCount: 3 });
    await page.keyboard.type("abc");
    await x.press("Enter");
    expect(await lab.state((s) => s.scenario.objects[0].x)).toBe(97);
    await x.fill("-10");
    await x.press("Enter");
    expect(await lab.state((s) => s.scenario.objects[0].x)).toBe(3);
    await lab.button(/reset scenario/i).click();
    expect(await lab.state((s) => [s.scenario.objects[0].x, s.scenario.turbidity])).toEqual([60, 0.15]);
  });

  test("run test from scenario opens the gantry scene and a murkier run changes the result", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(6);
    await lab.button(/run test/i).click();
    await lab.waitFor((s) => s.scene === 4 && s.mode === "TEST");
    await lab.fastForward(80);
    await lab.waitFor((s) => s.phase === "COMPLETE", 90_000);
    const r1 = await lab.state((s) => s.result!);
    await lab.scene(6);
    await page.locator("label", { hasText: "Turbidity" }).locator("input[type=range]").fill("0.6");
    await lab.button(/run test/i).click();
    await lab.fastForward(80);
    await lab.waitFor((s) => s.phase === "COMPLETE", 90_000);
    const r2 = await lab.state((s) => s.result!);
    expect(r2.turbidity).toBeCloseTo(0.6, 5);
    expect(r2.successfulDetections).toBeLessThan(r1.successfulDetections);
  });
});
