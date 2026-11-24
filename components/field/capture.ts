"use client";

import * as THREE from "three";
import { CONDITION_GRID } from "@/lib/bench/profile";
import { focalPx, project, type CameraPose } from "@/lib/field/camera";
import type { FieldEngine } from "@/lib/field/engine";
import { cross, len, qRotate, type Vec3 } from "@/lib/physics/math";
import { mulberry32 } from "@/lib/sim/rng";
import { ntuAt } from "@/lib/world/environments";
import { GT_CLASSES } from "@/lib/world/schema";
import { terrainHeight } from "@/lib/world/terrain";
import { waterUniforms } from "@/components/lab/water";
import { WORLD_LAYER } from "./common";
import { applyPass, fieldLights, lampIntensity, placeLamps, poseCamera, rayToBed } from "./feed";
import { particleSync } from "./FieldParticles";
import { passControl, targetSync } from "./runtime";

/*
 * Synthetic dataset capture: ground-truth-labelled frames from the platform camera, through the same water.
 *
 * Per frame:
 *   1. RGB pass: the platform camera into an offscreen target at the platform's aspect, at most 640 px wide, with
 *      true water (uWaterViewScale 1), no HUD or vehicle layers and no overview fill, tone mapped and sRGB encoded
 *      exactly as the live feed.
 *   2. Instance-ID pass of the same camera: every target's meshes flat in a unique id colour, every other world mesh
 *      black (terrain and structures still occlude), particles hidden, no tone mapping, linear output.
 *   3. One ID pass per visible target with only that target drawn, for the unoccluded pixel count.
 * Boxes, areas and occlusion come from those pixels; nothing is hand-drawn and nothing comes from the detector.
 * Every GL state the capture touches (render target, viewport, scissor, clear colour, background, water uniforms,
 * lights, materials, visibility) is restored after each frame, and frames are spread over animation frames.
 */

export const GENERATOR = { app: "gantrylab-web", version: "0.2.0", renderer: `three r${THREE.REVISION}` };
export const MIN_VISIBLE_PX = 12;

export type CapturePreset = "jitter" | "mission" | "turbidity" | "lighting" | "grid";

export interface CaptureOptions {
  preset: CapturePreset;
  name: string;
  seed: number;
  /** frames for jitter and mission presets */
  frames: number;
  /** mission preset: simulated seconds between frames */
  everyS: number;
}

export interface Annotation {
  object_id: string;
  class_name: string;
  bbox_xywh: [number, number, number, number];
  visible_fraction: number;
  occluded_fraction: number;
  truncated: boolean;
  distance_m: number;
  area_px: number;
}

export interface ManifestFrame {
  file: string;
  width: number;
  height: number;
  camera: { fx: number; fy: number; cx: number; cy: number; position: Vec3; quaternion: [number, number, number, number]; hfov_deg: number };
  conditions: Record<string, string | number>;
  annotations: Annotation[];
}

export interface Manifest {
  schema: "gantrylab.dataset/1";
  name: string;
  seed: number;
  generator: typeof GENERATOR;
  classes: string[];
  frames: ManifestFrame[];
}

export interface CapturedFrame {
  frame: ManifestFrame;
  png: Blob;
  /** analytic projection of each annotated target's box in pixels, for verification */
  analytic: Record<string, [number, number, number, number]>;
}

export const datasetApiBase = () => (process.env.NEXT_PUBLIC_GANTRYLAB_API ?? "http://localhost:8000").replace(/\/+$/, "");

/** Capture size: the platform's aspect, at most 640 px wide. */
export function captureSize(pose: CameraPose): { width: number; height: number } {
  const width = Math.min(640, pose.width);
  return { width, height: Math.round(width / pose.aspect) };
}

/* ---------- id colours ---------- */

const idColor = (k: number) => new THREE.Color().setRGB(((k + 1) & 255) / 255, (((k + 1) >> 8) & 255) / 255, 0, THREE.LinearSRGBColorSpace);
const decode = (r: number, g: number) => r + (g << 8) - 1;

/** Small rotation of a pose about its own axes, plus a translation, seeded. */
export function jitterPose(p: CameraPose, rand: () => number, posM = 0.15, yawDeg = 8, pitchDeg = 5): CameraPose {
  const yaw = ((rand() * 2 - 1) * yawDeg * Math.PI) / 180;
  const pitch = ((rand() * 2 - 1) * pitchDeg * Math.PI) / 180;
  const rot = (v: Vec3, axis: Vec3, a: number): Vec3 => {
    const s = Math.sin(a / 2);
    return qRotate([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(a / 2)], v);
  };
  let f = rot(p.forward, [0, 1, 0], yaw);
  let u = rot(p.up, [0, 1, 0], yaw);
  const r = cross(f, u);
  const rn = len(r) || 1;
  const right: Vec3 = [r[0] / rn, r[1] / rn, r[2] / rn];
  f = rot(f, right, pitch);
  u = rot(u, right, pitch);
  const position: Vec3 = [p.position[0] + (rand() * 2 - 1) * posM, p.position[1] + (rand() * 2 - 1) * posM * 0.5, p.position[2] + (rand() * 2 - 1) * posM];
  return { ...p, position, forward: f, up: u, right: cross(f, u) };
}

/* ---------- one frame ---------- */

interface Saved {
  target: THREE.WebGLRenderTarget | null;
  viewport: THREE.Vector4;
  scissor: THREE.Vector4;
  scissorTest: boolean;
  autoClear: boolean;
  clearColor: THREE.Color;
  clearAlpha: number;
  background: THREE.Scene["background"];
  uniforms: Map<string, unknown>;
  lights: { o: THREE.Light; intensity: number; position: THREE.Vector3; target?: THREE.Vector3 }[];
  shadowAuto: boolean;
}

function cloneValue(v: unknown): unknown {
  return v && typeof v === "object" && "clone" in (v as object) ? (v as { clone: () => unknown }).clone() : v;
}

function saveState(gl: THREE.WebGLRenderer, scene: THREE.Scene): Saved {
  const uniforms = new Map<string, unknown>();
  for (const [k, u] of Object.entries(waterUniforms)) uniforms.set(k, cloneValue(u.value));
  const L = fieldLights;
  return {
    target: gl.getRenderTarget(),
    viewport: gl.getViewport(new THREE.Vector4()),
    scissor: gl.getScissor(new THREE.Vector4()),
    scissorTest: gl.getScissorTest(),
    autoClear: gl.autoClear,
    clearColor: gl.getClearColor(new THREE.Color()),
    clearAlpha: gl.getClearAlpha(),
    background: scene.background,
    uniforms,
    lights: [L.sun, L.hemi, L.fill, ...L.spots].map((o) => ({ o, intensity: o.intensity, position: o.position.clone(), target: (o as THREE.SpotLight).target?.position.clone() })),
    shadowAuto: gl.shadowMap.autoUpdate,
  };
}

function restoreState(gl: THREE.WebGLRenderer, scene: THREE.Scene, s: Saved): void {
  gl.setRenderTarget(s.target);
  gl.setViewport(s.viewport);
  gl.setScissor(s.scissor);
  gl.setScissorTest(s.scissorTest);
  gl.autoClear = s.autoClear;
  gl.setClearColor(s.clearColor, s.clearAlpha);
  scene.background = s.background;
  for (const [k, v] of s.uniforms) {
    const u = (waterUniforms as Record<string, { value: unknown }>)[k];
    if (u.value && typeof u.value === "object" && "copy" in (u.value as object)) (u.value as { copy: (x: unknown) => void }).copy(v);
    else u.value = v;
  }
  for (const l of s.lights) {
    l.o.intensity = l.intensity;
    l.o.position.copy(l.position);
    const t = (l.o as THREE.SpotLight).target;
    if (t && l.target) {
      t.position.copy(l.target);
      t.updateMatrixWorld();
    }
  }
  gl.shadowMap.autoUpdate = s.shadowAuto;
}

/** Targets reusable across frames of one capture. */
export class CaptureContext {
  readonly rgb: THREE.WebGLRenderTarget;
  readonly ids: THREE.WebGLRenderTarget;
  readonly cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 120);
  private readonly black = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
  private readonly idMats: THREE.MeshBasicMaterial[] = [];
  readonly width: number;
  readonly height: number;
  private readonly buf: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    // the RGB target is flagged like an XR target so three applies tone mapping and the sRGB transfer, as on screen
    this.rgb = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, samples: 0, type: THREE.UnsignedByteType });
    this.rgb.texture.colorSpace = THREE.SRGBColorSpace;
    (this.rgb as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
    this.ids = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, samples: 0, type: THREE.UnsignedByteType });
    this.cam.layers.set(WORLD_LAYER);
    this.buf = new Uint8Array(width * height * 4);
  }

  idMaterial(k: number): THREE.MeshBasicMaterial {
    while (this.idMats.length <= k) this.idMats.push(new THREE.MeshBasicMaterial({ color: idColor(this.idMats.length), toneMapped: false }));
    return this.idMats[k];
  }

  get blackMaterial() {
    return this.black;
  }

  read(gl: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget): Uint8Array {
    gl.readRenderTargetPixels(rt, 0, 0, this.width, this.height, this.buf);
    return this.buf;
  }

  dispose(): void {
    this.rgb.dispose();
    this.ids.dispose();
    this.black.dispose();
    for (const m of this.idMats) m.dispose();
  }
}

interface Swap {
  obj: THREE.Mesh | THREE.Points | THREE.Line;
  material: THREE.Material | THREE.Material[];
  visible: boolean;
}

/** Index of the target an object belongs to, or -1. */
function targetIndexOf(o: THREE.Object3D, ids: string[]): number {
  let p: THREE.Object3D | null = o;
  while (p) {
    if (p.userData.gtId) return ids.indexOf(p.userData.gtId as string);
    p = p.parent;
  }
  return -1;
}

/** Renders one ID pass. `only` draws a single target and nothing else. Returns the pixel buffer (shared). */
function idPass(gl: THREE.WebGLRenderer, scene: THREE.Scene, ctx: CaptureContext, ids: string[], only: number | null): Uint8Array {
  const swaps: Swap[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!(m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) return;
    if (!o.layers.test(ctx.cam.layers)) return;
    swaps.push({ obj: m, material: m.material, visible: m.visible });
    if (!m.isMesh) {
      m.visible = false;
      return;
    }
    const k = targetIndexOf(o, ids);
    if (only !== null) {
      m.visible = m.visible && k === only;
      if (k === only) m.material = ctx.idMaterial(k);
      return;
    }
    m.material = k >= 0 ? ctx.idMaterial(k) : ctx.blackMaterial;
  });
  const bg = scene.background;
  scene.background = null;
  const shadowAuto = gl.shadowMap.autoUpdate;
  gl.shadowMap.autoUpdate = false;
  gl.setRenderTarget(ctx.ids);
  gl.setClearColor(0x000000, 1);
  gl.clear(true, true, true);
  gl.render(scene, ctx.cam);
  const px = ctx.read(gl, ctx.ids);
  for (const s of swaps) {
    s.obj.material = s.material as THREE.Material;
    s.obj.visible = s.visible;
  }
  scene.background = bg;
  gl.shadowMap.autoUpdate = shadowAuto;
  return px;
}

interface Stat {
  n: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Per-id pixel counts and tight boxes (top-left origin). */
function measure(px: Uint8Array, w: number, h: number, n: number): Stat[] {
  const out: Stat[] = Array.from({ length: n }, () => ({ n: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
  for (let row = 0; row < h; row++) {
    const y = h - 1 - row; // GL rows start at the bottom
    for (let x = 0; x < w; x++) {
      const i = (row * w + x) * 4;
      if (px[i] === 0 && px[i + 1] === 0) continue;
      const k = decode(px[i], px[i + 1]);
      if (k < 0 || k >= n) continue;
      const s = out[k];
      s.n++;
      if (x < s.x0) s.x0 = x;
      if (x > s.x1) s.x1 = x;
      if (y < s.y0) s.y0 = y;
      if (y > s.y1) s.y1 = y;
    }
  }
  return out;
}

/** Analytic projection of a target's box corners into a capture frame, pixels [x, y, w, h] (unclipped). */
export function analyticBox(pose: CameraPose, corners: Vec3[], w: number, h: number): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of corners) {
    const q = project(pose, c);
    if (!(q.depth > 0.05)) return null;
    x0 = Math.min(x0, q.u * w);
    x1 = Math.max(x1, q.u * w);
    y0 = Math.min(y0, q.v * h);
    y1 = Math.max(y1, q.v * h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * World corners of a target model's own meshes: each mesh's local bounding box carried through its world matrix
 * (oriented, so a yawed model is not inflated to an axis-aligned box). Used to verify the renderer against the camera.
 */
export function modelCorners(scene: THREE.Scene, id: string): Vec3[] | null {
  let root: THREE.Object3D | null = null;
  scene.traverse((o) => {
    if (!root && o.userData.gtId === id) root = o;
  });
  if (!root) return null;
  const out: Vec3[] = [];
  const v = new THREE.Vector3();
  (root as THREE.Object3D).updateMatrixWorld(true);
  (root as THREE.Object3D).traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox!;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      v.set(x, y, z).applyMatrix4(m.matrixWorld);
      out.push([v.x, v.y, v.z]);
    }
  });
  return out.length ? out : null;
}

/**
 * Renders and labels one frame at a camera pose. Synchronous GPU work (a few small passes); call it once per
 * animation frame. Restores every piece of state it changes.
 */
export function captureFrame(gl: THREE.WebGLRenderer, scene: THREE.Scene, engine: FieldEngine, pose: CameraPose, ctx: CaptureContext, index: number, seed: number): { frame: Omit<ManifestFrame, "file">; pixels: Uint8ClampedArray; analytic: Record<string, [number, number, number, number]> } {
  const saved = saveState(gl, scene);
  passControl.captureActive = true;
  try {
    targetSync.fn?.();
    const { width: W, height: H } = ctx;
    poseCamera(ctx.cam, pose);
    particleSync.wrapAround?.(ctx.cam.position);
    // the platform's lamps at this pose, the true water, the platform's exposure
    const rp = engine.renderPose();
    placeLamps(engine, rp as { position: Vec3; attitude: [number, number, number, number] }, pose, 0, lampIntensity(engine, pose.position[1]));
    const hit = rayToBed(engine, pose.position, pose.forward, 60);
    const dist = hit ?? Math.min(60, engine.visibility() * 1.5);
    const pass = applyPass(engine, { feed: true, viewScale: 1, fill: false, depthRefY: pose.position[1] + pose.forward[1] * dist, cameraPos: pose.position, viewDistance: dist, time: waterUniforms.uWaterTime.value });
    waterUniforms.uWaterViewportH.value = H;
    gl.setScissorTest(false);
    gl.autoClear = true;
    // RGB
    scene.background = pass.background;
    gl.shadowMap.autoUpdate = false;
    gl.setRenderTarget(ctx.rgb);
    gl.setViewport(0, 0, W, H);
    gl.clear(true, true, true);
    gl.render(scene, ctx.cam);
    const raw = ctx.read(gl, ctx.rgb);
    const pixels = new Uint8ClampedArray(W * H * 4);
    for (let row = 0; row < H; row++) {
      const src = (H - 1 - row) * W * 4;
      pixels.set(raw.subarray(src, src + W * 4), row * W * 4);
      for (let x = 0; x < W; x++) pixels[row * W * 4 + x * 4 + 3] = 255;
    }
    // instance ids with occluders, then each visible target alone
    const ids = engine.targets.map((t) => t.id);
    gl.setRenderTarget(ctx.ids);
    gl.setViewport(0, 0, W, H);
    const all = measure(idPass(gl, scene, ctx, ids, null), W, H, ids.length);
    const annotations: Annotation[] = [];
    const analytic: Record<string, [number, number, number, number]> = {};
    for (let k = 0; k < ids.length; k++) {
      const s = all[k];
      if (s.n < MIN_VISIBLE_PX) continue;
      const alone = measure(idPass(gl, scene, ctx, ids, k), W, H, ids.length)[k];
      const t = engine.targets[k];
      const box = modelCorners(scene, t.id);
      const ab = box ? analyticBox(pose, box, W, H) : null;
      if (ab) analytic[t.id] = ab;
      // truncated: the unoccluded silhouette touches the frame edge
      const truncated = alone.x0 <= 0 || alone.y0 <= 0 || alone.x1 >= W - 1 || alone.y1 >= H - 1;
      // share of the analytic box inside the frame approximates the silhouette that would lie outside it
      let inFrame = 1;
      if (ab && ab[2] > 0 && ab[3] > 0) {
        const ix = Math.max(0, Math.min(W, ab[0] + ab[2]) - Math.max(0, ab[0]));
        const iy = Math.max(0, Math.min(H, ab[1] + ab[3]) - Math.max(0, ab[1]));
        inFrame = Math.min(1, (ix * iy) / (ab[2] * ab[3]));
      }
      const occluded = alone.n > 0 ? Math.max(0, Math.min(1, 1 - s.n / alone.n)) : 0;
      const d = Math.hypot(t.position[0] - pose.position[0], t.position[1] - pose.position[1], t.position[2] - pose.position[2]);
      annotations.push({
        object_id: t.id,
        class_name: t.class,
        bbox_xywh: [s.x0, s.y0, s.x1 - s.x0 + 1, s.y1 - s.y0 + 1],
        visible_fraction: Math.round(Math.max(0, Math.min(1, (1 - occluded) * inFrame)) * 1e4) / 1e4,
        occluded_fraction: Math.round(occluded * 1e4) / 1e4,
        truncated,
        distance_m: Math.round(d * 1000) / 1000,
        area_px: s.n,
      });
    }
    // camera and conditions
    const f = focalPx({ ...pose, width: W, height: H });
    const q = ctx.cam.quaternion;
    const c = engine.conditions;
    const tel = engine.telemetry();
    const bed = terrainHeight(engine.env.geometry.terrain, pose.position[0], pose.position[2]);
    const vel = engine.vehicle ? tel.speedOverGround : 0;
    const lateralBlur = engine.platform.camera.exposureS * f * (vel / Math.max(0.2, dist) + (engine.vehicle ? len(engine.vehicle.angularVelocity) : 0));
    const frame: Omit<ManifestFrame, "file"> = {
      width: W,
      height: H,
      camera: {
        fx: round(f, 3),
        fy: round(f, 3),
        cx: W / 2,
        cy: H / 2,
        position: pose.position.map((v) => round(v, 4)) as Vec3,
        quaternion: [round(q.x, 6), round(q.y, 6), round(q.z, 6), round(q.w, 6)],
        hfov_deg: pose.hfovDeg,
      },
      conditions: {
        environment: engine.env.id,
        platform: engine.platform.id,
        turbidity: round(c.turbidity, 4),
        ntu: round(ntuAt(engine.env, c.turbidity), 4),
        lighting: round(c.lighting, 4),
        lamps: round(c.lamps, 4),
        current_speed_mps: round(c.current.speedMps, 4),
        current_dir_deg: round(c.current.headingDeg, 2),
        depth_m: round(-pose.position[1], 3),
        altitude_m: round(pose.position[1] - bed, 3),
        vehicle_speed_mps: round(vel, 4),
        motion_blur_px: round(lateralBlur, 3),
        seed,
        frame_index: index,
      },
      annotations,
    };
    return { frame, pixels, analytic };
  } finally {
    restoreState(gl, scene, saved);
    passControl.captureActive = false;
  }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** PNG of an RGBA buffer. */
export async function encodePng(pixels: Uint8ClampedArray, w: number, h: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("2D canvas unavailable");
  g.putImageData(new ImageData(pixels as unknown as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png"));
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export interface CaptureProgress {
  done: number;
  total: number;
}

/**
 * Runs a capture preset: one frame per animation frame, cancellable, reproducible from the seed.
 * Conditions changed by a sweep are restored at the end, also on cancel or error.
 */
export async function runCapture(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  engine: FieldEngine,
  opts: CaptureOptions,
  onProgress: (p: CaptureProgress) => void,
  signal: AbortSignal,
): Promise<{ manifest: Manifest; frames: CapturedFrame[] }> {
  const base = engine.cameraPose(false);
  const size = captureSize(base);
  const ctx = new CaptureContext(size.width, size.height);
  const rand = mulberry32(opts.seed >>> 0);
  const restore = { turbidity: engine.conditions.turbidity, lighting: engine.conditions.lighting, paused: engine.paused };
  const steps = [0, 0.25, 0.5, 0.75, 1];
  const total = opts.preset === "grid" ? CONDITION_GRID.length * Math.max(1, Math.min(20, Math.round(opts.frames))) : opts.preset === "turbidity" || opts.preset === "lighting" ? steps.length : Math.max(1, Math.min(500, Math.round(opts.frames)));
  const frames: CapturedFrame[] = [];
  engine.paused = true;
  try {
    if (opts.preset === "mission" && engine.phase !== "RUNNING" && engine.vehicle) engine.startMission();
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException("capture cancelled", "AbortError");
      await nextFrame();
      let pose: CameraPose;
      if (opts.preset === "jitter") pose = i === 0 ? base : jitterPose(base, rand);
      else if (opts.preset === "mission") {
        if (i > 0) engine.advance(Math.max(0.1, opts.everyS));
        pose = engine.cameraPose(false);
      } else if (opts.preset === "grid") {
        const [turbidity, lighting] = CONDITION_GRID[i % CONDITION_GRID.length];
        engine.setConditions({ turbidity, lighting });
        pose = i < CONDITION_GRID.length ? base : jitterPose(base, rand);
      } else {
        const v = opts.preset === "turbidity" ? steps[i] : 0.1 + 0.9 * steps[i];
        engine.setConditions(opts.preset === "turbidity" ? { turbidity: v } : { lighting: v });
        pose = base;
      }
      const shot = captureFrame(gl, scene, engine, pose, ctx, i, opts.seed);
      const file = `${String(i + 1).padStart(6, "0")}.png`;
      const png = await encodePng(shot.pixels, ctx.width, ctx.height);
      frames.push({ frame: { file, ...shot.frame }, png, analytic: shot.analytic });
      onProgress({ done: i + 1, total });
    }
  } finally {
    engine.setConditions({ turbidity: restore.turbidity, lighting: restore.lighting });
    engine.paused = restore.paused;
    ctx.dispose();
  }
  const manifest: Manifest = {
    schema: "gantrylab.dataset/1",
    name: opts.name.trim() || `${engine.env.id}-${engine.platform.id}-${opts.preset}`,
    seed: opts.seed,
    generator: GENERATOR,
    classes: [...GT_CLASSES],
    frames: frames.map((f) => f.frame),
  };
  return { manifest, frames };
}

/** Uploads a captured dataset to the backend. Throws with a readable message when it is unreachable or refuses. */
export async function uploadDataset(manifest: Manifest, frames: CapturedFrame[]): Promise<{ id: string; raw: unknown }> {
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  for (const f of frames) form.append("files", f.png, f.frame.file);
  let res: Response;
  try {
    res = await fetch(`${datasetApiBase()}/api/v1/datasets`, { method: "POST", body: form });
  } catch {
    throw new Error(`Backend not reachable at ${datasetApiBase()}. Start it, or save the manifest locally.`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? JSON.stringify((body as { detail: unknown }).detail).slice(0, 300) : res.statusText;
    throw new Error(`Backend refused the dataset (${res.status}): ${detail}`);
  }
  const id = body && typeof body === "object" ? String((body as { id?: unknown }).id ?? (body as { dataset?: { id?: unknown } }).dataset?.id ?? "") : "";
  return { id, raw: body };
}

/** Saves a JSON document through the browser. */
export function saveJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Verification probe: renders the instance-id pass of one target alone (no occluders) at the platform camera pose and
 * returns its tight pixel box next to the analytic projections (lib/field/camera.ts project) of the model's own mesh
 * bounds and of the engine's declared box. Used by the browser tests to tie the renderer to the analytic camera.
 */
export function probeTarget(gl: THREE.WebGLRenderer, scene: THREE.Scene, engine: FieldEngine, id: string): {
  width: number;
  height: number;
  rendered: [number, number, number, number] | null;
  pixels: number;
  analyticModel: [number, number, number, number] | null;
  analyticDeclared: [number, number, number, number] | null;
} {
  const pose = engine.cameraPose(false);
  const { width, height } = captureSize(pose);
  const ctx = new CaptureContext(width, height);
  const saved = saveState(gl, scene);
  passControl.captureActive = true;
  try {
    targetSync.fn?.();
    poseCamera(ctx.cam, pose);
    const ids = engine.targets.map((t) => t.id);
    const k = ids.indexOf(id);
    if (k < 0) return { width, height, rendered: null, pixels: 0, analyticModel: null, analyticDeclared: null };
    gl.setScissorTest(false);
    gl.setViewport(0, 0, width, height);
    const s = measure(idPass(gl, scene, ctx, ids, k), width, height, ids.length)[k];
    const mc = modelCorners(scene, id);
    const t = engine.targets[k];
    const [hx, hy, hz] = t.halfExtents;
    const r = (t.yawDeg * Math.PI) / 180;
    const c = Math.cos(r);
    const sn = Math.sin(r);
    const cy = t.position[1] - t.burial * hy;
    const decl: Vec3[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) decl.push([t.position[0] + sx * hx * c + sz * hz * sn, cy + sy * hy, t.position[2] - sx * hx * sn + sz * hz * c]);
    return {
      width,
      height,
      rendered: s.n > 0 ? [s.x0, s.y0, s.x1 - s.x0 + 1, s.y1 - s.y0 + 1] : null,
      pixels: s.n,
      analyticModel: mc ? analyticBox(pose, mc, width, height) : null,
      analyticDeclared: analyticBox(pose, decl, width, height),
    };
  } finally {
    restoreState(gl, scene, saved);
    passControl.captureActive = false;
    ctx.dispose();
  }
}
