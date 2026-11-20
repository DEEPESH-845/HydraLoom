"use client";

import { useEffect } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/*
 * Shared constants and helpers of the field world (components/field). Every object here is part of the open-water
 * digital twin; none of it belongs to the bench-top Gantry Lab (components/lab), which is its own experience at /lab.
 */

/** Render layers. Layer 0 is the world, seen by the main view and the platform camera. */
export const WORLD_LAYER = 0;
/** The platform's own hull, frame and housing: drawn in the main view, never in its own camera. */
export const VEHICLE_LAYER = 1;
/** HUD drawn inside the 3D view (flow arrows, route, trail, site outline): main view only, never water patched. */
export const HUD_LAYER = 2;

/** DOM element the platform camera feed is painted under. Must stay transparent. */
export const FIELD_FEED_ELEMENT_ID = "field-camera-feed";

/** Linear radiance of a white diffuse surface at full daylight or full lamp power, as in the lab (FeedRenderer). */
export const WHITE_AT_FULL_LIGHT = 0.9;

/** Puts an object and all of its descendants on one layer only. */
export function setLayer(o: THREE.Object3D, layer: number): void {
  o.traverse((c) => c.layers.set(layer));
}

/**
 * Collects GPU resources a world builds, so unmounting an environment frees every geometry, material and texture it
 * created (no leaks across switches).
 */
export class Disposables {
  private items = new Set<{ dispose: () => void }>();
  track<T extends { dispose: () => void }>(x: T): T {
    this.items.add(x);
    return x;
  }
  /** Tracks every geometry and material (and their textures) under a root. */
  trackTree(root: THREE.Object3D): void {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) this.items.add(m.geometry);
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) {
        this.items.add(mat);
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) this.items.add(v);
      }
      if ((o as THREE.InstancedMesh).isInstancedMesh) this.items.add(o as THREE.InstancedMesh);
    });
  }
  dispose(): void {
    for (const x of this.items) x.dispose();
    this.items.clear();
  }
}

export const std = (opts: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(opts);

const nonIndexed = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

/** Merges geometries (indexed or not) into one non-indexed geometry with the attributes they all share. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map(nonIndexed);
  // keep only attributes every part has, so mergeGeometries never fails on a stray uv or colour
  const names = Object.keys(flat[0].attributes).filter((n) => flat.every((g) => g.attributes[n]));
  for (const g of flat) for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
  const out = mergeGeometries(flat, false);
  for (const g of parts) g.dispose();
  for (const g of flat) g.dispose();
  return out;
}

/** Paints a constant vertex colour on a geometry (for merged parts that share one material). */
export function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, jitter = 0, seed = 1): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    let k = 1;
    if (jitter > 0) {
      s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
      k = 1 + jitter * ((s / 4294967296) * 2 - 1);
    }
    arr[i * 3] = c.r * k;
    arr[i * 3 + 1] = c.g * k;
    arr[i * 3 + 2] = c.b * k;
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Deterministic 3D value noise in 0..1 for geometry displacement. */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const h = (i: number, j: number, k: number) => {
    const v = Math.sin(i * 127.1 + j * 311.7 + k * 74.7 + seed * 19.19) * 43758.5453;
    return v - Math.floor(v);
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(x - xi);
  const v = s(y - yi);
  const w = s(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

export function fbm3(x: number, y: number, z: number, seed: number, octaves = 3): number {
  let v = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < octaves; i++) {
    v += a * noise3(x * f, y * f, z * f, seed + i * 7);
    n += a;
    a *= 0.5;
    f *= 2.07;
  }
  return v / n;
}

/** Displaces every vertex of a geometry along its direction from the origin by a noise field (rocks, corals). */
export function lumpy(g: THREE.BufferGeometry, amount: number, freq: number, seed: number): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + amount * (fbm3(v.x * freq + 5, v.y * freq + 3, v.z * freq + 1, seed) * 2 - 1);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Whether the user asked the system for reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Screen rect (CSS px) of the main view that no panel covers, measured from the overlay elements tagged data-field. */
export interface FreeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const rectOf = (name: string) => {
  const el = typeof document === "undefined" ? null : document.querySelector(`[data-field="${name}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
};

/**
 * The part of the canvas no panel covers. Desktop: right of the left edge, under the header, left of the right column,
 * above the bottom card. Compact (below 1000 px): the band between the header and the workspace strip.
 */
export function measureFreeRect(): FreeRect | null {
  if (typeof window === "undefined") return null;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const header = rectOf("header");
  const column = rectOf("column");
  const card = rectOf("card");
  const nav = rectOf("nav");
  const compact = W < 1000;
  if (compact) {
    const y1 = nav?.top ?? card?.top ?? H;
    return { x0: 8, y0: (header?.bottom ?? 48) + 8, x1: W - 8, y1: Math.max((header?.bottom ?? 48) + 60, y1 - 8) };
  }
  return {
    x0: 16,
    y0: (header?.bottom ?? 48) + 40,
    x1: (column?.left ?? W - 340) - 16,
    y1: Math.max((header?.bottom ?? 48) + 120, (card?.top ?? H - 300) - 12),
  };
}

const pendingDispose = new Map<object, number>();

/**
 * Frees a resource set when its component unmounts for good. Disposal is deferred a few seconds and cancelled if the
 * same set is mounted again (React StrictMode runs effects twice in development, and a compileAsync from a previous
 * world switch may still be polling these materials).
 */
export function useDeferredDispose(key: object, dispose: () => void): void {
  useEffect(() => {
    const t = pendingDispose.get(key);
    if (t !== undefined) {
      window.clearTimeout(t);
      pendingDispose.delete(key);
    }
    return () => {
      pendingDispose.set(
        key,
        window.setTimeout(() => {
          pendingDispose.delete(key);
          dispose();
        }, 4000),
      );
    };
  }, [key, dispose]);
}
