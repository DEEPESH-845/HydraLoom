"use client";

import * as THREE from "three";
import { CAMERA, GANTRY, TANK, gantryToWorld } from "@/lib/sim/constants";
import { projectToFeed } from "@/lib/sim/detection";
import { environmentNtu, ENVIRONMENTS } from "@/lib/sim/environments";
import { mulberry32 } from "@/lib/sim/rng";
import { useSimStore } from "@/lib/sim/store";
import type { TestObject } from "@/lib/sim/types";
import type { Vec3 } from "@/lib/physics/math";
import {
  CaptureContext,
  GENERATOR,
  annotateTargets,
  encodePng,
  nextFrame,
  projectedBox,
  renderRgb,
  restoreState,
  round,
  saveState,
  type Box,
  type CaptureProgress,
  type CapturedFrame,
  type Manifest,
} from "@/components/capture/core";
import { feedBackground, feedCam, labFeedPass, labWater } from "./FeedRenderer";
import { overviewFill } from "./TankDressing";
import { waterUniforms } from "./water";

/*
 * Synthetic dataset capture for the Gantry Lab: frames from the gantry camera through the same water as the live feed
 * (labWater + labFeedPass, the functions the render loop uses), labelled from an instance-ID pass of the same camera
 * (components/capture/core.ts). The engine is never touched: the capture camera is placed at each viewpoint directly,
 * and a sweep's turbidity and lighting go straight to the water uniforms, never into the live scenario (which used to
 * make the sliders jump and the live detector see the sweep).
 */

export type LabCapturePreset = "jitter" | "raster" | "turbidity" | "lighting";

export interface LabCaptureOptions {
  preset: LabCapturePreset;
  name: string;
  seed: number;
  /** frames for the jitter preset; sweeps use 5 steps, the raster 5 x 3 */
  count: number;
}

/** Live renderer and scene of the lab canvas, set by LabCaptureBridge in Scene.tsx. */
export const labGL: { gl: THREE.WebGLRenderer | null; scene: THREE.Scene | null } = { gl: null, scene: null };

export const LAB_CAPTURE_SIZE = { width: 640, height: Math.round(640 / CAMERA.aspect) };

interface Viewpoint {
  x: number;
  y: number;
  turbidity: number;
  lighting: number;
}

/** Viewpoints of a preset. Seeded, so the same options give the same dataset. */
export function labViewpoints(o: LabCaptureOptions, from: { x: number; y: number; turbidity: number; lighting: number }): Viewpoint[] {
  const rand = mulberry32(o.seed >>> 0);
  const clampX = (v: number) => Math.min(GANTRY.travelX, Math.max(0, v));
  const clampY = (v: number) => Math.min(GANTRY.travelY, Math.max(0, v));
  const at = (x: number, y: number, t = from.turbidity, l = from.lighting) => ({ x: round(clampX(x), 2), y: round(clampY(y), 2), turbidity: t, lighting: l });
  switch (o.preset) {
    case "raster": {
      const out: Viewpoint[] = [];
      for (let j = 0; j < 3; j++) for (let i = 0; i < 5; i++) out.push(at(10 + i * 20, 6 + j * 14));
      return out;
    }
    case "turbidity":
      return [0, 0.25, 0.5, 0.75, 1].map((t) => at(from.x, from.y, t));
    case "lighting":
      return [0.2, 0.4, 0.6, 0.8, 1].map((l) => at(from.x, from.y, from.turbidity, l));
    case "jitter":
    default:
      return Array.from({ length: Math.max(1, Math.min(200, Math.round(o.count))) }, () => at(from.x + (rand() - 0.5) * 16, from.y + (rand() - 0.5) * 10));
  }
}

/** World corners of an object's declared box, as the detector projects it (lib/sim/detection.ts). */
function declaredCorners(o: TestObject): Vec3[] {
  const [ox, oz] = gantryToWorld(o.x, o.y);
  const [hx, hy, hz] = o.halfExtents;
  const r = (o.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const out: Vec3[] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      for (const sy of [-1, 1]) {
        const lx = sx * hx;
        const lz = sz * hz;
        out.push([ox + lx * c + lz * s, Math.max(0, o.z - o.burial * hy + sy * hy), oz - lx * s + lz * c]);
      }
  return out;
}

/** Captures and labels frames. Spreads one frame per animation frame; honours the abort signal between frames. */
export async function runLabCapture(o: LabCaptureOptions, onProgress: (p: CaptureProgress) => void, signal?: AbortSignal): Promise<{ manifest: Manifest; frames: CapturedFrame[] }> {
  const { gl, scene } = labGL;
  if (!gl || !scene) throw new Error("The lab scene is not ready.");
  const store = useSimStore.getState();
  const engine = store.engine;
  const sc = engine.scenario;
  const original = { turbidity: sc.turbidity, lighting: sc.lighting };
  const environment = sc.environment;
  const pose = { x: engine.gantry.x.pos, y: engine.gantry.y.pos };
  const views = labViewpoints(o, { ...pose, ...original });
  const { width: W, height: H } = LAB_CAPTURE_SIZE;
  const ctx = new CaptureContext(W, H, { near: feedCam.near, far: feedCam.far, layer: 0 });
  const frames: CapturedFrame[] = [];
  const tanH = Math.tan((CAMERA.hfovDeg * Math.PI) / 360);
  const fx = W / 2 / tanH;
  const fy = H / 2 / (tanH / CAMERA.aspect);
  try {
    for (let i = 0; i < views.length; i++) {
      if (signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
      await nextFrame();
      const v = views[i];
      const conditions = { turbidity: v.turbidity, lighting: v.lighting };
      const saved = saveState(gl, scene, [overviewFill]);
      try {
        const [wx, wz] = gantryToWorld(v.x, v.y);
        // the same camera as the live feed, at this viewpoint
        ctx.cam.copy(feedCam);
        ctx.cam.layers.set(0);
        ctx.cam.position.set(wx, CAMERA.lensHeight, wz);
        ctx.cam.up.set(0, 0, -1);
        ctx.cam.lookAt(wx, 0, wz);
        ctx.cam.updateMatrixWorld();
        labWater(wx, wz, conditions);
        labFeedPass(conditions);
        waterUniforms.uWaterViewportH.value = H;
        scene.background = feedBackground;
        const pixels = renderRgb(gl, scene, ctx);
        const objects = engine.scenario.objects;
        const project = (p: Vec3) => {
          const q = projectToFeed(wx, wz, p[0], p[1], p[2]);
          return Number.isFinite(q.u) ? { u: q.u, v: q.v } : null;
        };
        const { annotations, boxes } = annotateTargets(
          gl,
          scene,
          ctx,
          objects.map((ob) => {
            const [ox, oz] = gantryToWorld(ob.x, ob.y);
            return { id: ob.id, className: ob.type, position: [ox, ob.z, oz] as Vec3 };
          }),
          [wx, CAMERA.lensHeight, wz],
          (id): Box | null => {
            const ob = objects.find((x) => x.id === id);
            return ob ? projectedBox(declaredCorners(ob), project, W, H) : null;
          },
        );
        const env = ENVIRONMENTS[environment];
        const file = `${String(i + 1).padStart(6, "0")}.png`;
        const q = ctx.cam.quaternion;
        const frame = {
          file,
          width: W,
          height: H,
          camera: { fx: round(fx, 3), fy: round(fy, 3), cx: W / 2, cy: H / 2, position: [round(wx, 4), CAMERA.lensHeight, round(wz, 4)] as Vec3, quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number], hfov_deg: CAMERA.hfovDeg },
          conditions: {
            environment: `lab-${env.id}`,
            platform: "gantry",
            turbidity: v.turbidity,
            ntu: round(environmentNtu(env, v.turbidity), 3),
            lighting: v.lighting,
            lamps: env.light === "lamp" ? v.lighting : 0,
            current_speed_mps: 0,
            current_dir_deg: 0,
            depth_m: round(TANK.waterLevel - CAMERA.lensHeight, 3),
            altitude_m: CAMERA.lensHeight,
            vehicle_speed_mps: 0,
            motion_blur_px: 0,
            gantry_x_cm: v.x,
            gantry_y_cm: v.y,
            seed: o.seed,
          },
          annotations,
        };
        frames.push({ frame, png: await encodePng(pixels, W, H), analytic: boxes });
      } finally {
        restoreState(gl, scene, saved);
      }
      onProgress({ done: i + 1, total: views.length });
    }
  } finally {
    ctx.dispose();
  }
  const manifest: Manifest = {
    schema: "gantrylab.dataset/1",
    name: o.name,
    seed: o.seed,
    generator: GENERATOR,
    classes: ["SHIPWRECK", "MINE", "DEBRIS"],
    frames: frames.map((f) => f.frame),
  };
  return { manifest, frames };
}
