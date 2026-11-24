"use client";

import * as THREE from "three";
import { weather } from "@/components/lab/weathering";
import { mulberry32 } from "@/lib/sim/rng";
import type { AssetKind, AssetPlacement, EnvironmentDefinition } from "@/lib/world/schema";
import { terrainHeight } from "@/lib/world/terrain";
import { fbm3, lumpy, merge, paint, std } from "./common";

/*
 * Scenery of the field sites, built procedurally at real scale (no downloads). Explicit placements (`at`) are merged
 * into one mesh per kind; scattered kinds are one InstancedMesh each with per-instance colour. Everything sits on the
 * terrain height function (lowest point of its footprint, sunk a little so nothing floats), and scatter keeps clear
 * of the ground-truth targets and the solid structures.
 * World-space positions are stored relative to the site root at (0, baseY, 0) for precision at abyssal depth.
 */

export interface Placed {
  x: number;
  z: number;
  yaw: number;
  s: number;
}

/** Instance placements of a scatter, seeded and reproducible (lib/sim/rng mulberry32). */
export function scatterPlacements(env: EnvironmentDefinition, a: AssetPlacement): Placed[] {
  if (a.at) return a.at.map(([x, z, yawDeg, s]) => ({ x, z, yaw: (yawDeg * Math.PI) / 180, s }));
  const sc = a.scatter;
  if (!sc || sc.count <= 0) return [];
  const rand = mulberry32(sc.seed);
  const [x0, z0, x1, z1] = sc.area;
  const solids: { x: number; z: number; r: number }[] = [];
  for (const b of env.assets) if (b.solidRadius && b.at) for (const [x, z, , s] of b.at) solids.push({ x, z, r: b.solidRadius * s });
  const quayZ = env.geometry.terrain.basin?.quayZ;
  const out: Placed[] = [];
  for (let i = 0; i < sc.count; i++) {
    for (let tries = 0; tries < 10; tries++) {
      const x = x0 + rand() * (x1 - x0);
      const z = z0 + rand() * (z1 - z0);
      const s = sc.scale[0] + rand() * (sc.scale[1] - sc.scale[0]);
      const yaw = rand() * Math.PI * 2;
      const reach = s * 0.6;
      // keep clear of targets (so they stay visible and their ground truth is not hidden inside scenery)
      const nearTarget = env.targets.some((t) => Math.hypot(t.x - x, t.z - z) < Math.max(t.halfExtents[0], t.halfExtents[2]) + 0.5 + reach);
      const nearSolid = solids.some((c) => Math.hypot(c.x - x, c.z - z) < c.r + 0.3 + reach);
      const behindQuay = quayZ !== undefined && z < quayZ + 0.2 + reach;
      if (nearTarget || nearSolid || behindQuay) continue;
      out.push({ x, z, yaw, s });
      break;
    }
  }
  return out;
}

/** Lowest seabed point under a footprint of radius r around (x, z). */
export function footprintLow(env: EnvironmentDefinition, x: number, z: number, r: number): number {
  const t = env.geometry.terrain;
  let y = terrainHeight(t, x, z);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    y = Math.min(y, terrainHeight(t, x + Math.cos(a) * r, z + Math.sin(a) * r));
  }
  return y;
}

/* ---------- unit geometries ---------- */

function rockGeometry(seed: number, detail = 2): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  // flatter than tall, with a facetted, fractured surface
  for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * 0.62);
  lumpy(g, 0.28, 1.6, seed);
  return g;
}

function boulderGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 3);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * 0.7);
  lumpy(g, 0.18, 1.2, seed);
  return g;
}

function noduleGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * 0.7);
  return lumpy(g, 0.22, 3, 9);
}

/** A bent ribbon blade from y = 0 to y = h, width w, curving along +x. */
function blade(h: number, w: number, lean: number, twist: number, segs = 6): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = h * t;
    const x = lean * h * t * t;
    const half = (w / 2) * (1 - 0.85 * t);
    const a = twist * t;
    pos.push(x - Math.cos(a) * half, y, -Math.sin(a) * half, x + Math.cos(a) * half, y, Math.sin(a) * half);
    if (i < segs) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function clump(n: number, h: [number, number], w: number, spread: number, lean: number, seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const b = blade(h[0] + rand() * (h[1] - h[0]), w * (0.7 + 0.6 * rand()), lean * (0.4 + rand()), (rand() - 0.5) * 2.5);
    b.rotateY(rand() * Math.PI * 2);
    b.translate((rand() - 0.5) * spread, 0, (rand() - 0.5) * spread);
    parts.push(b);
  }
  const g = merge(parts);
  g.computeVertexNormals();
  return g;
}

function coralMassive(seed: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.5, 40, 22, 0, Math.PI * 2, 0, Math.PI * 0.62);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // lobed boulder colony with meandering valleys (brain coral) on its surface
    const lobes = 1 + 0.18 * (fbm3(v.x * 2.2, v.y * 2.2, v.z * 2.2, seed) * 2 - 1);
    const groove = 1 - 0.025 * Math.abs(Math.sin((v.x * 31 + 9 * fbm3(v.x * 4, v.y * 4, v.z * 4, seed + 3)) * 1.1 + v.z * 23));
    v.multiplyScalar(lobes * groove);
    v.y = v.y * 0.75 - 0.08;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function coralBranching(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const grow = (base: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
    const end = base.clone().addScaledVector(dir, len);
    const c = new THREE.CylinderGeometry(r * 0.7, r, len, 6, 1);
    c.translate(0, len / 2, 0);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    c.translate(base.x, base.y, base.z);
    parts.push(c);
    if (depth <= 0) {
      const tip = new THREE.SphereGeometry(r * 0.75, 6, 4);
      tip.translate(end.x, end.y, end.z);
      parts.push(tip);
      return;
    }
    const kids = depth > 1 ? 3 : 2;
    for (let k = 0; k < kids; k++) {
      const d = dir
        .clone()
        .add(new THREE.Vector3((rand() - 0.5) * 1.1, 0.35 + rand() * 0.3, (rand() - 0.5) * 1.1))
        .normalize();
      grow(end, d, len * (0.65 + rand() * 0.2), r * 0.72, depth - 1);
    }
  };
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + rand();
    grow(new THREE.Vector3(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05), new THREE.Vector3(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5).normalize(), 0.18, 0.025, 3);
  }
  return merge(parts);
}

function coralPlate(seed: number): THREE.BufferGeometry {
  const stalk = new THREE.CylinderGeometry(0.05, 0.08, 0.3, 8).translate(0, 0.15, 0);
  const table = new THREE.CylinderGeometry(0.5, 0.42, 0.05, 40, 1);
  const p = table.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const a = Math.atan2(z, x);
    const r = Math.hypot(x, z);
    const k = 1 + 0.14 * (fbm3(Math.cos(a) * 2, Math.sin(a) * 2, 0, seed) * 2 - 1);
    p.setXYZ(i, x * k, p.getY(i) + 0.05 * (r / 0.5) ** 2, z * k);
  }
  table.computeVertexNormals();
  table.translate(0, 0.32, 0);
  return merge([stalk, table]);
}

function spongeGeometry(): THREE.BufferGeometry {
  // vase sponge: lathe profile with an open osculum on top
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(new THREE.Vector2(0.05 + 0.2 * Math.sin(t * Math.PI * 0.55) + 0.03 * t, t));
  }
  for (let i = 12; i >= 2; i--) {
    const t = i / 12;
    pts.push(new THREE.Vector2(0.03 + 0.2 * Math.sin(t * Math.PI * 0.55) + 0.02 * t, t - 0.03));
  }
  const g = new THREE.LatheGeometry(pts, 18);
  return lumpy(g, 0.06, 6, 4);
}

function kelpGeometry(seed: number): THREE.BufferGeometry {
  const stipe = new THREE.CylinderGeometry(0.012, 0.02, 4, 5, 8).translate(0, 2, 0);
  const blades = clump(8, [1.2, 2.2], 0.16, 0.2, 0.25, seed);
  blades.translate(0, 1.6, 0);
  return merge([stipe, blades]);
}

/* ---------- explicit structures ---------- */

const FOULING = new THREE.Color("#4a4a2c");
const FOULING_DARK = new THREE.Color("#2e3022");

/** Steel tube pile from the bed to above the surface, with a marine growth band thickest a metre or two down. */
function pilingGeometry(bedY: number, seed: number): THREE.BufferGeometry {
  const top = 1.4;
  const bottom = bedY - 0.6;
  const H = top - bottom;
  const g = new THREE.CylinderGeometry(0.3, 0.3, H, 28, Math.max(8, Math.round(H * 4)), false);
  g.translate(0, bottom + H / 2, 0);
  const p = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const steel = new THREE.Color("#4b3a2c");
  const splash = new THREE.Color("#6e4a2c");
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // growth: strongest just below the waterline, thinning with depth; clumps of mussels and weed
    const band = y > 0.1 ? 0 : Math.min(1, -y / 0.6) * Math.exp(-Math.max(0, -y - 1.5) / 4);
    const clumps = fbm3(x * 6, y * 5, z * 6, seed);
    const growth = Math.min(1, band * (0.55 + 0.9 * clumps));
    const r = 1 + growth * 0.18 * clumps;
    p.setXYZ(i, x * r, y, z * r);
    c.copy(y > 0.1 ? splash : steel).lerp(clumps > 0.55 ? FOULING_DARK : FOULING, growth);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Fouling colour by height for structures that cross the waterline. */
function foulVertexColors(g: THREE.BufferGeometry, base: THREE.ColorRepresentation, seed: number, scale = 2): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const b = new THREE.Color(base);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const band = y > 0.15 ? 0 : Math.min(1, -y / 0.5) * (0.35 + 0.65 * Math.exp(-Math.max(0, -y - 1) / 5));
    const n = fbm3(x * scale, y * scale, z * scale, seed);
    c.copy(b).multiplyScalar(0.85 + 0.3 * n).lerp(n > 0.55 ? FOULING_DARK : FOULING, Math.min(1, band * (0.4 + 0.8 * n)));
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/** Concrete quay wall along x with panel joints, timber fenders, hung tyre fenders, a ladder and bollards on the cope. */
function quayWallGeometry(env: EnvironmentDefinition, z0: number, bedLow: number): THREE.BufferGeometry {
  const [ex] = env.geometry.extentM;
  const L = ex;
  const top = 1.6;
  const bottom = bedLow - 0.8;
  const H = top - bottom;
  const back = -env.geometry.extentM[1] / 2;
  const thick = Math.max(0.3, z0 - back);
  const parts: THREE.BufferGeometry[] = [];
  const face = new THREE.BoxGeometry(L, H, thick, Math.round(L * 2), Math.round(H * 3), 1);
  face.translate(0, bottom + H / 2, z0 - thick / 2);
  parts.push(foulVertexColors(face, "#6f6a5e", 31, 1.4));
  // vertical panel joints and a horizontal construction joint, slightly proud and darker
  for (let x = -L / 2 + 2.5; x < L / 2; x += 2.5) parts.push(paint(new THREE.BoxGeometry(0.04, H, 0.03).translate(x, bottom + H / 2, z0 + 0.012), "#3d3a33"));
  parts.push(paint(new THREE.BoxGeometry(L, 0.04, 0.03).translate(0, -3.2, z0 + 0.012), "#3d3a33"));
  // cope beam and bollards
  parts.push(paint(new THREE.BoxGeometry(L, 0.35, 0.7).translate(0, top + 0.1, z0 + 0.12), "#7a756a"));
  for (let x = -L / 2 + 4; x < L / 2; x += 8) {
    parts.push(paint(new THREE.CylinderGeometry(0.16, 0.2, 0.45, 14).translate(x, top + 0.5, z0 - 0.15), "#2c2b2a"));
    parts.push(paint(new THREE.CylinderGeometry(0.24, 0.24, 0.06, 14).translate(x, top + 0.75, z0 - 0.15), "#2c2b2a"));
  }
  // timber fenders every 5 m, from the cope to two metres down
  for (let x = -L / 2 + 2.5; x < L / 2; x += 5) {
    const f = new THREE.BoxGeometry(0.3, 3.8, 0.25, 1, 10, 1).translate(x, top - 1.9, z0 + 0.14);
    parts.push(foulVertexColors(f, "#4a3a28", 33, 3));
  }
  // tyre fenders hung on chains between the timbers, at the waterline
  for (let x = -L / 2 + 5; x < L / 2 - 1; x += 5) {
    const t = new THREE.TorusGeometry(0.36, 0.13, 10, 20).translate(x, -0.15, z0 + 0.15);
    parts.push(foulVertexColors(t, "#1d1d1e", 35, 4));
    parts.push(paint(new THREE.BoxGeometry(0.03, 1.4, 0.03).translate(x, top - 0.55, z0 + 0.1), "#3a2d22"));
  }
  // steel ladder in a recess
  const lx = 7;
  for (const dx of [-0.22, 0.22]) parts.push(paint(new THREE.BoxGeometry(0.05, H - 0.5, 0.05).translate(lx + dx, bottom + 0.5 + (H - 0.5) / 2, z0 + 0.08), "#3c3026"));
  for (let y = bottom + 0.8; y < top; y += 0.32) parts.push(paint(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 6).rotateZ(Math.PI / 2).translate(lx, y, z0 + 0.1), "#3c3026"));
  return merge(parts);
}

/** A moored vessel's hull, keel at the draft, with antifouling, boot-top, bilge keels, anodes and slime. */
function hullGeometry(): THREE.BufferGeometry {
  const L = 24;
  const B = 7;
  const T = 3.2;
  const free = 1.8;
  const nu = 72;
  const nv = 28;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu;
    const x = -L / 2 + L * u;
    // fuller aft, fine bow
    const fwd = u > 0.6 ? 1 - ((u - 0.6) / 0.4) ** 1.7 : 1;
    const aft = u < 0.12 ? 0.55 + 0.45 * (u / 0.12) : 1;
    const half = (B / 2) * Math.max(0.02, fwd * aft);
    const keelRise = u > 0.85 ? ((u - 0.85) / 0.15) * 1.6 : u < 0.06 ? ((0.06 - u) / 0.06) * 1.2 : 0;
    for (let j = 0; j <= nv; j++) {
      // v from port deck edge, down round the bilge to the keel, up to starboard
      const v = j / nv;
      const a = (v - 0.5) * Math.PI;
      const s = Math.sin(a);
      const cb = Math.cos(a);
      const k = Math.pow(Math.abs(cb), 0.35);
      const z = half * Math.sign(s) * Math.pow(Math.abs(s), 0.25);
      const y = free - (free + T - keelRise) * k;
      pos.push(x, y, z);
    }
  }
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j;
      const b = a + nv + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  const hull = new THREE.BufferGeometry();
  hull.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  hull.setIndex(idx);
  hull.computeVertexNormals();
  const p = hull.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const anti = new THREE.Color("#3f2622");
  const boot = new THREE.Color("#1c1c1e");
  const topside = new THREE.Color("#33414a");
  const slime = new THREE.Color("#3f4630");
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    c.copy(y > 0.35 ? topside : y > -0.4 ? boot : anti);
    const n = fbm3(x * 0.7, y * 1.5, z * 0.7, 41);
    if (y < 0.2) c.lerp(slime, Math.min(1, Math.max(0, (n - 0.42) * 2.2)) * 0.8);
    c.multiplyScalar(0.85 + 0.3 * fbm3(x * 3, y * 3, z * 3, 43));
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  hull.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const parts: THREE.BufferGeometry[] = [hull.toNonIndexed()];
  hull.dispose();
  // bilge keels along the turn of the bilge, sacrificial anodes, rudder and propeller boss aft
  for (const sz of [-1, 1]) {
    parts.push(paint(new THREE.BoxGeometry(9, 0.05, 0.35).rotateX(sz * 0.7).translate(-1, -T + 0.75, sz * (B / 2 - 0.55)), "#4a2a22"));
    for (const x of [-7, -2, 3]) parts.push(paint(new THREE.BoxGeometry(0.6, 0.18, 0.12).translate(x, -T + 0.9, sz * (B / 2 - 0.25)), "#8d8a82"));
  }
  parts.push(paint(new THREE.BoxGeometry(1.4, 2.2, 0.16).translate(-L / 2 - 0.2, -T + 1.5, 0), "#4d2a21"));
  parts.push(paint(new THREE.CylinderGeometry(0.3, 0.35, 0.8, 14).rotateZ(Math.PI / 2).translate(-L / 2 + 0.9, -T + 1.3, 0), "#6b5a3c"));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    parts.push(paint(new THREE.BoxGeometry(0.12, 1.0, 0.35).rotateX(a).translate(-L / 2 + 0.5, -T + 1.3 + Math.cos(a) * 0.5, Math.sin(a) * 0.5), "#6b5a3c"));
  }
  return merge(parts);
}

function mooringBlockGeometry(): THREE.BufferGeometry {
  const block = foulVertexColors(new THREE.BoxGeometry(1.3, 0.75, 1.3, 4, 3, 4).translate(0, 0.3, 0), "#6a665c", 51, 3);
  const ring = paint(new THREE.TorusGeometry(0.14, 0.035, 8, 18).translate(0, 0.82, 0), "#3e2a1d");
  return merge([block, ring]);
}

/** Chain link (studless), long axis along +y, 0.2 m long. */
function linkGeometry(): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(0.06, 0.018, 6, 12);
  g.scale(0.75, 1.35, 1);
  return g;
}

/** Bridge pier: column from the bed to above the surface with a cap, a scoured, exposed footing collar. */
function pierGeometry(bedY: number, r: number): THREE.BufferGeometry {
  const top = 3.2;
  const bottom = bedY - 1.0;
  const H = top - bottom;
  const col = foulVertexColors(new THREE.CylinderGeometry(r, r * 1.04, H, 40, Math.round(H * 3)).translate(0, bottom + H / 2, 0), "#7d786c", 61, 1.5);
  // the footing exposed by scour: a wider collar standing proud of the bed, undermined on its downstream side
  const collar = foulVertexColors(new THREE.CylinderGeometry(r * 1.55, r * 1.62, 0.7, 40, 2).translate(0, bedY - 0.05, 0), "#5f5a50", 63, 2.5);
  const cap = paint(new THREE.BoxGeometry(2.8, 0.9, r * 3).translate(0, top + 0.45, 0), "#8a857a", 0.05, 3);
  return merge([col, collar, cap]);
}

function branchGeometry(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const limb = (x0: number, z0: number, a: number, len: number, r: number, depth: number) => {
    const c = new THREE.CylinderGeometry(r * 0.6, r, len, 7, 4);
    c.rotateZ(Math.PI / 2);
    c.translate(len / 2, 0, 0);
    c.rotateY(a);
    c.translate(x0, r, z0);
    parts.push(c);
    if (depth > 0)
      for (let k = 0; k < 2; k++) {
        const t = 0.35 + rand() * 0.5;
        const nx = x0 + Math.cos(a) * len * t;
        const nz = z0 - Math.sin(a) * len * t;
        limb(nx, nz, a + (rand() > 0.5 ? 1 : -1) * (0.5 + rand() * 0.5), len * (0.35 + rand() * 0.25), r * 0.55, depth - 1);
      }
  };
  limb(-1.5, 0, 0, 3.2, 0.09, 2);
  const g = merge(parts);
  return paint(g, "#4b4135", 0.12, seed);
}

function outcropGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1.6, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    // ledged basalt: stepped in height, flattened, broad at the base
    let y = p.getY(i) * 0.55;
    y = Math.round(y / 0.18) * 0.18 * 0.6 + y * 0.4;
    p.setY(i, Math.max(-0.4, y));
  }
  return lumpy(g, 0.2, 0.9, seed);
}

/* ---------- materials ---------- */

/** Vertical plants lean with the current and sway; the bend grows with the square of the height in the plant. */
export const swayUniforms = {
  uSwayTime: { value: 0 },
  /** world xz current direction, scaled 0..1 by speed */
  uSwayDir: { value: new THREE.Vector2(0, 0) },
};

function swayMaterial(m: THREE.MeshStandardMaterial, height: number): THREE.MeshStandardMaterial {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    prev.call(m, shader, r);
    Object.assign(shader.uniforms, swayUniforms, { uSwayHeight: { value: height } });
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nuniform float uSwayTime;\nuniform vec2 uSwayDir;\nuniform float uSwayHeight;").replace(
      "#include <project_vertex>",
      `vec4 swLocal = vec4(transformed, 1.0);
vec3 swBase = vec3(0.0);
float swScale = 1.0;
#ifdef USE_INSTANCING
  swLocal = instanceMatrix * swLocal;
  swBase = instanceMatrix[3].xyz;
  swScale = length(instanceMatrix[1].xyz);
#endif
vec4 swWorld = modelMatrix * swLocal;
float swH = clamp(transformed.y / uSwayHeight, 0.0, 1.5);
float swPh = dot(swBase.xz, vec2(0.37, 0.71));
vec2 swOff = uSwayDir * 0.45 + vec2(sin(uSwayTime * 1.3 + swPh), cos(uSwayTime * 1.05 + swPh * 1.7)) * (0.04 + 0.08 * length(uSwayDir));
swWorld.xz += swOff * swH * swH * swScale * uSwayHeight;
vec4 mvPosition = viewMatrix * swWorld;
gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  m.customProgramCacheKey = () => `field-sway-${height}`;
  return m;
}

const KIND_STYLE: Partial<Record<AssetKind, { colors: string[]; rough: number; sink: number; radius: number }>> = {
  rock: { colors: ["#5a564d", "#4c4a45", "#6a6152", "#45413a"], rough: 0.92, sink: 0.18, radius: 0.45 },
  boulder: { colors: ["#55524b", "#4a4842", "#5f5a4f"], rough: 0.9, sink: 0.22, radius: 0.5 },
  nodule: { colors: ["#2a2520", "#1f1c19", "#34291f"], rough: 0.85, sink: 0.22, radius: 0.5 },
  weed: { colors: ["#4b4a24", "#3d4220", "#55502a"], rough: 0.8, sink: 0.02, radius: 0.2 },
  seagrass: { colors: ["#3f5a2a", "#4a5f2c", "#38512a"], rough: 0.75, sink: 0.02, radius: 0.15 },
  kelp: { colors: ["#4f4520", "#5a4a22"], rough: 0.7, sink: 0, radius: 0.1 },
  "coral-massive": { colors: ["#9a8455", "#8c7a52", "#7a7148", "#7d6466", "#a08a60"], rough: 0.9, sink: 0.1, radius: 0.45 },
  "coral-branching": { colors: ["#b5a17a", "#a38f6c", "#8e8094", "#9d8c63"], rough: 0.85, sink: 0.02, radius: 0.35 },
  "coral-plate": { colors: ["#8f8a6a", "#9b8a6a", "#857a5c"], rough: 0.85, sink: 0.02, radius: 0.5 },
  sponge: { colors: ["#c9bfa3", "#b9ad8c", "#d2c6a8"], rough: 0.95, sink: 0.03, radius: 0.25 },
};

/* ---------- building ---------- */

/**
 * Builds the scenery of an environment under a group positioned at (0, baseY, 0).
 * Names are `asset-<kind>`; nothing in a field site is named like the lab's gantry parts.
 */
export function buildAssets(env: EnvironmentDefinition, baseY: number): THREE.Group {
  const root = new THREE.Group();
  root.name = "field-assets";
  const t = env.geometry.terrain;
  const bed = (x: number, z: number) => terrainHeight(t, x, z);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();

  for (const a of env.assets) {
    const placed = scatterPlacements(env, a);
    if (!placed.length) continue;
    const name = `asset-${a.kind}`;
    const style = KIND_STYLE[a.kind];
    if (style) {
      // instanced scatter (also used for explicit placements of scatter-type kinds)
      const seed = (a.scatter?.seed ?? 1) * 7 + a.kind.length;
      let geo: THREE.BufferGeometry;
      let height = 1;
      switch (a.kind) {
        case "rock":
          geo = rockGeometry(seed);
          break;
        case "boulder":
          geo = boulderGeometry(seed);
          break;
        case "nodule":
          geo = noduleGeometry();
          break;
        case "weed":
          geo = clump(9, [0.5, 1.0], 0.05, 0.25, 0.25, seed);
          break;
        case "seagrass":
          geo = clump(16, [0.55, 1.0], 0.018, 0.22, 0.12, seed);
          break;
        case "kelp":
          geo = kelpGeometry(seed);
          height = 4;
          break;
        case "coral-massive":
          geo = coralMassive(seed);
          break;
        case "coral-branching":
          geo = coralBranching(seed);
          break;
        case "coral-plate":
          geo = coralPlate(seed);
          break;
        case "sponge":
        default:
          geo = spongeGeometry();
          break;
      }
      const plant = a.kind === "weed" || a.kind === "seagrass" || a.kind === "kelp";
      let mat = std({ color: "#ffffff", roughness: style.rough, metalness: 0, side: plant ? THREE.DoubleSide : THREE.FrontSide });
      if (plant) mat = swayMaterial(mat, height);
      else if (a.kind !== "nodule") mat = weather(mat, { scale: a.kind.startsWith("coral") ? 18 : 6, rust: 0, silt: env.seabed.material === "ooze" ? 0.7 : 0.45, growth: a.kind === "rock" || a.kind === "boulder" ? 0.35 : 0, bump: 1.5, seed: seed % 13 });
      const im = new THREE.InstancedMesh(geo, mat, placed.length);
      im.name = name;
      const rand = mulberry32(seed + 3);
      placed.forEach((p, i) => {
        const y = footprintLow(env, p.x, p.z, p.s * style.radius) - style.sink * p.s * (a.kind === "nodule" ? 1 : 0.8) - baseY;
        const squash = a.kind === "rock" || a.kind === "boulder" ? 0.8 + 0.4 * rand() : 1;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
        m4.compose(new THREE.Vector3(p.x, y, p.z), q, new THREE.Vector3(p.s * squash, p.s, p.s * (2 - squash)));
        im.setMatrixAt(i, m4);
        col.set(style.colors[Math.floor(rand() * style.colors.length)]).multiplyScalar(0.85 + 0.3 * rand());
        im.setColorAt(i, col);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = !plant && a.kind !== "nodule";
      im.receiveShadow = true;
      root.add(im);
      continue;
    }

    // explicit structures, merged per kind
    const parts: THREE.BufferGeometry[] = [];
    let chainLinks: THREE.Matrix4[] | null = null;
    for (const p of placed) {
      let g: THREE.BufferGeometry;
      switch (a.kind) {
        case "piling":
          g = pilingGeometry(bed(p.x, p.z), Math.round(p.x * 13));
          g.rotateY(p.yaw);
          g.translate(p.x, -baseY, p.z);
          break;
        case "quay-wall":
          g = quayWallGeometry(env, p.z, Math.min(bed(0, p.z + 0.5), bed(-15, p.z + 0.5), bed(15, p.z + 0.5)));
          g.translate(p.x, -baseY, 0);
          break;
        case "hull-section":
          g = hullGeometry();
          g.rotateY(p.yaw);
          g.translate(p.x, -baseY, p.z);
          break;
        case "mooring-block":
          g = mooringBlockGeometry();
          g.rotateY(p.yaw);
          g.translate(p.x, footprintLow(env, p.x, p.z, 0.7) - 0.15 - baseY, p.z);
          break;
        case "mooring-chain": {
          chainLinks = chainLinks ?? [];
          // catenary-like lead from the block's ring up to a surface buoy, carried downstream by the current
          const y0 = footprintLow(env, p.x, p.z, 0.7) - 0.15 + 0.82;
          const head = ((env.current.headingDeg ?? 90) * Math.PI) / 180;
          const dx = Math.sin(head);
          const dz = -Math.cos(head);
          const depth = -y0;
          const lead = depth * 0.55;
          const pts: THREE.Vector3[] = [];
          // a short length lies on the bed before it rises
          for (let k = 0; k <= 60; k++) {
            const s = k / 60;
            const along = lead * (0.25 + 0.75 * s) * 1.1 - lead * 0.25;
            const rise = s < 0.18 ? 0 : Math.pow((s - 0.18) / 0.82, 1.6) * depth;
            const ground = s < 0.18 ? (s / 0.18) * 0.6 : 0.6;
            pts.push(new THREE.Vector3(p.x + dx * (along + ground), Math.max(bed(p.x + dx * along, p.z + dz * along) + 0.04, y0 + rise - 0.35 * Math.sin(Math.PI * s)), p.z + dz * (along + ground)));
          }
          const curve = new THREE.CatmullRomCurve3(pts);
          const n = Math.floor(curve.getLength() / 0.17);
          const up = new THREE.Vector3(0, 1, 0);
          for (let k = 0; k < n; k++) {
            const pt = curve.getPointAt(k / n);
            const tg = curve.getTangentAt(k / n);
            const qq = new THREE.Quaternion().setFromUnitVectors(up, tg);
            qq.multiply(new THREE.Quaternion().setFromAxisAngle(up, k % 2 ? Math.PI / 2 : 0));
            chainLinks.push(new THREE.Matrix4().compose(new THREE.Vector3(pt.x, pt.y - baseY, pt.z), qq, new THREE.Vector3(1, 1, 1)));
          }
          // the buoy at the surface
          const buoy = paint(new THREE.SphereGeometry(0.45, 20, 14).scale(1, 0.8, 1), "#8a3b26", 0.05, 5);
          const last = pts[pts.length - 1];
          buoy.translate(last.x, 0.1 - baseY, last.z);
          g = buoy;
          break;
        }
        case "bridge-pier":
          g = pierGeometry(footprintLow(env, p.x, p.z, (a.solidRadius ?? 1) * p.s), (a.solidRadius ?? 1) * p.s);
          g.translate(p.x, -baseY, p.z);
          break;
        case "branch":
          g = branchGeometry(Math.round(p.x * 7 + p.z * 3) + 5);
          g.scale(p.s, p.s, p.s);
          g.rotateY(p.yaw);
          g.translate(p.x, footprintLow(env, p.x, p.z, 1.2) - 0.03 - baseY, p.z);
          break;
        case "outcrop":
          g = outcropGeometry(Math.round(p.x * 5 + p.z));
          g.scale(p.s, p.s, p.s);
          g.rotateY(p.yaw);
          g.translate(p.x, footprintLow(env, p.x, p.z, 1.4 * p.s) - 0.1 * p.s - baseY, p.z);
          paint(g, "#3d3b37", 0.1, 3);
          break;
        default:
          continue;
      }
      if (!g.attributes.color) paint(g, "#777066");
      parts.push(g);
    }
    if (parts.length) {
      const geo = merge(parts);
      geo.computeBoundingSphere();
      const outcrop = a.kind === "outcrop";
      let mat = std({ color: "#ffffff", vertexColors: true, roughness: a.kind === "hull-section" ? 0.75 : 0.9, metalness: 0 });
      if (outcrop) mat = weather(mat, { scale: 3, rust: 0, silt: 0.8, growth: 0, bump: 2, seed: 4 });
      else if (a.kind === "branch") mat = weather(mat, { scale: 12, rust: 0, silt: 0.5, growth: 0.4, bump: 1.5, seed: 6 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
    }
    if (chainLinks && chainLinks.length) {
      const im = new THREE.InstancedMesh(linkGeometry(), std({ color: "#3a2a1f", roughness: 0.85, metalness: 0.2 }), chainLinks.length);
      im.name = "asset-mooring-chain-links";
      chainLinks.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = true;
      root.add(im);
    }
  }

  // river piers: riprap thrown around the footing against scour, as one instanced set
  const pier = env.assets.find((a) => a.kind === "bridge-pier");
  if (pier?.at) {
    const rand = mulberry32(77);
    const mats: THREE.Matrix4[] = [];
    for (const [px, pz, , s] of pier.at) {
      const r0 = (pier.solidRadius ?? 1) * s;
      for (let k = 0; k < 36; k++) {
        const a = rand() * Math.PI * 2;
        const r = r0 * 1.6 + rand() * 1.4;
        const x = px + Math.cos(a) * r;
        const z = pz + Math.sin(a) * r;
        const sc = 0.35 + rand() * 0.4;
        q.setFromEuler(new THREE.Euler(rand(), rand() * 6, rand()));
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, bed(x, z) - 0.12 * sc - baseY, z), q.clone(), new THREE.Vector3(sc, sc * 0.8, sc)));
      }
    }
    const im = new THREE.InstancedMesh(rockGeometry(91, 1), weather(std({ color: "#6b665b", roughness: 0.9 }), { scale: 6, rust: 0, silt: 0.4, growth: 0.3, bump: 1.5, seed: 2 }), mats.length);
    im.name = "asset-riprap";
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = true;
    im.receiveShadow = true;
    root.add(im);
    // the deck the piers carry, above the water
    const zs = pier.at.map((p) => p[1]);
    const ez = env.geometry.extentM[1];
    const deck = paint(new THREE.BoxGeometry(4.2, 0.8, ez + 2).translate(pier.at[0][0], 4.4 - baseY, (Math.min(...zs) + Math.max(...zs)) / 2), "#85807a", 0.05, 9);
    const dm = new THREE.Mesh(deck, std({ color: "#ffffff", vertexColors: true, roughness: 0.9 }));
    dm.name = "asset-bridge-deck";
    dm.castShadow = true;
    root.add(dm);
  }
  return root;
}
