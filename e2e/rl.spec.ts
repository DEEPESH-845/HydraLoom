import { expect, test } from "./lab";

test.describe("controller", () => {
  test("idle RL state mirrors the gantry (single source of truth)", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(5);
    const [rl, g] = await lab.state((s) => [s.rl, s.telemetry.gantry]);
    expect(rl.active).toBe(false);
    expect(rl.observation.x).toBeCloseTo(g.x, 3);
    expect(rl.observation.y).toBeCloseTo(g.y, 3);
    await expect(page.locator('[data-lab="card"]').getByText("50.0").first()).toBeVisible();
  });

  test("episode: start, step, reward, complete, reset", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(5);
    await page.locator("select").selectOption("mine-01");
    await lab.button(/run episode/i).click();
    await lab.waitFor((s) => s.rl.active && s.rl.episode === 1);
    await lab.fastForward(3);
    const mid = await lab.state((s) => s.rl);
    expect(mid.step).toBeGreaterThan(0);
    expect(["MOVE_X+", "MOVE_X-", "MOVE_Y+", "MOVE_Y-", "HOLD"]).toContain(mid.action);
    // RL observation is the canonical gantry position
    const g = await lab.state((s) => s.telemetry.gantry);
    expect(Math.abs(mid.nextX - g.x)).toBeLessThan(6);
    await lab.fastForward(40);
    await lab.waitFor((s) => s.rl.done);
    const done = await lab.state((s) => [s.rl, s.telemetry.gantry, s.scenario.objects.find((o) => o.id === "mine-01")!] as const);
    expect(done[0].holdCount).toBeGreaterThanOrEqual(3);
    expect(Number.isFinite(done[0].episodeReward)).toBe(true);
    expect(Math.hypot(done[1].x - done[2].x, done[1].y - done[2].y)).toBeLessThan(3);
    await expect(page.getByText(/Episode complete/)).toBeVisible();

    await lab.button(/^reset$/i).click();
    const after = await lab.state((s) => [s.rl.episode, s.rl.step, s.rl.active, s.telemetry.gantry.x, s.telemetry.gantry.y]);
    expect(after).toEqual([0, 0, false, 50, 20]);
  });

  test("reset during an episode leaves no motion and no active policy", async ({ lab }) => {
    await lab.open();
    await lab.scene(5);
    await lab.button(/run episode/i).click();
    await lab.fastForward(2);
    await lab.button(/^reset$/i).click();
    await lab.fastForward(1);
    const s = await lab.state((s) => ({ active: s.rl.active, mode: s.mode, moving: s.telemetry.gantry.moving, x: s.telemetry.gantry.x }));
    expect(s).toEqual({ active: false, mode: "IDLE", moving: false, x: 50 });
  });
});
