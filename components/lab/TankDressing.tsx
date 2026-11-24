"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CAMERA, TANK, gantryToWorld } from "@/lib/sim/constants";
import { ENVIRONMENTS, type EnvironmentId } from "@/lib/sim/environments";
import { mulberry32 } from "@/lib/sim/rng";
import { DEFAULT_OBJECTS } from "@/lib/sim/scenario";
import { useSimStore } from "@/lib/sim/store";
import { useDeferredDispose } from "@/components/field/common";
import { sandSurfaceY } from "./Aquarium";
import { std } from "./util";
import { weather } from "./weathering";

/*
 * Environments are recreated inside the gantry's tank, the way a test tank emulates field conditions: the water
 * (components/lab/water.ts), the floor substrate (Aquarium.tsx sand material), the lighting, and the small props
 * a site would have, scaled to the tank and kept in its margins, clear of the survey area and the test objects.
 * Everything here is procedural.
 */

/* ---------- GPU resource lifetime ---------- */

/**
 * Frees a dressing's geometries and materials once it leaves the tank for good. Each switch builds a new dressing, so
 * without this every visit to an environment left its buffers on the GPU. Deferred and StrictMode-safe
 * (components/field/common.ts useDeferredDispose).
 */
function useDisposeAll(resources: Record<string, { dispose(): void }>) {
  useDeferredDispose(resources, () => {
    for (const r of Object.values(resources)) r.dispose();
  });
}

const NOTHING: Record<string, { dispose(): void }> = {};

/* ---------- tank geometry the dressing must respect ---------- */

const INNER_X = TANK.length / 2 - TANK.glass; // 0.59
const INNER_Z = TANK.width / 2 - TANK.glass; // 0.29
const SURVEY_X = 0.5; // gantry travel 100 cm, centred
const SURVEY_Z = 0.2; // gantry travel 40 cm, centred

/* ---------- deterministic noise for geometry ---------- */

function hash3(i: number, j: number, k: number, seed: number) {
  const v = Math.sin(i * 127.1 + j * 311.7 + k * 74.7 + seed * 19.19) * 43758.5453;
  return v - Math.floor(v);
}
function noise2(x: number, z: number, seed: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(x - xi);
  const v = s(z - zi);
  const a = hash3(xi, zi, 0, seed);
  const b = hash3(xi + 1, zi, 0, seed);
  const c = hash3(xi, zi + 1, 0, seed);
  const d = hash3(xi + 1, zi + 1, 0, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm2(x: number, z: number, seed: number, octaves = 4) {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    v += a * noise2(x * f, z * f, seed + i * 13);
    a *= 0.5;
    f *= 2.03;
  }
  return v;
}

/** A pebble, cobble or nodule: a lumpy icosahedron with a flattened base. Unit size. */
function stoneGeometry(seed: number, detail = 2) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 0.75 + 0.45 * fbm2(x * 1.7 + y * 0.9, z * 1.7 - y * 0.7, seed);
    p.setXYZ(i, x * k, Math.max(y * k * 0.62, -0.25), z * k);
  }
  g.computeVertexNormals();
  return g;
}

/* ---------- substrate scatter ---------- */

interface Scatter {
  count: number;
  minSize: number;
  maxSize: number;
  colors: [string, string];
  /** fraction of each stone's size sunk into the floor */
  sink: number;
  /** stones per area inside the survey area relative to the margins (substrate texture, kept small there) */
  surveyShare: number;
  /** largest stone allowed inside the survey area, m */
  surveyMaxSize: number;
  silt: number;
  growth: number;
}

type DressedId = Exclude<EnvironmentId, "tank">;

/** River gravel and cobbles, harbour shell grit, abyssal manganese nodules. */
const SCATTER: Record<DressedId, Scatter> = {
  harbor: { count: 140, minSize: 0.003, maxSize: 0.01, colors: ["#2c2a24", "#77705f"], sink: 0.4, surveyShare: 0.35, surveyMaxSize: 0.006, silt: 0.55, growth: 0.5 },
  river: { count: 900, minSize: 0.004, maxSize: 0.024, colors: ["#4d483f", "#93887a"], sink: 0.3, surveyShare: 0.45, surveyMaxSize: 0.009, silt: 0.45, growth: 0.25 },
  deepsea: { count: 700, minSize: 0.005, maxSize: 0.02, colors: ["#1d1915", "#3b322a"], sink: 0.45, surveyShare: 0.5, surveyMaxSize: 0.012, silt: 0.25, growth: 0 },
};

/** Clearance kept around the default test objects so no stone sits on or against them. */
const OBJECT_CLEARANCE = 0.035;
const objectFootprints = DEFAULT_OBJECTS.map((o) => {
  const [x, z] = gantryToWorld(o.x, o.y);
  return { x, z, r: Math.hypot(o.halfExtents[0], o.halfExtents[2]) + OBJECT_CLEARANCE };
});

function buildScatter(env: DressedId) {
  const s = SCATTER[env];
  const rand = mulberry32(env.length * 977 + 5);
  const geo = stoneGeometry(env === "deepsea" ? 61 : 62);
  const mat = weather(std({ color: "#ffffff", roughness: 0.9 }), { scale: 120, rust: 0, silt: s.silt, growth: s.growth, bump: 1.6, seed: 30 });
  const mesh = new THREE.InstancedMesh(geo, mat, s.count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const c = new THREE.Color();
  const lo = new THREE.Color(s.colors[0]);
  const hi = new THREE.Color(s.colors[1]);
  let n = 0;
  for (let tries = 0; n < s.count && tries < s.count * 20; tries++) {
    const x = (rand() * 2 - 1) * (INNER_X - 0.012);
    const z = (rand() * 2 - 1) * (INNER_Z - 0.012);
    const inSurvey = Math.abs(x) < SURVEY_X && Math.abs(z) < SURVEY_Z;
    if (inSurvey && rand() > s.surveyShare) continue;
    if (objectFootprints.some((f) => Math.hypot(x - f.x, z - f.z) < f.r)) continue;
    // patches: stones gather where low-frequency noise is high, as gravel does in a bed
    if (fbm2(x * 6, z * 6, 77) < 0.38 + 0.18 * rand()) continue;
    const max = inSurvey ? Math.min(s.maxSize, s.surveyMaxSize) : s.maxSize;
    const size = s.minSize + (max - s.minSize) * rand() ** 2;
    e.set(rand() * 0.6, rand() * Math.PI * 2, rand() * 0.6);
    q.setFromEuler(e);
    const y = sandSurfaceY(x, z) + size * (0.62 - s.sink - 0.25);
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(size * (0.8 + 0.4 * rand()), size, size * (0.8 + 0.4 * rand())));
    mesh.setMatrixAt(n, m);
    mesh.setColorAt(n, c.lerpColors(lo, hi, rand()));
    n++;
  }
  mesh.count = n;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* ---------- props, scaled to the tank, in its margins ---------- */

const CONCRETE = "#8b887e";
const WATER_TOP = TANK.waterLevel;

/** Rounded-rectangle pier or piling section standing on the floor and breaking the surface. */
function pierGeometry(hx: number, hz: number, height: number) {
  const r = Math.min(hx, hz);
  const s = new THREE.Shape();
  s.moveTo(-hx + r, -hz);
  s.lineTo(hx - r, -hz);
  s.absarc(hx - r, -hz + r, r, -Math.PI / 2, 0, false);
  s.lineTo(hx, hz - r);
  s.absarc(hx - r, hz - r, r, 0, Math.PI / 2, false);
  s.lineTo(-hx + r, hz);
  s.absarc(-hx + r, hz - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-hx, -hz + r);
  s.absarc(-hx + r, -hz + r, r, Math.PI, (3 * Math.PI) / 2, false);
  return new THREE.ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: 12, steps: 8 }).rotateX(-Math.PI / 2);
}

function HarborProps() {
  const p = useMemo(() => {
    const concrete = weather(std({ color: CONCRETE, roughness: 0.92 }), { scale: 90, rust: 0, silt: 0.25, growth: 0.95, bump: 2.2, seed: 40 });
    const rubber = weather(std({ color: "#171717", roughness: 0.85 }), { scale: 160, rust: 0, silt: 0.6, growth: 0.5, bump: 1.2, seed: 41 });
    const chainMat = weather(std({ color: "#3d3f42", metalness: 0.5, roughness: 0.6 }), { scale: 260, rust: 0.9, silt: 0.4, growth: 0.35, bump: 1.4, seed: 42 });
    // two scale pilings in opposite corners, from the floor through the surface, fouled below the waterline
    const piling = new THREE.CylinderGeometry(0.032, 0.034, WATER_TOP + 0.06, 32, 12).translate(0, (WATER_TOP + 0.06) / 2 - 0.012, 0);
    // a small tyre lying half sunk in the mud, tread grooves on the outer face
    const tyre = new THREE.TorusGeometry(0.032, 0.012, 16, 40);
    const tp = tyre.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i);
      const y = tp.getY(i);
      const z = tp.getZ(i);
      const r = Math.hypot(x, y);
      const outer = Math.max(0, (r - 0.032) / 0.012);
      const groove = Math.sin(Math.atan2(y, x) * 48) > 0.55 ? 1 - 0.1 * outer : 1;
      tp.setXYZ(i, x * (1 + (groove - 1) * 0.3), y * (1 + (groove - 1) * 0.3), z * (0.85 + 0.15 * groove));
    }
    tyre.computeVertexNormals();
    // a mooring chain along the -z margin, alternating links
    const links: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 26; i++) {
      const t = i / 25;
      const x = -0.42 + 0.5 * t;
      const z = -0.245 + 0.012 * Math.sin(t * 7);
      const link = new THREE.TorusGeometry(0.0062, 0.0017, 6, 14).scale(1.45, 1, 1);
      link.rotateX(i % 2 ? Math.PI / 2 : 0);
      link.rotateY(-Math.atan2(0.084 * Math.cos(t * 7), 0.5));
      link.translate(x, sandSurfaceY(x, z) + (i % 2 ? 0.002 : 0.0055), z);
      links.push(link.toNonIndexed());
    }
    const chain = mergeGeometries(links, false);
    for (const l of links) l.dispose();
    return { concrete, rubber, chainMat, piling, tyre, chain };
  }, []);
  useDisposeAll(p);
  return (
    <group>
      <mesh geometry={p.piling} material={p.concrete} position={[0.545, 0, -0.245]} castShadow receiveShadow />
      <mesh geometry={p.piling} material={p.concrete} position={[-0.545, 0, 0.245]} castShadow receiveShadow />
      <mesh geometry={p.tyre} material={p.rubber} position={[0.545, sandSurfaceY(0.545, 0.215) + 0.002, 0.215]} rotation={[Math.PI / 2 - 0.15, 0, 0.4]} castShadow receiveShadow />
      <mesh geometry={p.chain} material={p.chainMat} castShadow receiveShadow />
    </group>
  );
}

function RiverProps() {
  const p = useMemo(() => {
    const concrete = weather(std({ color: CONCRETE, roughness: 0.92 }), { scale: 90, rust: 0, silt: 0.45, growth: 0.55, bump: 2.2, seed: 50 });
    const wood = weather(std({ color: "#3f3226", roughness: 0.9 }), { scale: 140, rust: 0, silt: 0.5, growth: 0.5, bump: 2, seed: 52 });
    // scale bridge pier with rounded noses in one corner, breaking the surface
    const pier = pierGeometry(0.035, 0.025, WATER_TOP + 0.06).translate(0, -0.012, 0);
    // a waterlogged branch along the +z margin
    const branch = mergeGeometries(
      [
        new THREE.CylinderGeometry(0.0075, 0.009, 0.3, 12, 6).rotateZ(Math.PI / 2),
        new THREE.CylinderGeometry(0.0025, 0.0035, 0.06, 8).rotateZ(0.9).translate(0.06, 0.018, 0.004),
        new THREE.CylinderGeometry(0.002, 0.003, 0.05, 8).rotateX(-0.8).translate(-0.07, 0.012, -0.012),
      ].map((g) => g.toNonIndexed()),
      false,
    );
    branch.computeVertexNormals();
    return { concrete, wood, pier, branch };
  }, []);
  useDisposeAll(p);
  return (
    <group>
      <mesh geometry={p.pier} material={p.concrete} position={[0.545, 0, -0.24]} castShadow receiveShadow />
      <mesh geometry={p.branch} material={p.wood} position={[-0.2, sandSurfaceY(-0.2, 0.245) + 0.005, 0.245]} rotation={[0.04, 0.08, 0.03]} castShadow receiveShadow />
    </group>
  );
}

function DeepProps() {
  const p = useMemo(() => {
    const rock = weather(std({ color: "#4c4640", roughness: 0.95 }), { scale: 60, rust: 0, silt: 0.55, growth: 0, bump: 2.4, seed: 60 });
    return { rock, outcrop: stoneGeometry(63, 4) };
  }, []);
  useDisposeAll(p);
  return (
    <group>
      <mesh geometry={p.outcrop} material={p.rock} position={[-0.545, 0.004, -0.235]} scale={[0.04, 0.035, 0.045]} rotation={[0, 0.7, 0]} castShadow receiveShadow />
      <mesh geometry={p.outcrop} material={p.rock} position={[0.548, 0.003, 0.24]} scale={[0.035, 0.028, 0.04]} rotation={[0, 2.1, 0]} castShadow receiveShadow />
    </group>
  );
}

/** Everything an environment places in the tank besides the water and the floor material. */
export function TankDressing({ env }: { env: EnvironmentId }) {
  const scatter = useMemo(() => (env === "tank" ? null : buildScatter(env)), [env]);
  const scatterResources = useMemo(() => (scatter ? { geometry: scatter.geometry, material: scatter.material as THREE.Material, instances: scatter } : NOTHING), [scatter]);
  useDisposeAll(scatterResources);
  return (
    <group name={`tank-dressing-${env}`}>
      {scatter && <primitive object={scatter} />}
      {env === "harbor" && <HarborProps />}
      {env === "river" && <RiverProps />}
      {env === "deepsea" && <DeepProps />}
    </group>
  );
}

/* ---------- lights ---------- */

/**
 * Overview fill for the lamp-lit deep: with the lab lights off the main 3D view would be black outside the lamp
 * pool. It is switched on for the main pass only (components/lab/FeedRenderer.tsx turns it off for the camera
 * feed), so the feed and detection see only the rig's lamps, and the UI labels the overview as lit for visibility.
 */
export const overviewFill = new THREE.HemisphereLight("#9fb6c8", "#2a2a2a", 0);
export const OVERVIEW_FILL_INTENSITY = 0.6;

/**
 * Two lamps beside the lens, aimed straight down; the only light in the deep.
 * Mounted in every environment (components/lab/Scene.tsx) and dark outside the deep: three.js builds every shader
 * for the scene's light count, so adding lights on an environment switch would recompile every material (a stall of
 * many seconds). A constant light set keeps all shaders valid across switches.
 */
export function RigLamps() {
  const left = useRef<THREE.SpotLight>(null);
  const right = useRef<THREE.SpotLight>(null);
  const heads = useRef<THREE.Group>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const headMat = useMemo(() => std({ color: "#1c1f22", metalness: 0.6, roughness: 0.35 }), []);
  const lensMat = useMemo(() => new THREE.MeshBasicMaterial({ color: "#fff6e0" }), []);
  useFrame(() => {
    const { engine } = useSimStore.getState();
    const pose = engine.renderPose();
    const [wx, wz] = gantryToWorld(pose.x, pose.y);
    const lampEnv = ENVIRONMENTS[engine.scenario.environment].light === "lamp";
    const power = lampEnv ? engine.scenario.lighting : 0;
    target.position.set(wx, 0, wz);
    target.updateMatrixWorld();
    for (const [l, dx] of [
      [left.current, -0.05],
      [right.current, 0.05],
    ] as const) {
      if (!l) continue;
      l.position.set(wx + dx, CAMERA.lensHeight + 0.03, wz);
      l.intensity = 0.36 * power;
    }
    if (heads.current) {
      heads.current.position.set(wx, CAMERA.lensHeight + 0.03, wz);
      heads.current.visible = lampEnv;
    }
    lensMat.color.setScalar(0.25 + 0.75 * power);
  });
  return (
    <>
      <primitive object={target} />
      <spotLight ref={left} target={target} angle={0.75} penumbra={0.6} decay={2} distance={0} color="#fff3dc" />
      <spotLight ref={right} target={target} angle={0.75} penumbra={0.6} decay={2} distance={0} color="#fff3dc" />
      <group ref={heads}>
        {[-0.05, 0.05].map((dx) => (
          <group key={dx} position={[dx, 0, 0]}>
            <mesh material={headMat}>
              <cylinderGeometry args={[0.012, 0.012, 0.03, 20]} />
            </mesh>
            <mesh material={lensMat} position={[0, -0.0155, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.0105, 20]} />
            </mesh>
          </group>
        ))}
      </group>
    </>
  );
}

/**
 * One mesh per shader variant the dressings use (weathered, instanced with per-instance colour). Compiling these
 * once while the app is idle makes the first switch to any environment as fast as later ones.
 */
export function buildDressingWarmup(): THREE.Scene {
  const s = new THREE.Scene();
  const g = new THREE.BoxGeometry(0.01, 0.01, 0.01);
  const w = { scale: 10, rust: 0.5, silt: 0.5, growth: 0.5, bump: 1, seed: 0 };
  s.add(new THREE.Mesh(g, weather(std({ color: "#ffffff" }), w)));
  const im = new THREE.InstancedMesh(g, weather(std({ color: "#ffffff" }), w), 1);
  im.setColorAt(0, new THREE.Color());
  s.add(im);
  return s;
}
