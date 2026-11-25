"use client";

import * as THREE from "three";
import { authHeaders } from "@/lib/api/client";
import type { Vec3 } from "@/lib/physics/math";
import { waterUniforms } from "@/components/lab/water";

/*
 * Engine-independent core of the synthetic dataset capture, shared by the field worlds (components/field/capture.ts)
 * and the Gantry Lab (components/lab/capture.ts).
 *
 * Per frame each engine module renders:
 *   1. RGB pass: its camera into an offscreen target, tone mapped and sRGB encoded exactly as its live feed.
 *   2. Instance-ID pass of the same camera: every target's meshes flat in a unique id colour, every other mesh black
 *      (so terrain, sand, glass and structures still occlude), points and lines hidden, no tone mapping.
 *   3. One ID pass per visible target with only that target drawn, for the unoccluded pixel count.
 * Boxes, areas and occlusion come from those pixels; nothing is hand-drawn and nothing comes from a detector.
 *
 * Scene tagging: a target's root object carries `userData.gtId` (and `userData.gtClass`); a mesh inside a target that
 * is not part of the object (a sand mound it has settled into) carries `userData.gtOccluder` and is drawn black.
 */

export const GENERATOR = { app: "gantrylab-web", version: "0.2.0", renderer: `three r${THREE.REVISION}` };
export const MIN_VISIBLE_PX = 12;

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

export type Box = [number, number, number, number];

export interface CapturedFrame {
  frame: ManifestFrame;
  png: Blob;
  /** analytic projection of each annotated target's box in pixels, for verification */
  analytic: Record<string, Box>;
}

export interface CaptureProgress {
  done: number;
  total: number;
}

export const datasetApiBase = () => (process.env.NEXT_PUBLIC_GANTRYLAB_API ?? "http://localhost:8000").replace(/\/+$/, "");

export const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/* ---------- id colours ---------- */

const idColor = (k: number) => new THREE.Color().setRGB(((k + 1) & 255) / 255, (((k + 1) >> 8) & 255) / 255, 0, THREE.LinearSRGBColorSpace);
const decode = (r: number, g: number) => r + (g << 8) - 1;

/* ---------- GL state ---------- */

export interface SavedState {
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

/** Saves every piece of renderer, scene, water-uniform and light state a capture frame may change. */
export function saveState(gl: THREE.WebGLRenderer, scene: THREE.Scene, lights: THREE.Light[]): SavedState {
  const uniforms = new Map<string, unknown>();
  for (const [k, u] of Object.entries(waterUniforms)) uniforms.set(k, cloneValue(u.value));
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
    lights: lights.map((o) => ({ o, intensity: o.intensity, position: o.position.clone(), target: (o as THREE.SpotLight).target?.position.clone() })),
    shadowAuto: gl.shadowMap.autoUpdate,
  };
}

export function restoreState(gl: THREE.WebGLRenderer, scene: THREE.Scene, s: SavedState): void {
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

/* ---------- render targets ---------- */

export interface CaptureCameraSpec {
  near: number;
  far: number;
  /** the only layer the capture camera sees (HUD, vehicle and rig layers stay out) */
  layer: number;
}

/** Targets reusable across frames of one capture. */
export class CaptureContext {
  readonly rgb: THREE.WebGLRenderTarget;
  readonly ids: THREE.WebGLRenderTarget;
  readonly cam: THREE.PerspectiveCamera;
  private readonly black = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
  private readonly idMats: THREE.MeshBasicMaterial[] = [];
  readonly width: number;
  readonly height: number;
  private readonly buf: Uint8Array;

  constructor(width: number, height: number, spec: CaptureCameraSpec) {
    this.width = width;
    this.height = height;
    this.cam = new THREE.PerspectiveCamera(50, 16 / 9, spec.near, spec.far);
    // the RGB target is flagged like an XR target so three applies tone mapping and the sRGB transfer, as on screen
    this.rgb = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, samples: 0, type: THREE.UnsignedByteType });
    this.rgb.texture.colorSpace = THREE.SRGBColorSpace;
    (this.rgb as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
    this.ids = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, samples: 0, type: THREE.UnsignedByteType });
    this.cam.layers.set(spec.layer);
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

/**
 * RGB pass of `ctx.cam` into the RGB target; returns top-row-first opaque RGBA pixels. The caller sets the scene's
 * background, water uniforms and lights beforehand.
 */
export function renderRgb(gl: THREE.WebGLRenderer, scene: THREE.Scene, ctx: CaptureContext): Uint8ClampedArray {
  const { width: W, height: H } = ctx;
  gl.setRenderTarget(ctx.rgb);
  gl.clear(true, true, true);
  gl.render(scene, ctx.cam);
  const raw = ctx.read(gl, ctx.rgb);
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let row = 0; row < H; row++) {
    const src = (H - 1 - row) * W * 4;
    pixels.set(raw.subarray(src, src + W * 4), row * W * 4);
    for (let x = 0; x < W; x++) pixels[row * W * 4 + x * 4 + 3] = 255;
  }
  return pixels;
}

/* ---------- instance ids ---------- */

interface Swap {
  obj: THREE.Mesh | THREE.Points | THREE.Line;
  material: THREE.Material | THREE.Material[];
  visible: boolean;
}

/** Index of the target an object belongs to, or -1 (also for meshes tagged as occluders inside a target). */
function targetIndexOf(o: THREE.Object3D, ids: string[]): number {
  if (o.userData.gtOccluder) return -1;
  let p: THREE.Object3D | null = o;
  while (p) {
    if (p.userData.gtId) return ids.indexOf(p.userData.gtId as string);
    p = p.parent;
  }
  return -1;
}

/** Renders one ID pass. `only` draws a single target and nothing else. Returns the pixel buffer (shared). */
export function idPass(gl: THREE.WebGLRenderer, scene: THREE.Scene, ctx: CaptureContext, ids: string[], only: number | null): Uint8Array {
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

export interface Stat {
  n: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Per-id pixel counts and tight boxes (top-left origin). */
export function measure(px: Uint8Array, w: number, h: number, n: number): Stat[] {
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

/** Tight pixel box [x, y, w, h] of a measured id, or null when it has no pixels. */
export const statBox = (s: Stat): Box | null => (s.n > 0 ? [s.x0, s.y0, s.x1 - s.x0 + 1, s.y1 - s.y0 + 1] : null);

/** Root object of a target, found by its `userData.gtId`. */
export function findTarget(scene: THREE.Scene, id: string): THREE.Object3D | null {
  let root: THREE.Object3D | null = null;
  scene.traverse((o) => {
    if (!root && o.userData.gtId === id) root = o;
  });
  return root;
}

/**
 * World corners of a target model's own meshes: each mesh's local bounding box carried through its world matrix
 * (oriented, so a yawed model is not inflated to an axis-aligned box). Meshes tagged `gtOccluder` are not part of the
 * object and are skipped. Used to verify the renderer against the camera.
 */
export function modelCorners(scene: THREE.Scene, id: string): Vec3[] | null {
  const root = findTarget(scene, id);
  if (!root) return null;
  const out: Vec3[] = [];
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || m.userData.gtOccluder) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox!;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      v.set(x, y, z).applyMatrix4(m.matrixWorld);
      out.push([v.x, v.y, v.z]);
    }
  });
  return out.length ? out : null;
}

/** Pixel box [x, y, w, h] (unclipped) of world points under a projection to normalised image coordinates. */
export function projectedBox(points: Vec3[], project: (p: Vec3) => { u: number; v: number } | null, w: number, h: number): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of points) {
    const q = project(c);
    if (!q || !Number.isFinite(q.u) || !Number.isFinite(q.v)) return null;
    x0 = Math.min(x0, q.u * w);
    x1 = Math.max(x1, q.u * w);
    y0 = Math.min(y0, q.v * h);
    y1 = Math.max(y1, q.v * h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/* ---------- annotations ---------- */

export interface TargetRef {
  id: string;
  className: string;
  /** world position used for `distance_m` */
  position: Vec3;
}

/**
 * Labels every target visible in `ctx.cam`: one ID pass with occluders, then one per visible target alone.
 * `frameBox` gives the analytic pixel box of a target, used for the in-frame share of its silhouette; the boxes of the
 * annotated targets are returned for verification.
 */
export function annotateTargets(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  ctx: CaptureContext,
  targets: TargetRef[],
  cameraPosition: Vec3,
  frameBox: (id: string) => Box | null,
): { annotations: Annotation[]; boxes: Record<string, Box> } {
  const { width: W, height: H } = ctx;
  const ids = targets.map((t) => t.id);
  gl.setRenderTarget(ctx.ids);
  const all = measure(idPass(gl, scene, ctx, ids, null), W, H, ids.length);
  const annotations: Annotation[] = [];
  const boxes: Record<string, Box> = {};
  for (let k = 0; k < ids.length; k++) {
    const s = all[k];
    if (s.n < MIN_VISIBLE_PX) continue;
    const alone = measure(idPass(gl, scene, ctx, ids, k), W, H, ids.length)[k];
    const t = targets[k];
    const ab = frameBox(t.id);
    if (ab) boxes[t.id] = ab;
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
    const d = Math.hypot(t.position[0] - cameraPosition[0], t.position[1] - cameraPosition[1], t.position[2] - cameraPosition[2]);
    annotations.push({
      object_id: t.id,
      class_name: t.className,
      bbox_xywh: [s.x0, s.y0, s.x1 - s.x0 + 1, s.y1 - s.y0 + 1],
      visible_fraction: round(Math.max(0, Math.min(1, (1 - occluded) * inFrame)), 4),
      occluded_fraction: round(occluded, 4),
      truncated,
      distance_m: round(d, 3),
      area_px: s.n,
    });
  }
  return { annotations, boxes };
}

/* ---------- output ---------- */

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

/** Uploads a captured dataset to the backend. Throws with a readable message when it is unreachable or refuses. */
export async function uploadDataset(manifest: Manifest, frames: CapturedFrame[]): Promise<{ id: string; raw: unknown }> {
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  for (const f of frames) form.append("files", f.png, f.frame.file);
  let res: Response;
  try {
    res = await fetch(`${datasetApiBase()}/api/v1/datasets`, { method: "POST", body: form, headers: authHeaders() });
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
