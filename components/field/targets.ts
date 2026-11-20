"use client";

import * as THREE from "three";
import { weather } from "@/components/lab/weathering";
import { mulberry32 } from "@/lib/sim/rng";
import type { TargetInstance } from "@/lib/field/detection";
import type { TargetSpec } from "@/lib/world/schema";
import { fbm3, merge, paint, std } from "./common";

/*
 * Ground-truth targets at real scale. Every model is built inside its declared half extents (x length, y height,
 * z width) around its origin, which is the box centre the analytical detector projects (lib/field/detection.ts
 * targetCorners), so the rendered object and the analytic box agree. The root group of each target carries
 * userData.gtId and userData.gtClass; the dataset capture reads those to colour its instance-id pass.
 * Mines are inert training targets and are labelled as such on the casing.
 */

const RUST_LO = "#3f2216";
const RUST_HI = "#7a4124";

function rustColors(g: THREE.BufferGeometry, seed: number, scale: number, base?: THREE.ColorRepresentation): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const lo = new THREE.Color(RUST_LO);
  const hi = new THREE.Color(RUST_HI);
  const b = base !== undefined ? new THREE.Color(base) : null;
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const n = fbm3(p.getX(i) * scale, p.getY(i) * scale, p.getZ(i) * scale, seed);
    c.lerpColors(lo, hi, 0.25 + 0.6 * n);
    if (b) c.lerp(b, Math.max(0, Math.min(1, (n - 0.35) * 2.5)));
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/** Open steel hull of a small coaster, broken off forward, listing, with a fallen mast. Fits [hx, hy, hz]. */
function wreck(hx: number, hy: number, hz: number, seed: number): THREE.Group {
  const rand = mulberry32(seed);
  const g = new THREE.Group();
  const nu = 48;
  const nv = 16;
  const x0 = -hx * 0.98;
  const x1 = hx * 0.72; // the bow is gone: torn edge here
  const keel = -hy * 0.98;
  const deck = hy * 0.15;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu;
    const x = x0 + (x1 - x0) * u;
    const xn = x / hx;
    const half = hz * 0.92 * Math.max(0.15, 1 - Math.pow(Math.max(0, xn - 0.1) / 0.95, 2)) * (xn < -0.75 ? 0.7 + 0.3 * ((xn + 1) / 0.25) : 1);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const a = (v - 0.5) * Math.PI;
      const s = Math.sin(a);
      const k = Math.pow(Math.cos(a), 0.4);
      let y = deck - (deck - keel) * k;
      // plating sags and buckles; the torn forward edge is ragged
      const n = fbm3(x * 2.5, y * 2.5, s * 2, seed);
      let z = half * Math.sign(s) * Math.pow(Math.abs(s), 0.3) * (1 + 0.04 * (n - 0.5));
      if (i >= nu - 2) {
        y -= (i - nu + 3) * 0.06 * hy * rand();
        z *= 0.97;
      }
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
  const parts: THREE.BufferGeometry[] = [rustColors(hull, seed, 1.2, "#3b3f3c")];
  // transverse frames, the aft deck and a deckhouse, a hatch coaming
  for (let x = x0 + 0.4; x < x1 - 0.2; x += 0.5) {
    const xn = x / hx;
    const half = hz * 0.85 * Math.max(0.15, 1 - Math.pow(Math.max(0, xn - 0.1) / 0.95, 2));
    const fh = x > x1 - 1.2 ? (0.5 + 0.4 * rand()) * (deck - keel) : (deck - keel) * 0.9;
    for (const sz of [-1, 1]) parts.push(rustColors(new THREE.BoxGeometry(0.06, fh, 0.08).translate(x, keel + fh / 2 + 0.05, sz * (half - 0.05)), seed + 1, 2));
  }
  parts.push(rustColors(new THREE.BoxGeometry(hx * 0.62, 0.05, hz * 1.6).translate(-hx * 0.62, deck - 0.02, 0), seed + 2, 1.5, "#4a4a44"));
  const houseH = hy - deck - 0.02;
  parts.push(rustColors(new THREE.BoxGeometry(hx * 0.34, houseH, hz * 1.0).translate(-hx * 0.66, deck + houseH / 2, 0), seed + 3, 1.6, "#55574f"));
  parts.push(rustColors(new THREE.BoxGeometry(hx * 0.28, houseH * 0.35, hz * 0.6).translate(-hx * 0.1, deck + houseH * 0.17, 0), seed + 4, 1.6));
  // portholes as dark recesses on the deckhouse
  const holes: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++)
    for (const sz of [-1, 1]) holes.push(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 10).rotateX(Math.PI / 2).translate(-hx * 0.78 + k * hx * 0.11, deck + houseH * 0.6, sz * hz * 0.5));
  // rudder and a three-bladed propeller at the stern
  parts.push(rustColors(new THREE.BoxGeometry(0.06, (deck - keel) * 0.6, 0.5).translate(x0 - 0.02, keel + (deck - keel) * 0.35, 0).rotateY(0.3), seed + 5, 2));
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI * 2) / 3;
    parts.push(rustColors(new THREE.BoxGeometry(0.05, 0.32, 0.16).rotateX(a).translate(x0 + 0.35, keel + 0.35 + Math.cos(a) * 0.17, Math.sin(a) * 0.17), seed + 6, 3));
  }
  // the mast lies fallen across the deck edge
  parts.push(rustColors(new THREE.CylinderGeometry(0.05, 0.07, hx * 1.1, 10).rotateZ(Math.PI / 2).rotateY(0.35).translate(hx * 0.05, deck + 0.05, hz * 0.45), seed + 7, 2));
  const hullGeo = merge(parts);
  hullGeo.computeVertexNormals();
  const mat = weather(std({ color: "#ffffff", vertexColors: true, roughness: 0.85, metalness: 0.15, side: THREE.DoubleSide }), {
    scale: 2.2,
    rust: 0.35,
    silt: 0.6,
    growth: 0.5,
    bump: 3,
    seed: seed % 11,
  });
  const mesh = new THREE.Mesh(hullGeo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // listing 12 degrees to port, settled in the seabed
  const list = new THREE.Group();
  list.rotation.x = -0.21;
  list.scale.set(1, 0.96, 0.96);
  list.add(mesh);
  const hm = new THREE.Mesh(merge(holes), std({ color: "#0c0d0d", roughness: 1 }));
  list.add(hm);
  g.add(list);
  return g;
}

/** Inert training mine: a horned sphere with orange bands and a TRAINING TARGET / INERT plate. */
function mine(hx: number, hy: number, hz: number, seed: number, label: THREE.Texture): THREE.Group {
  const R = Math.min(hx, hy, hz) * 0.74;
  const g = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [new THREE.SphereGeometry(R, 40, 28)];
  const dirs: THREE.Vector3[] = [new THREE.Vector3(0, 1, 0)];
  for (const deg of [45, 135, 225, 315]) {
    const a = (deg * Math.PI) / 180;
    const e = (30 * Math.PI) / 180;
    dirs.push(new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)));
  }
  const capParts: THREE.BufferGeometry[] = [];
  for (const d of dirs) {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    const horn = new THREE.CylinderGeometry(R * 0.07, R * 0.1, R * 0.26, 12).applyQuaternion(q);
    const at = d.clone().multiplyScalar(R * 1.1);
    parts.push(horn.translate(at.x, at.y, at.z));
    const cap = new THREE.SphereGeometry(R * 0.075, 10, 8);
    const c = d.clone().multiplyScalar(R * 1.24);
    capParts.push(cap.translate(c.x, c.y, c.z));
  }
  parts.push(new THREE.TorusGeometry(R * 1.01, R * 0.04, 8, 48).rotateX(Math.PI / 2));
  parts.push(new THREE.TorusGeometry(R * 0.12, R * 0.025, 8, 16).translate(R * 0.35, R * 0.92, 0));
  const body = new THREE.Mesh(
    merge(parts),
    weather(std({ color: "#1e2022", roughness: 0.7, metalness: 0.2 }), { scale: 6, rust: 0.18, silt: 0.55, growth: 0.35, bump: 2, seed: seed % 7 }),
  );
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  g.add(new THREE.Mesh(merge(capParts), std({ color: "#5d5f60", roughness: 0.5, metalness: 0.4 })));
  const bandMat = weather(std({ color: "#b8642a", roughness: 0.7 }), { scale: 6, rust: 0, silt: 0.4, growth: 0.3, bump: 1, seed: 3 });
  for (const y of [0.42, -0.42]) {
    const r = Math.sqrt(1 - y * y) * R;
    const band = new THREE.Mesh(new THREE.TorusGeometry(r * 1.005, R * 0.035, 8, 48).rotateX(Math.PI / 2).translate(0, y * R, 0), bandMat);
    g.add(band);
  }
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(R * 0.7, R * 0.35), std({ map: label, roughness: 0.8 }));
  const n = new THREE.Vector3(1, -0.1, 1).normalize();
  plate.position.copy(n.clone().multiplyScalar(R * 1.012));
  plate.lookAt(plate.position.clone().add(n));
  g.add(plate);
  return g;
}

/** Wooden cargo crate, planked, filling its box exactly. */
function crate(hx: number, hy: number, hz: number, seed: number): THREE.Group {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [paint(new THREE.BoxGeometry(hx * 1.94, hy * 1.94, hz * 1.94), "#3a2f22")];
  const plank = 0.12;
  // planks on the long faces and the top, with gaps, each its own tone
  for (const sz of [-1, 1])
    for (let y = -hy + plank / 2; y < hy; y += plank + 0.015)
      parts.push(paint(new THREE.BoxGeometry(hx * 2, plank, 0.022).translate(0, y, sz * (hz - 0.011)), "#6b5a40", 0.08, Math.floor(rand() * 1e6)));
  for (const sx of [-1, 1])
    for (let y = -hy + plank / 2; y < hy; y += plank + 0.015)
      parts.push(paint(new THREE.BoxGeometry(0.022, plank, hz * 2 - 0.05), "#665638", 0.08, Math.floor(rand() * 1e6)).translate(sx * (hx - 0.011), y, 0));
  for (let x = -hx + plank / 2; x < hx; x += plank + 0.015) parts.push(paint(new THREE.BoxGeometry(plank, 0.022, hz * 2 - 0.05), "#6f5d42", 0.08, Math.floor(rand() * 1e6)).translate(x, hy - 0.011, 0));
  // corner battens
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(paint(new THREE.BoxGeometry(0.06, hy * 2, 0.06).translate(sx * (hx - 0.03), 0, sz * (hz - 0.03)), "#4f4230"));
  const m = new THREE.Mesh(merge(parts), weather(std({ color: "#ffffff", vertexColors: true, roughness: 0.9 }), { scale: 9, rust: 0, silt: 0.65, growth: 0.45, bump: 2, seed: seed % 9 }));
  m.castShadow = true;
  m.receiveShadow = true;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

/** Car tyre lying flat, tread grooves on the crown. */
function tire(hx: number, hy: number, hz: number, seed: number): THREE.Group {
  const r = hy * 0.98;
  const R = Math.min(hx, hz) - r;
  const geo = new THREE.TorusGeometry(R, r, 18, 56);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const a = Math.atan2(v.y, v.x);
    const ring = Math.hypot(v.x, v.y);
    // tread blocks on the outer crown only
    if (ring > R + r * 0.55) {
      const k = 1 - 0.035 * (Math.sin(a * 40) > 0.3 ? 1 : 0);
      v.x *= k;
      v.y *= k;
    }
    p.setXYZ(i, v.x, v.y, v.z * 0.92);
  }
  geo.computeVertexNormals();
  geo.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(geo, weather(std({ color: "#1b1b1c", roughness: 0.85 }), { scale: 8, rust: 0, silt: 0.6, growth: 0.4, bump: 2, seed: seed % 5 }));
  m.castShadow = true;
  m.receiveShadow = true;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

/** Concrete-coated pipeline section with field joints, anode bracelets and growth, along x. */
function pipe(hx: number, hy: number, hz: number, seed: number): THREE.Group {
  const R = Math.min(hy, hz);
  const L = hx * 2;
  const geo = new THREE.CylinderGeometry(R, R, L, 28, Math.max(8, Math.round(L * 3)), false);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const coat = new THREE.Color("#7b776d");
  const joint = new THREE.Color("#35332f");
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // field joints every 6 m: the concrete stops and the coated steel shows, slightly narrower
    const jp = (((y + L / 2) % 6) + 6) % 6;
    const isJoint = jp < 0.35;
    const k = isJoint ? 0.88 : 1 + 0.02 * (fbm3(x * 4, y * 2, z * 4, seed) - 0.5);
    p.setXYZ(i, x * k, y, z * k);
    c.copy(isJoint ? joint : coat).multiplyScalar(0.85 + 0.3 * fbm3(x * 3, y * 1.5, z * 3, seed + 1));
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [geo];
  for (let y = -L / 2 + 3; y < L / 2; y += 12) parts.push(paint(new THREE.CylinderGeometry(R * 1.04, R * 1.04, 0.25, 28).translate(0, y, 0), "#9a958a"));
  const all = merge(parts);
  all.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(all, weather(std({ color: "#ffffff", vertexColors: true, roughness: 0.92 }), { scale: 3, rust: 0, silt: 0.7, growth: 0.45, bump: 2, seed: seed % 13 }));
  m.castShadow = true;
  m.receiveShadow = true;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

/** 200 litre steel drum on its side, rolling hoops and rims, dented. */
function drum(hx: number, hy: number, hz: number, seed: number): THREE.Group {
  const R = Math.min(hy, hz) * 0.98;
  const L = hx * 2;
  const geo = new THREE.CylinderGeometry(R, R, L * 0.96, 32, 12, false);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const dent = 1 - 0.06 * Math.max(0, fbm3(x * 5, y * 5, z * 5, seed) - 0.55) * 4;
    p.setXYZ(i, x * dent, y, z * dent);
  }
  geo.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [geo];
  for (const y of [-L * 0.17, L * 0.17]) parts.push(new THREE.TorusGeometry(R, 0.018, 6, 32).rotateX(Math.PI / 2).translate(0, y, 0));
  for (const y of [-L * 0.48, L * 0.48]) parts.push(new THREE.TorusGeometry(R * 0.99, 0.02, 6, 32).rotateX(Math.PI / 2).translate(0, y, 0));
  const all = merge(parts);
  all.rotateZ(Math.PI / 2);
  rustColors(all, seed, 4, "#36506a");
  const m = new THREE.Mesh(all, weather(std({ color: "#ffffff", vertexColors: true, roughness: 0.75, metalness: 0.2 }), { scale: 7, rust: 0.4, silt: 0.55, growth: 0.3, bump: 2, seed: seed % 5 }));
  m.castShadow = true;
  m.receiveShadow = true;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

/** Stockless (Hall type) anchor lying on its side: shank, ring, crown and flukes. */
function anchor(hx: number, hy: number, hz: number, seed: number): THREE.Group {
  const parts: THREE.BufferGeometry[] = [];
  const t = hy * 0.55;
  parts.push(new THREE.BoxGeometry(hx * 1.5, t, t * 1.1).translate(hx * 0.2, -hy + t / 2 + 0.02, 0));
  parts.push(new THREE.TorusGeometry(hy * 0.6, t * 0.28, 8, 20).rotateX(Math.PI / 2).translate(hx * 0.95 - hy * 0.6, -hy + t * 0.4, 0));
  parts.push(new THREE.BoxGeometry(hx * 0.32, hy * 1.6, hz * 0.7).translate(-hx * 0.62, -hy * 0.2, 0));
  for (const sz of [-1, 1]) {
    const fl = new THREE.BufferGeometry();
    const x0 = -hx * 0.75;
    const v = [x0, -hy, sz * hz * 0.3, x0 + hx * 0.9, -hy + 0.02, sz * hz * 0.98, x0, -hy, sz * hz * 0.98, x0, hy * 0.2, sz * hz * 0.3, x0 + hx * 0.9, -hy + 0.1, sz * hz * 0.98, x0, hy * 0.2, sz * hz * 0.98];
    fl.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    fl.setIndex([0, 1, 2, 3, 5, 4, 0, 3, 1, 1, 3, 4, 2, 1, 4, 2, 4, 5, 0, 2, 5, 0, 5, 3]);
    fl.computeVertexNormals();
    parts.push(fl);
  }
  const all = merge(parts);
  all.computeVertexNormals();
  rustColors(all, seed, 3, "#2e2c2a");
  const m = new THREE.Mesh(all, weather(std({ color: "#ffffff", vertexColors: true, roughness: 0.85, metalness: 0.2, side: THREE.DoubleSide }), { scale: 5, rust: 0.5, silt: 0.6, growth: 0.35, bump: 2, seed: seed % 3 }));
  m.castShadow = true;
  m.receiveShadow = true;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

/** Stencilled plate: TRAINING TARGET / INERT, so nobody mistakes the training shape. */
export function inertLabelTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#d9d6c8";
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = "#1a1a1a";
    g.lineWidth = 8;
    g.strokeRect(6, 6, 244, 116);
    g.fillStyle = "#1a1a1a";
    g.textAlign = "center";
    g.font = "bold 34px monospace";
    g.fillText("TRAINING", 128, 50);
    g.fillText("TARGET", 128, 86);
    g.font = "bold 18px monospace";
    g.fillText("INERT", 128, 112);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Builds one target's model. The root's origin is the box centre; its transform is set from the engine per frame. */
export function buildTarget(spec: TargetSpec, label: THREE.Texture): THREE.Group {
  const [hx, hy, hz] = spec.halfExtents;
  const seed = [...spec.id].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  let g: THREE.Group;
  switch (spec.model) {
    case "wreck":
      g = wreck(hx, hy, hz, seed % 1000);
      break;
    case "mine":
      g = mine(hx, hy, hz, seed % 1000, label);
      break;
    case "crate":
      g = crate(hx, hy, hz, seed % 1000);
      break;
    case "tire":
      g = tire(hx, hy, hz, seed % 1000);
      break;
    case "pipe":
      g = pipe(hx, hy, hz, seed % 1000);
      break;
    case "drum":
      g = drum(hx, hy, hz, seed % 1000);
      break;
    case "anchor":
    default:
      g = anchor(hx, hy, hz, seed % 1000);
      break;
  }
  g.name = `target-${spec.id}`;
  g.userData.gtId = spec.id;
  g.userData.gtClass = spec.class;
  return g;
}

/** Places a target's model at the engine's instance: box centre (burial applied) and yaw about +Y. */
export function placeTarget(g: THREE.Object3D, t: TargetInstance, baseY: number): void {
  g.position.set(t.position[0], t.position[1] - t.burial * t.halfExtents[1] - baseY, t.position[2]);
  g.rotation.set(0, (t.yawDeg * Math.PI) / 180, 0);
}
