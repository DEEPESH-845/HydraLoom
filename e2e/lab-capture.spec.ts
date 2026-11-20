import { expect, test } from "./lab";

interface Ann {
  object_id: string;
  class_name: string;
  bbox_xywh: [number, number, number, number];
  occluded_fraction: number;
  visible_fraction: number;
  area_px: number;
}
interface Frame {
  file: string;
  width: number;
  height: number;
  conditions: Record<string, string | number>;
  annotations: Ann[];
}

test.describe("lab dataset capture", () => {
  test("captures labelled frames, uploads a valid manifest and leaves the lab unchanged", async ({ lab, page }) => {
    let manifest: { schema: string; classes: string[]; frames: Frame[] } | null = null;
    let fileCount = 0;
    await page.route("**/api/v1/datasets", async (route) => {
      const body = route.request().postDataBuffer()?.toString("latin1") ?? "";
      const m = body.match(/name="manifest"\r\n\r\n([\s\S]*?)\r\n--/);
      manifest = m ? JSON.parse(m[1]) : null;
      fileCount = (body.match(/name="files"; filename="/g) ?? []).length;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "ds_test" }) });
    });

    await lab.open();
    await lab.scene(3);
    await lab.settleCamera();
    const before = await lab.state((s) => ({ x: s.telemetry.gantry.x, y: s.telemetry.gantry.y, t: s.scenario.turbidity, l: s.scenario.lighting }));

    await page.getByRole("button", { name: /capture dataset/i }).click();
    await page.getByLabel("Capture preset").selectOption("raster");
    await page.getByRole("button", { name: /capture and upload/i }).click();
    await expect(page.getByTestId("lab-capture").getByRole("status")).toContainText("Dataset ds_test", { timeout: 180_000 });

    expect(manifest).not.toBeNull();
    const mf = manifest!;
    expect(mf.schema).toBe("gantrylab.dataset/1");
    expect(mf.frames).toHaveLength(15);
    expect(fileCount).toBe(15);
    let boxes = 0;
    for (const f of mf.frames) {
      expect(f.conditions.platform).toBe("gantry");
      expect(String(f.conditions.environment)).toMatch(/^lab-/);
      for (const a of f.annotations) {
        boxes++;
        expect(["SHIPWRECK", "MINE", "DEBRIS"]).toContain(a.class_name);
        const [x, y, w, h] = a.bbox_xywh;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(f.width);
        expect(y + h).toBeLessThanOrEqual(f.height);
        expect(a.occluded_fraction).toBeGreaterThanOrEqual(0);
        expect(a.occluded_fraction).toBeLessThanOrEqual(1);
        expect(a.area_px).toBeGreaterThanOrEqual(12);
      }
    }
    // a raster over the whole travel images every object at least once
    const seen = new Set(mf.frames.flatMap((f) => f.annotations.map((a) => a.object_id)));
    expect(seen.size).toBe(6);
    expect(boxes).toBeGreaterThan(15);

    const after = await lab.state((s) => ({ x: s.telemetry.gantry.x, y: s.telemetry.gantry.y, t: s.scenario.turbidity, l: s.scenario.lighting }));
    expect(after).toEqual(before);
  });

  test("the instance-ID box of the crate agrees with the analytic projection of its declared box", async ({ lab, page }) => {
    await lab.open();
    await lab.settleCamera();
    // park over the crate so it is whole and central, then capture one frame directly
    await lab.state((s) => s.engine.moveTo(93, 35));
    await lab.fastForward(8);
    const res = await page.evaluate(async () => {
      const mod = (window as unknown as { __labCapture?: () => Promise<unknown> }).__labCapture;
      return mod ? await mod() : null;
    });
    expect(res, "dev hook __labCapture missing").not.toBeNull();
    const { annotation, analytic } = res as { annotation: Ann; analytic: [number, number, number, number] };
    const [ax, ay, aw, ah] = analytic;
    const [bx, by, bw, bh] = annotation.bbox_xywh;
    // the rendered crate fits inside its declared extents, within a few pixels of each edge
    expect(Math.abs(bx - ax)).toBeLessThan(8);
    expect(Math.abs(by - ay)).toBeLessThan(8);
    expect(Math.abs(bx + bw - (ax + aw))).toBeLessThan(8);
    expect(Math.abs(by + bh - (ay + ah))).toBeLessThan(8);
  });
});
