"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { gantryToWorld } from "@/lib/sim/constants";
import { mulberry32 } from "@/lib/sim/rng";
import { useSimStore } from "@/lib/sim/store";
import type { TestObject } from "@/lib/sim/types";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { HIGHLIGHT_COLOR, mergeBoxes, setEmissive, std } from "./util";
import { weather } from "./weathering";

const SELECT_EMISSIVE = new THREE.Color("#f2a93b");

/* ---------- models ----------
 * Bench-scale objects as they look after weeks on a tank floor. Geometry is built here; surface ageing (paint loss,
 * rust, silt on top faces, growth film, relief) is the shared shader in ./weathering.ts; caustics and the water
 * itself come from ./water.ts. Dimensions follow docs/BLUEPRINT.md 2.6 and the halfExtents in lib/sim/scenario.ts.
 */

const RUST_LO = new THREE.Color("#4a2516");
const RUST_HI = new THREE.Color("#7d4224");
const RUST_DEEP = new THREE.Color("#2e1a10");

/** Deterministic 3D value noise for geometry displacement (the shader has its own copy for surfaces). */
function noise3(x: number, y: number, z: number, seed: number) {
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
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(h(xi, yi, zi), h(xi + 1, yi, zi), u), lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    lerp(lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

function fbm3(x: number, y: number, z: number, seed: number, octaves = 4) {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    v += a * noise3(x * f, y * f, z * f, seed + i * 7);
    a *= 0.5;
    f *= 2.07;
  }
  return v;
}

const nonIndexed = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts.map(nonIndexed), false);

/** Half beam of the lozenge hull at x along its length (parabolic, 0.09 beam over 0.22). */
const beamAt = (x: number) => 0.045 * Math.max(0, 1 - (x / 0.11) ** 2);

/** Hull section outline: stern two thirds of a lozenge with a torn forward edge. */
function hullShape(inset: number) {
  const pts: THREE.Vector2[] = [];
  const x0 = -0.11 + inset;
  const x1 = 0.037;
  const n = 22;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    pts.push(new THREE.Vector2(x, Math.max(0.002, beamAt(x) - inset)));
  }
  // torn edge: plate ripped unevenly
  const w = beamAt(x1) - inset;
  const tear = [0.012, -0.002, 0.009, 0.016, 0.001, 0.011, -0.003, 0.013, 0.004];
  tear.forEach((dx, i) => pts.push(new THREE.Vector2(x1 + dx, w * (0.8 - (1.6 * (i + 1)) / (tear.length + 1)))));
  for (let i = n; i >= 0; i--) {
    const x = x0 + ((x1 - x0) * i) / n;
    pts.push(new THREE.Vector2(x, -Math.max(0.002, beamAt(x) - inset)));
  }
  return new THREE.Shape(pts);
}

/** Per-vertex rust colour: blotchy at plate scale, darker toward the keel where it sat longest in silt. */
function paintRust(geo: THREE.BufferGeometry, rand: () => number) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.lerpColors(RUST_LO, RUST_HI, 0.35 + 0.4 * fbm3(pos.getX(i) * 60, pos.getY(i) * 60, pos.getZ(i) * 60, 3) + 0.15 * rand());
    if (pos.getY(i) < -0.033) c.lerp(RUST_DEEP, 0.7);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Low sand mound the wreck has settled into: a polar grid with a cosine profile and a ragged rim. */
function buildMound(radius: number, peak: number, seed: number) {
  const rings = 14;
  const segs = 72;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rings; r++)
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const t = r / rings;
      const rr = t * radius * (1 + 0.14 * (fbm3(Math.cos(a) * 2, Math.sin(a) * 2, 0, seed) - 0.5));
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const profile = 0.5 + 0.5 * Math.cos(Math.PI * t);
      pos.push(x, peak * profile * (0.8 + 0.4 * fbm3(x * 40, 0, z * 40, seed + 1)), z);
    }
  for (let r = 0; r < rings; r++)
    for (let k = 0; k < segs; k++) {
      const a = r * (segs + 1) + k;
      const b = a + segs + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function buildWreck() {
  const rand = mulberry32(11);
  const depth = 0.055;
  // hull plating: outer outline minus an inset copy, so the section is open on top
  const shell = hullShape(0);
  shell.holes.push(hullShape(0.004));
  const hull = new THREE.ExtrudeGeometry(shell, { depth, bevelEnabled: false, curveSegments: 4, steps: 6 });
  hull.rotateX(Math.PI / 2); // extrude +z -> -y (hangs below the deck line)
  hull.scale(1, 0.9, 1);
  // plating sags and buckles a little; keyed on position so shared vertices move together
  const hp = hull.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i);
    const y = hp.getY(i);
    const z = hp.getZ(i);
    hp.setZ(i, z + Math.sign(z) * (fbm3(x * 45, y * 45, z * 45, 5) - 0.5) * 0.004);
  }
  const floor = new THREE.ExtrudeGeometry(hullShape(0.004), { depth: 0.004, bevelEnabled: false, curveSegments: 4 });
  floor.rotateX(Math.PI / 2);
  floor.translate(0, -depth * 0.9 + 0.004, 0);
  const bulkhead = new THREE.BoxGeometry(0.004, 0.05, 0.08).rotateY(0.3).translate(0.017, -0.024, 0);
  // transverse frames inside the hull; forward of the bulkhead they stand proud and broken
  const frameParts: Parameters<typeof mergeBoxes>[0] = [];
  for (let x = -0.094; x <= 0.034; x += 0.016) {
    const half = beamAt(x) - 0.007;
    if (half < 0.008) continue;
    const broken = x > 0.02;
    const h = broken ? 0.04 + rand() * 0.02 : 0.046;
    for (const sz of [-1, 1])
      frameParts.push({ size: [0.003, h, 0.004], at: [x, -0.047 + h / 2, sz * half], rot: [broken ? sz * (0.15 + rand() * 0.2) : 0, 0, broken ? rand() * 0.2 : 0] });
    frameParts.push({ size: [0.003, 0.004, half * 2], at: [x, -0.044, 0] });
  }
  // stern gear: rudder blade, shaft and a three-bladed propeller
  frameParts.push({ size: [0.022, 0.03, 0.003], at: [-0.121, -0.029, 0], rot: [0, 0.35, 0] });
  frameParts.push({ size: [0.016, 0.003, 0.003], at: [-0.104, -0.038, 0] });
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI * 2) / 3 + 0.3;
    frameParts.push({ size: [0.002, 0.014, 0.007], at: [-0.112, -0.038 + Math.cos(a) * 0.008, Math.sin(a) * 0.008], rot: [a, 0.4, 0] });
  }
  const hullMerged = merge([hull, floor, bulkhead, mergeBoxes(frameParts)]);
  hullMerged.computeVertexNormals();
  paintRust(hullMerged, rand);

  // deck plate aft with deckhouse and roof lip, hatch coaming, bollards, funnel stump
  const deck = merge([
    mergeBoxes([
      { size: [0.1, 0.004, 0.084], at: [-0.06, 0.002, 0] },
      { size: [0.05, 0.03, 0.045], at: [-0.075, 0.019, 0] },
      { size: [0.054, 0.003, 0.049], at: [-0.075, 0.0355, 0] },
      { size: [0.028, 0.008, 0.022], at: [-0.025, 0.008, 0.012] },
      { size: [0.006, 0.01, 0.006], at: [-0.035, 0.009, -0.03] },
      { size: [0.006, 0.01, 0.006], at: [-0.02, 0.009, 0.03] },
      { size: [0.006, 0.01, 0.006], at: [-0.095, 0.009, -0.028] },
    ]),
    new THREE.CylinderGeometry(0.0065, 0.0075, 0.016, 14, 1, true).rotateZ(0.25).translate(-0.072, 0.044, 0.004),
  ]);
  paintRust(deck, rand);

  // portholes, an open door and the hatch opening: dark recesses
  const holes = merge([
    ...[-0.09, -0.075, -0.06].flatMap((x) => [-1, 1].map((sz) => new THREE.CylinderGeometry(0.0032, 0.0032, 0.0012, 12).rotateX(Math.PI / 2).translate(x, 0.024, sz * 0.0226))),
    new THREE.BoxGeometry(0.0012, 0.018, 0.012).translate(-0.0496, 0.013, -0.006),
    new THREE.BoxGeometry(0.022, 0.0012, 0.016).translate(-0.025, 0.0122, 0.012),
  ]);

  // rust plate fragments scattered ahead of the break, lying on the sand
  const fragParts: Parameters<typeof mergeBoxes>[0] = [];
  for (let i = 0; i < 9; i++) {
    const a = rand() * Math.PI * 2;
    const r = 0.045 + rand() * 0.075;
    fragParts.push({
      size: [0.01 + rand() * 0.016, 0.0018, 0.007 + rand() * 0.012],
      at: [0.05 + Math.cos(a) * r * 0.7, 0.001 + rand() * 0.002, Math.sin(a) * r],
      rot: [rand() * 0.3, rand() * Math.PI, rand() * 0.3],
    });
  }
  const frags = paintRust(mergeBoxes(fragParts), rand);

  // the mast broke off and lies half sunk beside the hull, crosstree still attached
  const mast = merge([
    new THREE.CylinderGeometry(0.0026, 0.0032, 0.13, 10).rotateZ(Math.PI / 2),
    new THREE.CylinderGeometry(0.0016, 0.0016, 0.034, 8).rotateX(Math.PI / 2).translate(0.04, 0, 0),
  ]);
  mast.rotateY(0.45).translate(0.01, 0, 0.082);
  paintRust(mast, rand);

  return { hull: hullMerged, deck, holes, frags, mast, mound: buildMound(0.2, 0.024, 17) };
}

function Shipwreck({ m }: { m: Mats }) {
  const geos = useMemo(() => buildWreck(), []);
  return (
    <group>
      {/* mound, fragments and mast sit level on the sand; the hull lists 18 degrees. The mound rim sits below the
          lowest sand ripple so it tucks under the tank floor */}
      <mesh geometry={geos.mound} material={m.sand} position={[0, -0.0365, 0]} receiveShadow userData={{ gtOccluder: true }} />
      <mesh geometry={geos.frags} material={m.rustV} position={[0, -0.023, 0]} castShadow receiveShadow />
      <mesh geometry={geos.mast} material={m.rustV} position={[0, -0.023, 0]} castShadow receiveShadow />
      <group rotation={[(18 * Math.PI) / 180, 0, 0]}>
        <mesh geometry={geos.hull} material={m.rustV} castShadow receiveShadow />
        <mesh geometry={geos.deck} material={m.rustV} castShadow receiveShadow />
        <mesh geometry={geos.holes} material={m.hole} />
      </group>
    </group>
  );
}

const MINE_R = 0.04;
/** Contact horns on the upper hemisphere: one on the crown and four at 35 degrees elevation. */
const HORN_DIRS: Array<[number, number, number]> = [
  [0, 1, 0],
  ...[45, 135, 225, 315].map((deg): [number, number, number] => {
    const a = (deg * Math.PI) / 180;
    const e = (35 * Math.PI) / 180;
    return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
  }),
];

function alignTo(g: THREE.BufferGeometry, dir: THREE.Vector3, dist: number) {
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  return g.translate(dir.x * dist, dir.y * dist, dir.z * dist);
}

function buildMine() {
  const body: THREE.BufferGeometry[] = [];
  const caps: THREE.BufferGeometry[] = [];
  for (const d of HORN_DIRS) {
    const dir = new THREE.Vector3(...d).normalize();
    body.push(alignTo(new THREE.CylinderGeometry(0.0042, 0.0062, 0.016, 14), dir, MINE_R + 0.006));
    // horn bases sit on a welded boss
    body.push(alignTo(new THREE.CylinderGeometry(0.0075, 0.0085, 0.003, 16), dir, MINE_R - 0.0005));
    caps.push(alignTo(new THREE.SphereGeometry(0.0047, 12, 8), dir, MINE_R + 0.0145));
  }
  // equatorial flange where the two hemispheres are bolted together
  body.push(new THREE.TorusGeometry(MINE_R + 0.0008, 0.0026, 8, 48).rotateX(Math.PI / 2));
  // lifting eye on the crown, off to one side of the top horn
  body.push(new THREE.TorusGeometry(0.0055, 0.0013, 8, 20).translate(0.016, MINE_R - 0.002, 0));
  const bolts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    bolts.push(new THREE.CylinderGeometry(0.0017, 0.0017, 0.0028, 6).translate(Math.cos(a) * (MINE_R + 0.0015), 0.003, Math.sin(a) * (MINE_R + 0.0015)));
  }
  return { horns: merge(body), caps: merge(caps), bolts: merge(bolts) };
}

/** Stencilled plate: TRAINING TARGET / INERT, so nobody mistakes the prop. */
function labelTexture() {
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

function Mine({ m }: { m: Mats }) {
  const r = MINE_R;
  const bandR = Math.sqrt(r * r - 0.018 * 0.018);
  const geo = useMemo(() => buildMine(), []);
  const n = Math.SQRT1_2 * (r + 0.0006);
  return (
    <group>
      <mesh material={m.matteBlack} castShadow receiveShadow>
        <sphereGeometry args={[r, 48, 32]} />
      </mesh>
      <mesh geometry={geo.horns} material={m.matteBlack} castShadow />
      <mesh geometry={geo.caps} material={m.lead} castShadow />
      <mesh geometry={geo.bolts} material={m.steelDark} />
      <mesh material={m.orange} position={[0, 0.018, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[bandR + 0.0002, 0.0026, 8, 48]} />
      </mesh>
      <mesh material={m.orange} position={[0, -0.018, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[bandR + 0.0002, 0.0026, 8, 48]} />
      </mesh>
      <mesh material={m.label} position={[n, -0.006, n]} rotation={[0, Math.PI / 4, 0]}>
        <planeGeometry args={[0.024, 0.012]} />
      </mesh>
    </group>
  );
}

function buildPipe() {
  const R = 0.015;
  const r = 0.0125;
  const L = 0.12;
  // flange: a disc with the bore and six bolt holes, extruded
  const flange = new THREE.Shape();
  flange.absarc(0, 0, 0.024, 0, Math.PI * 2, false);
  const bore = new THREE.Path();
  bore.absarc(0, 0, r, 0, Math.PI * 2, true);
  flange.holes.push(bore);
  const boltAt: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.26;
    boltAt.push([Math.cos(a) * 0.0195, Math.sin(a) * 0.0195]);
    const h = new THREE.Path();
    h.absarc(boltAt[i][0], boltAt[i][1], 0.0019, 0, Math.PI * 2, true);
    flange.holes.push(h);
  }
  const flangeGeo = new THREE.ExtrudeGeometry(flange, { depth: 0.005, bevelEnabled: true, bevelThickness: 0.0006, bevelSize: 0.0006, bevelSegments: 1, curveSegments: 24 });
  flangeGeo.rotateX(-Math.PI / 2).translate(0, L / 2 - 0.006, 0);
  // three bolts still in their holes, hex heads proud of the flange
  const bolts = boltAt.filter((_, i) => i % 2 === 0).map(([x, z]) => new THREE.CylinderGeometry(0.0028, 0.0028, 0.003, 6).translate(x, L / 2 + 0.0005, -z));
  const outer = new THREE.CylinderGeometry(R, R, L, 32, 6, true);
  // dents and ovality: the section was dropped, not machined
  const op = outer.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < op.count; i++) {
    const x = op.getX(i);
    const y = op.getY(i);
    const z = op.getZ(i);
    const k = 1 - 0.18 * Math.max(0, fbm3(x * 80, y * 30, z * 80, 9) - 0.45);
    op.setXYZ(i, x * k, y, z * k * 0.97);
  }
  const ends = [L / 2, -L / 2].map((y) => new THREE.RingGeometry(r, R, 32).rotateX(y > 0 ? -Math.PI / 2 : Math.PI / 2).translate(0, y, 0));
  const steel = merge([outer, flangeGeo, ...ends, ...bolts]);
  steel.computeVertexNormals();
  return { steel, inner: new THREE.CylinderGeometry(r, r, L, 28, 1, true) };
}

function Pipe({ m }: { m: Mats }) {
  const geo = useMemo(() => buildPipe(), []);
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      <mesh geometry={geo.steel} material={m.steel} castShadow receiveShadow />
      <mesh geometry={geo.inner} material={m.bore} />
    </group>
  );
}

function buildBracket() {
  // L profile with a real bend radius, extruded across its 3 cm width
  const t = 0.004;
  const ri = 0.004;
  const bx = 0.032;
  const s = new THREE.Shape();
  s.moveTo(-0.04, 0);
  s.lineTo(bx, 0);
  s.absarc(bx, ri + t, ri + t, -Math.PI / 2, 0, false);
  s.lineTo(bx + ri + t, 0.045);
  s.lineTo(bx + ri, 0.045);
  s.lineTo(bx + ri, ri + t);
  s.absarc(bx, ri + t, ri, 0, -Math.PI / 2, true);
  s.lineTo(-0.04, t);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.0005, bevelSize: 0.0005, bevelSegments: 1, curveSegments: 10, steps: 4 });
  // origin near the object centre (halfExtents y = 0.012) so burial sinks the base leg into the ripples, not under them
  g.translate(0, -0.008, -0.015);
  // the upright leg was bent open and twisted by an impact
  const p = g.attributes.position as THREE.BufferAttribute;
  const px = bx + ri;
  const py = ri + t - 0.008;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    if (y <= py) continue;
    const a = 0.32 + 0.12 * (z / 0.015) * ((y - py) / 0.04);
    const dx = x - px;
    const dy = y - py;
    p.setXY(i, px + dx * Math.cos(a) + dy * Math.sin(a), py - dx * Math.sin(a) + dy * Math.cos(a));
  }
  g.computeVertexNormals();
  // bolt holes: dark recesses on the base leg
  const holes = merge([-0.026, 0].map((x) => new THREE.CylinderGeometry(0.0032, 0.0032, 0.0012, 14).translate(x, t + 0.0003 - 0.008, 0)));
  return { body: g, holes };
}

function Bracket({ m }: { m: Mats }) {
  const geo = useMemo(() => buildBracket(), []);
  return (
    <group>
      <mesh geometry={geo.body} material={m.steelDark} castShadow receiveShadow />
      <mesh geometry={geo.holes} material={m.hole} />
    </group>
  );
}

function buildRocks() {
  const rand = mulberry32(42);
  const parts: THREE.BufferGeometry[] = [];
  const spots: Array<[number, number, number, number]> = [
    [0, 0.0, 0, 0.026],
    [0.052, -0.004, 0.018, 0.02],
    [-0.045, -0.005, -0.021, 0.018],
    [0.018, -0.006, -0.042, 0.014],
    [-0.018, -0.004, 0.039, 0.013],
    [0.034, -0.007, -0.012, 0.008],
    [-0.03, -0.007, 0.012, 0.007],
    [0.006, -0.007, 0.03, 0.006],
  ];
  const tint = new THREE.Color();
  for (const [x, y, z, r] of spots) {
    const g = new THREE.IcosahedronGeometry(r, 4);
    const p = g.attributes.position as THREE.BufferAttribute;
    const ys = 0.55 + rand() * 0.2;
    const seed = rand() * 100;
    const stretch = 0.85 + rand() * 0.3;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i);
      const vy = p.getY(i);
      const vz = p.getZ(i);
      // weathered stone: broad lumps, ridged fractures and fine roughness, flattened where it rests on the sand
      const ridge = 1 - Math.abs(2 * noise3((vx / r) * 2.4, (vy / r) * 2.4, (vz / r) * 2.4, seed + 3) - 1);
      const k = 0.74 + 0.34 * fbm3((vx / r) * 1.6, (vy / r) * 1.6, (vz / r) * 1.6, seed, 5) + 0.07 * ridge * ridge;
      p.setXYZ(i, vx * k * stretch, Math.max(vy * ys * k, -r * 0.22), (vz * k) / stretch);
    }
    g.rotateY(rand() * Math.PI);
    // origin at the cluster centre (halfExtents y = 0.02): the stones bed into the sand rather than sit on it
    g.translate(x, y - 0.011, z);
    // each stone its own colour: dark basalt greys to warm sandstone browns
    tint.setHSL(0.06 + rand() * 0.05, 0.1 + rand() * 0.16, 0.13 + rand() * 0.13);
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) col.set([tint.r, tint.g, tint.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    parts.push(g);
  }
  const merged = merge(parts);
  merged.computeVertexNormals();
  return merged;
}

function Rocks({ m }: { m: Mats }) {
  const geo = useMemo(() => buildRocks(), []);
  return <mesh geometry={geo} material={m.rock} castShadow receiveShadow />;
}

/** A panel with a grid of rectangular holes, as moulded into a plastic crate. */
function gridPanel(w: number, h: number, cols: number, rows: number, frame: number, t: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -h / 2);
  s.lineTo(w / 2, -h / 2);
  s.lineTo(w / 2, h / 2);
  s.lineTo(-w / 2, h / 2);
  s.closePath();
  const cw = (w - 2 * frame) / cols;
  const ch = (h - 2 * frame) / rows;
  const rib = 0.0018;
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const x0 = -w / 2 + frame + i * cw + rib / 2;
      const y0 = -h / 2 + frame + j * ch + rib / 2;
      const hole = new THREE.Path();
      hole.moveTo(x0, y0);
      hole.lineTo(x0, y0 + ch - rib);
      hole.lineTo(x0 + cw - rib, y0 + ch - rib);
      hole.lineTo(x0 + cw - rib, y0);
      hole.closePath();
      s.holes.push(hole);
    }
  return new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: true, bevelThickness: 0.0004, bevelSize: 0.0004, bevelSegments: 1 }).translate(0, 0, -t / 2);
}

function buildCrate() {
  const W = 0.08;
  const D = 0.06;
  const H = 0.05;
  const t = 0.0025;
  const long = gridPanel(W, H, 7, 3, 0.006, t);
  const short = gridPanel(D, H, 5, 3, 0.006, t);
  const merged = merge([
    long.clone().translate(0, H / 2, D / 2 - t / 2),
    long.clone().translate(0, H / 2, -D / 2 + t / 2),
    short.clone().rotateY(Math.PI / 2).translate(W / 2 - t / 2, H / 2, 0),
    short.clone().rotateY(Math.PI / 2).translate(-W / 2 + t / 2, H / 2, 0),
    gridPanel(W, D, 7, 5, 0.004, t).rotateX(Math.PI / 2).translate(0, t / 2, 0),
    // rolled top rim
    mergeBoxes([
      { size: [W + 0.002, 0.004, 0.004], at: [0, H, D / 2 - 0.001] },
      { size: [W + 0.002, 0.004, 0.004], at: [0, H, -D / 2 + 0.001] },
      { size: [0.004, 0.004, D], at: [W / 2 - 0.001, H, 0] },
      { size: [0.004, 0.004, D], at: [-W / 2 + 0.001, H, 0] },
    ]),
  ]);
  merged.computeVertexNormals();
  // origin at the crate centre (halfExtents y = 0.025), settled with a slight tilt
  return merged.translate(0, -H / 2, 0).rotateX(0.06).rotateZ(-0.04);
}

function Crate({ m }: { m: Mats }) {
  const geo = useMemo(() => buildCrate(), []);
  return <mesh geometry={geo} material={m.crate} castShadow receiveShadow />;
}

/* ---------- materials, shared across objects but owned by this component ---------- */

interface Mats {
  rustV: THREE.MeshStandardMaterial;
  sand: THREE.MeshStandardMaterial;
  matteBlack: THREE.MeshStandardMaterial;
  orange: THREE.MeshStandardMaterial;
  lead: THREE.MeshStandardMaterial;
  label: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  steelDark: THREE.MeshStandardMaterial;
  bore: THREE.MeshStandardMaterial;
  hole: THREE.MeshStandardMaterial;
  rock: THREE.MeshStandardMaterial;
  crate: THREE.MeshStandardMaterial;
}

/** Same base as the tank sand in Aquarium.tsx (#8f7d5c times its tint), so the wreck's mound reads as the floor. */
const MOUND_SAND = new THREE.Color("#8f7d5c").multiply(new THREE.Color(0.86, 0.9, 0.9));

function makeMats(): Mats {
  return {
    rustV: weather(std({ color: "#ffffff", vertexColors: true, roughness: 0.9, metalness: 0.2, side: THREE.DoubleSide }), {
      scale: 55,
      rust: 0.62,
      silt: 0.32,
      growth: 0.3,
      bump: 1.6,
      seed: 1,
    }),
    sand: weather(std({ color: MOUND_SAND, roughness: 0.97 }), { scale: 260, rust: 0, silt: 0, growth: 0.08, bump: 0.8, seed: 2 }),
    matteBlack: weather(std({ color: "#1d1e1f", roughness: 0.7, metalness: 0.1 }), { scale: 70, rust: 0.2, silt: 0.6, growth: 0.25, bump: 0.8, seed: 3 }),
    orange: weather(std({ color: "#c9622b", roughness: 0.55 }), { scale: 70, rust: 0.12, silt: 0.45, growth: 0.2, bump: 0.6, seed: 4 }),
    lead: weather(std({ color: "#8d918f", roughness: 0.55, metalness: 0.5 }), { scale: 120, rust: 0, silt: 0.4, growth: 0.2, bump: 0.6, seed: 5 }),
    label: std({ map: labelTexture(), roughness: 0.6 }),
    steel: weather(std({ color: "#6f7377", metalness: 0.6, roughness: 0.45 }), { scale: 80, rust: 0.6, silt: 0.55, growth: 0.4, bump: 1.4, seed: 6 }),
    steelDark: weather(std({ color: "#4a4e53", metalness: 0.55, roughness: 0.55 }), { scale: 90, rust: 0.7, silt: 0.5, growth: 0.3, bump: 1.4, seed: 7 }),
    bore: weather(std({ color: "#2b2219", roughness: 0.95, side: THREE.BackSide }), { scale: 80, rust: 0.9, silt: 0, growth: 0.3, bump: 1, seed: 8 }),
    hole: std({ color: "#0b0907", roughness: 1 }),
    rock: weather(std({ color: "#ffffff", vertexColors: true, roughness: 0.95 }), { scale: 70, rust: 0, silt: 0.3, growth: 0.4, bump: 2.2, seed: 9 }),
    // faded HDPE: sun-bleached before it sank, then filmed over
    crate: weather(std({ color: "#33536f", roughness: 0.6 }), { scale: 120, rust: 0, silt: 0.75, growth: 0.6, bump: 0.6, seed: 10 }),
  };
}

function Model({ o, m }: { o: TestObject; m: Mats }) {
  if (o.type === "SHIPWRECK") return <Shipwreck m={m} />;
  if (o.type === "MINE") return <Mine m={m} />;
  if (o.id.includes("pipe")) return <Pipe m={m} />;
  if (o.id.includes("bracket")) return <Bracket m={m} />;
  if (o.id.includes("rock")) return <Rocks m={m} />;
  return <Crate m={m} />;
}

type Tint = "none" | "selected" | "highlight";

/** Each object owns its material set so selection or highlight can tint just that object. */
function ObjectGroup({ o, tint }: { o: TestObject; tint: Tint }) {
  const mats = useMemo(() => makeMats(), []);
  const ref = useRef<THREE.Group>(null);
  useEffect(() => {
    setEmissive(Object.values(mats), tint === "selected" ? SELECT_EMISSIVE : tint === "highlight" ? HIGHLIGHT_COLOR : null, tint === "selected" ? 0.025 : 0.18);
  }, [tint, mats]);

  // Positions are mutated in place by engine.moveObject, so follow the engine each frame.
  useFrame(() => {
    const g = ref.current;
    const live = useSimStore.getState().engine.scenario.objects.find((obj) => obj.id === o.id) ?? o;
    if (!g) return;
    const [wx, wz] = gantryToWorld(live.x, live.y);
    g.position.set(wx, live.z - live.burial * live.halfExtents[1], wz);
    g.rotation.y = (live.rotation * Math.PI) / 180;
  });

  return (
    <group
      ref={ref}
      name={o.id}
      // ground-truth tags for synthetic dataset capture (components/capture/core.ts)
      userData={{ gtId: o.id, gtClass: o.type }}
      onClick={(e) => {
        e.stopPropagation();
        useSimStore.getState().selectObject(o.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "";
      }}
    >
      <Model o={o} m={mats} />
    </group>
  );
}

export function TestObjects() {
  const objects = useSimStore((s) => s.scenario.objects);
  const selected = useSimStore((s) => s.selectedObjectId);
  const highlighted = useSimStore((s) => s.highlight === "test-objects");
  return (
    <group>
      {objects.map((o) => (
        <ObjectGroup key={o.id} o={o} tint={selected === o.id ? "selected" : highlighted ? "highlight" : "none"} />
      ))}
    </group>
  );
}
