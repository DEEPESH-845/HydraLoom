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

const SELECT_EMISSIVE = new THREE.Color("#f2a93b");

/* ---------- models ---------- */

const RUST_LO = new THREE.Color("#5a3020");
const RUST_HI = new THREE.Color("#8b4d2a");
const RUST_DEEP = new THREE.Color("#3a2416");

/** Half beam of the lozenge hull at x along its length (parabolic, 0.09 beam over 0.22). */
const beamAt = (x: number) => 0.045 * Math.max(0, 1 - (x / 0.11) ** 2);

/** Hull section outline: stern two thirds of a lozenge with a torn forward edge. */
function hullShape(inset: number) {
  const pts: THREE.Vector2[] = [];
  const x0 = -0.11 + inset;
  const x1 = 0.037;
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    pts.push(new THREE.Vector2(x, Math.max(0.002, beamAt(x) - inset)));
  }
  // torn edge zigzag
  const w = beamAt(x1) - inset;
  pts.push(new THREE.Vector2(x1 + 0.012, w * 0.55), new THREE.Vector2(x1 - 0.004, w * 0.15), new THREE.Vector2(x1 + 0.014, -w * 0.3), new THREE.Vector2(x1 + 0.002, -w * 0.75));
  for (let i = n; i >= 0; i--) {
    const x = x0 + ((x1 - x0) * i) / n;
    pts.push(new THREE.Vector2(x, -Math.max(0.002, beamAt(x) - inset)));
  }
  return new THREE.Shape(pts);
}

function paintRust(geo: THREE.BufferGeometry, rand: () => number) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.lerpColors(RUST_LO, RUST_HI, rand());
    if (pos.getY(i) < -0.033) c.lerp(RUST_DEEP, 0.75);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

function Shipwreck({ m }: { m: Mats }) {
  const geos = useMemo(() => {
    const rand = mulberry32(11);
    const depth = 0.055;
    // hull plating: outer outline minus an inset copy, so the section is open on top
    const shell = hullShape(0);
    shell.holes.push(hullShape(0.006));
    const hull = new THREE.ExtrudeGeometry(shell, { depth, bevelEnabled: false, curveSegments: 4 });
    hull.rotateX(Math.PI / 2); // extrude +z -> -y (hangs below the deck line)
    hull.scale(1, 0.9, 1);
    const floor = new THREE.ExtrudeGeometry(hullShape(0.005), { depth: 0.004, bevelEnabled: false, curveSegments: 4 });
    floor.rotateX(Math.PI / 2);
    floor.translate(0, -depth * 0.9 + 0.004, 0);
    const bulkhead = new THREE.BoxGeometry(0.004, 0.05, 0.09).rotateY(0.3).translate(0.017, -0.024, 0).toNonIndexed();
    const hullMerged = mergeGeometries([hull, floor, bulkhead], false);
    hullMerged.computeVertexNormals();
    paintRust(hullMerged, rand);
    // deck plate aft with deckhouse, hatch coaming, bollards
    const deck = mergeBoxes([
      { size: [0.1, 0.004, 0.084], at: [-0.06, 0.002, 0] },
      { size: [0.05, 0.03, 0.045], at: [-0.075, 0.019, 0] },
      { size: [0.028, 0.008, 0.022], at: [-0.025, 0.008, 0.012] },
      { size: [0.006, 0.01, 0.006], at: [-0.035, 0.009, -0.03] },
      { size: [0.006, 0.01, 0.006], at: [-0.02, 0.009, 0.03] },
      { size: [0.006, 0.01, 0.006], at: [-0.095, 0.009, -0.028] },
    ]);
    paintRust(deck, rand);
    // rust plate fragments scattered ahead of the break, lying on the sand
    const fragParts: Parameters<typeof mergeBoxes>[0] = [];
    for (let i = 0; i < 7; i++) {
      const a = rand() * Math.PI * 2;
      const r = 0.045 + rand() * 0.075;
      fragParts.push({
        size: [0.012 + rand() * 0.014, 0.002, 0.008 + rand() * 0.012],
        at: [0.05 + Math.cos(a) * r * 0.7, 0.001, Math.sin(a) * r],
        rot: [0, rand() * Math.PI, 0],
      });
    }
    const frags = paintRust(mergeBoxes(fragParts), rand);
    const skirt = new THREE.CylinderGeometry(0.16, 0.19, 0.012, 24);
    return { hull: hullMerged, deck, frags, skirt };
  }, []);
  return (
    <group>
      {/* skirt and fragments sit level on the sand; the hull lists 18 degrees */}
      <mesh geometry={geos.skirt} material={m.skirt} position={[0, -0.028, 0]} receiveShadow />
      <mesh geometry={geos.frags} material={m.rustV} position={[0, -0.023, 0]} />
      <group rotation={[(18 * Math.PI) / 180, 0, 0]}>
        <mesh geometry={geos.hull} material={m.rustV} castShadow receiveShadow />
        <mesh geometry={geos.deck} material={m.rustV} castShadow />
      </group>
    </group>
  );
}

const MINE_R = 0.04;
const HORN_DIRS: Array<[number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function buildHorns() {
  const up = new THREE.Vector3(0, 1, 0);
  const parts = HORN_DIRS.map((d) => {
    const dir = new THREE.Vector3(...d);
    const g = new THREE.CylinderGeometry(0.005, 0.0065, 0.02, 10);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
    return g.translate(dir.x * (MINE_R + 0.009), dir.y * (MINE_R + 0.009), dir.z * (MINE_R + 0.009));
  });
  return mergeGeometries(parts, false);
}

function Mine({ m }: { m: Mats }) {
  const r = MINE_R;
  const bandR = Math.sqrt(r * r - 0.018 * 0.018);
  const hornGeo = useMemo(() => buildHorns(), []);
  return (
    <group>
      <mesh material={m.matteBlack} castShadow receiveShadow>
        <sphereGeometry args={[r, 28, 20]} />
      </mesh>
      <mesh geometry={hornGeo} material={m.matteBlack} />
      <mesh material={m.orange} position={[0, 0.018, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[bandR, 0.0035, 8, 32]} />
      </mesh>
      <mesh material={m.orange} position={[0, -0.018, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[bandR, 0.0035, 8, 32]} />
      </mesh>
      {/* label plate: TRAINING TARGET */}
      <mesh material={m.label} position={[0.028, 0, 0.028]} rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[0.02, 0.01, 0.001]} />
      </mesh>
    </group>
  );
}

function Pipe({ m }: { m: Mats }) {
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      <mesh material={m.steel} castShadow receiveShadow>
        <cylinderGeometry args={[0.015, 0.015, 0.12, 18, 1, true]} />
      </mesh>
      <mesh material={m.steelDark} position={[0, 0.055, 0]}>
        <cylinderGeometry args={[0.024, 0.024, 0.006, 18]} />
      </mesh>
      <mesh material={m.steelDark} position={[0, -0.06, 0]}>
        <ringGeometry args={[0.012, 0.015, 18]} />
      </mesh>
    </group>
  );
}

function Bracket({ m }: { m: Mats }) {
  return (
    <group>
      <mesh material={m.steelDark} position={[0, 0.002, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.08, 0.004, 0.03]} />
      </mesh>
      <mesh material={m.steelDark} position={[0.036, 0.018, 0]} rotation={[0.18, 0, 0.25]} castShadow>
        <boxGeometry args={[0.004, 0.04, 0.03]} />
      </mesh>
    </group>
  );
}

function Rocks({ m }: { m: Mats }) {
  const geo = useMemo(() => {
    const rand = mulberry32(42);
    const parts: THREE.BufferGeometry[] = [];
    const spots: Array<[number, number, number, number]> = [
      [0, 0.0, 0, 0.026],
      [0.052, -0.004, 0.018, 0.02],
      [-0.045, -0.005, -0.021, 0.018],
      [0.018, -0.006, -0.042, 0.014],
      [-0.018, -0.004, 0.039, 0.013],
    ];
    for (const [x, y, z, r] of spots) {
      const g = new THREE.DodecahedronGeometry(r, 2);
      const p = g.attributes.position as THREE.BufferAttribute;
      const ys = 0.55 + rand() * 0.15;
      const seed = rand() * 100;
      for (let i = 0; i < p.count; i++) {
        // jitter keyed on the vertex position so the non-indexed faces stay watertight
        const h = Math.sin(p.getX(i) * 12.9898 + p.getY(i) * 78.233 + p.getZ(i) * 37.719 + seed) * 43758.5453;
        const k = 0.92 + 0.16 * (h - Math.floor(h));
        p.setXYZ(i, p.getX(i) * k, p.getY(i) * ys * k, p.getZ(i) * k);
      }
      g.translate(x, y - 0.004, z);
      parts.push(g);
    }
    const merged = mergeGeometries(parts, false);
    merged.computeVertexNormals();
    return merged;
  }, []);
  return <mesh geometry={geo} material={m.rock} castShadow receiveShadow />;
}

function Crate({ m }: { m: Mats }) {
  const geo = useMemo(() => {
    const parts: Parameters<typeof mergeBoxes>[0] = [{ size: [0.08, 0.004, 0.06], at: [0, 0.002, 0] }];
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) parts.push({ size: [0.005, 0.05, 0.005], at: [sx * 0.0375, 0.025, sz * 0.0275] });
    for (const y of [0.012, 0.026, 0.04]) {
      for (const sz of [-1, 1]) parts.push({ size: [0.08, 0.008, 0.003], at: [0, y, sz * 0.0285] });
      for (const sx of [-1, 1]) parts.push({ size: [0.003, 0.008, 0.06], at: [sx * 0.0385, y, 0] });
    }
    return mergeBoxes(parts);
  }, []);
  return <mesh geometry={geo} material={m.crate} castShadow receiveShadow />;
}

/* ---------- materials, shared across objects but owned by this component ---------- */

interface Mats {
  rustV: THREE.MeshStandardMaterial;
  skirt: THREE.MeshStandardMaterial;
  matteBlack: THREE.MeshStandardMaterial;
  orange: THREE.MeshStandardMaterial;
  label: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  steelDark: THREE.MeshStandardMaterial;
  rock: THREE.MeshStandardMaterial;
  crate: THREE.MeshStandardMaterial;
}

function makeMats(): Mats {
  return {
    rustV: std({ color: "#ffffff", vertexColors: true, roughness: 0.92, metalness: 0.15, side: THREE.DoubleSide }),
    skirt: std({ color: "#948266", roughness: 0.98 }),
    matteBlack: std({ color: "#1c1c1c", roughness: 0.85 }),
    orange: std({ color: "#c9622b", roughness: 0.6 }),
    label: std({ color: "#c8ccd0", roughness: 0.5 }),
    steel: std({ color: "#767a7e", metalness: 0.6, roughness: 0.5 }),
    steelDark: std({ color: "#4a4e53", metalness: 0.55, roughness: 0.6 }),
    rock: std({ color: "#5f5a52", roughness: 1 }),
    crate: std({ color: "#4a6a86", roughness: 0.7 }),
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
