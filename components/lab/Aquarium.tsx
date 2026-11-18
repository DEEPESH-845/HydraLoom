"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { GANTRY, TANK } from "@/lib/sim/constants";
import { mulberry32 } from "@/lib/sim/rng";
import type { EnvironmentId } from "@/lib/sim/environments";
import { useSimStore } from "@/lib/sim/store";
import { mergeBoxes, std, useHighlight } from "./util";
import { weather } from "./weathering";
import { Particles } from "./Particles";
import { currentWater, waterTime } from "./water";

const L = TANK.length;
const W = TANK.width;
const G = TANK.glass;
const SD = TANK.sandDepth;
const WL = TANK.waterLevel;
const RIM = GANTRY.frameHeight;
const BOTTOM = -SD - G; // world Y of the glass underside
const WALL_H = RIM - BOTTOM;
const INNER_L = L - 2 * G;
const INNER_W = W - 2 * G;

const CLEAR_WATER = new THREE.Color("#2f8a93");
const SAND_TINT = new THREE.Color(0.86, 0.9, 0.9);

/* ---------- sand ---------- */

/**
 * Height of the rippled sand at a point inside the tank, without the per-vertex grain. Shared with the dressings
 * (TankDressing.tsx) so stones and props sit on the floor rather than above or inside it.
 */
export function sandSurfaceY(x: number, z: number): number {
  const ex = Math.min(1, (INNER_L / 2 - Math.abs(x)) / 0.06);
  const ez = Math.min(1, (INNER_W / 2 - Math.abs(z)) / 0.06);
  const fade = Math.max(0, Math.min(ex, ez));
  const r1 = 0.005 * Math.sin((x * 0.7 + z) * 9 + 0.4);
  const r2 = 0.004 * Math.sin((x - z * 0.5) * 13 + 1.1);
  return (r1 + r2) * fade;
}

function buildSandGeometry() {
  const geo = new THREE.PlaneGeometry(INNER_L, INNER_W, 120, 60);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rand = mulberry32(7);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // ripples fade out over the last 6 cm so the edge meets the sand box cleanly (sandSurfaceY)
    const grain = (rand() - 0.5) * 0.0012;
    pos.setY(i, sandSurfaceY(x, z) + grain);
  }
  geo.computeVertexNormals();
  return geo;
}

function makeSandMaterial() {
  const uniforms = {
    uTint: { value: SAND_TINT.clone() },
  };
  const mat = std({ color: "#8f7d5c", roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vSandXZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSandXZ = vec2(position.x, position.z);");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec2 vSandXZ;
        uniform vec3 uTint;`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        diffuseColor.rgb *= uTint;`,
      );
  };
  mat.customProgramCacheKey = () => "gantrylab-sand";
  // grain and micro-relief from the band-limited weathering noise: organic up close, no shimmer at distance
  weather(mat, { scale: 420, rust: 0, silt: 0, growth: 0.06, bump: 0.9, seed: 12 });
  return { mat, uniforms };
}

/* ---------- water surface ---------- */

const SURFACE_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vec3 p = position;
  float t = uTime;
  float h = 0.0015 * sin(p.x * 9.0 + t * 0.8) + 0.001 * sin(p.y * 13.0 - t * 0.6) + 0.0008 * sin((p.x + p.y) * 21.0 + t * 1.1);
  float dhx = 0.0135 * cos(p.x * 9.0 + t * 0.8) + 0.0168 * cos((p.x + p.y) * 21.0 + t * 1.1);
  float dhy = 0.013 * cos(p.y * 13.0 - t * 0.6) + 0.0168 * cos((p.x + p.y) * 21.0 + t * 1.1);
  p.z += h;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  // plane local +z is world +y, local x -> world x, local y -> world -z
  vNormalW = normalize(vec3(-dhx, 1.0, dhy));
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SURFACE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uLight;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vNormalW);
  float ndv = dot(n, v);
  vec3 col;
  float a;
  if (ndv < 0.0) {
    // underside: total internal reflection reads as a silvery mirror at grazing angles
    n = -n;
    float f = pow(1.0 - max(-ndv, 0.0), 2.0);
    col = mix(uColor, vec3(0.75, 0.82, 0.84), f * 0.8);
    a = uOpacity + f * 0.55;
  } else {
    float f = pow(1.0 - max(ndv, 0.0), 3.0);
    vec3 r = reflect(-v, n);
    // elongated ceiling-light reflections instead of one point highlight
    float lights = smoothstep(0.85, 0.99, r.y) * (0.5 + 0.5 * sin(r.x * 40.0)) * uLight * 0.35;
    col = mix(uColor, vec3(0.62, 0.72, 0.76), f * 0.45) + lights;
    a = uOpacity + f * 0.3 + lights * 0.6;
  }
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.9));
}`;

/* ---------- component ---------- */

const PARTICLES_MIN: [number, number, number] = [-INNER_L / 2 + 0.02, 0.02, -INNER_W / 2 + 0.02];

/**
 * The floor each environment lays in the tank: the base colour and the weathering of the substrate.
 * Lab sand; dark organic harbour mud with a growth film; warm river sand and gravel; pale abyssal ooze.
 */
const FLOOR: Record<EnvironmentId, { color: string; growth: number; bump: number; scale: number }> = {
  tank: { color: "#8f7d5c", growth: 0.06, bump: 0.9, scale: 420 },
  harbor: { color: "#4e493c", growth: 0.45, bump: 0.7, scale: 300 },
  river: { color: "#7d6c52", growth: 0.15, bump: 1.5, scale: 360 },
  deepsea: { color: "#b5ad99", growth: 0, bump: 0.5, scale: 260 },
};

/** A flume carries the river's current along the tank; the other waters are still. */
const DRIFT: Record<EnvironmentId, [number, number]> = { tank: [0, 0], harbor: [0.002, 0.001], river: [0.035, 0], deepsea: [0.001, 0] };
const PARTICLES_MAX: [number, number, number] = [INNER_L / 2 - 0.02, WL - 0.02, INNER_W / 2 - 0.02];

/** The glass tank, its floor and its water. `env` is the environment being emulated inside it. */
export function Aquarium({ env = "tank" }: { env?: EnvironmentId }) {
  const { glassMat, trimMat, meniscusMat, meniscus, surfaceMat, sand, seams, update } = useMemo(() => {
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: "#bcd8dd",
      transparent: true,
      opacity: 0.16,
      roughness: 0.05,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.6,
      depthWrite: false,
      fog: false,
    });
    const trimMat = std({ color: "#15181b", roughness: 0.7, fog: false });
    const meniscusMat = new THREE.MeshBasicMaterial({ color: "#dfe9ec", transparent: true, opacity: 0.55, fog: false, depthWrite: false });
    const meniscus = mergeBoxes([
      { size: [INNER_L, 0.002, 0.002], at: [0, WL, INNER_W / 2 - 0.001] },
      { size: [INNER_L, 0.002, 0.002], at: [0, WL, -INNER_W / 2 + 0.001] },
      { size: [0.002, 0.002, INNER_W], at: [INNER_L / 2 - 0.001, WL, 0] },
      { size: [0.002, 0.002, INNER_W], at: [-INNER_L / 2 + 0.001, WL, 0] },
    ]);
    const surfaceMat = new THREE.ShaderMaterial({
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: CLEAR_WATER.clone() },
        uOpacity: { value: 0.3 },
        uLight: { value: 0.8 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const seamH = WALL_H;
    const seamY = BOTTOM + seamH / 2;
    const cx = L / 2 - G / 2;
    const cz = W / 2 - G / 2;
    const seams = mergeBoxes([
      // vertical silicone seams
      { size: [0.014, seamH, 0.014], at: [cx, seamY, cz] },
      { size: [0.014, seamH, 0.014], at: [-cx, seamY, cz] },
      { size: [0.014, seamH, 0.014], at: [cx, seamY, -cz] },
      { size: [0.014, seamH, 0.014], at: [-cx, seamY, -cz] },
      // bottom seams
      { size: [L, 0.014, 0.014], at: [0, BOTTOM + G, cz] },
      { size: [L, 0.014, 0.014], at: [0, BOTTOM + G, -cz] },
      { size: [0.014, 0.014, W], at: [cx, BOTTOM + G, 0] },
      { size: [0.014, 0.014, W], at: [-cx, BOTTOM + G, 0] },
      // rim trim
      { size: [L + 0.02, 0.014, 0.024], at: [0, RIM, cz] },
      { size: [L + 0.02, 0.014, 0.024], at: [0, RIM, -cz] },
      { size: [0.024, 0.014, W + 0.02], at: [cx, RIM, 0] },
      { size: [0.024, 0.014, W + 0.02], at: [-cx, RIM, 0] },
    ]);
    const sand = { geo: buildSandGeometry(), ...makeSandMaterial() };
    /** Per-frame uniform and material updates, driven by the scenario. */
    // Water colour and attenuation come from the optics model (components/lab/water.ts), which also shades every
    // submerged material; these self-shaded parts read the same numbers.
    const surfaceColor = new THREE.Color();
    const update = (t: number, lighting: number, environment: EnvironmentId) => {
      const floor = FLOOR[environment];
      sand.mat.color.set(floor.color);
      const w = sand.mat.userData.weather as { uWGrowth: { value: number }; uWBump: { value: number }; uWScale: { value: number } };
      w.uWGrowth.value = floor.growth;
      w.uWBump.value = floor.bump;
      w.uWScale.value = floor.scale;
      const { optics } = currentWater;
      const [, cG] = optics.c;
      surfaceMat.uniforms.uTime.value = waterTime(t);
      // surface body colour is the hue of the deep-water reflectance; opacity is the haze of the top 10 cm
      const [r, g, b] = optics.rInf;
      const peak = Math.max(r, g, b, 1e-6);
      surfaceColor.setRGB((0.5 * r) / peak, (0.5 * g) / peak, (0.5 * b) / peak, THREE.LinearSRGBColorSpace);
      surfaceMat.uniforms.uColor.value.copy(surfaceColor);
      surfaceMat.uniforms.uOpacity.value = 0.1 + 0.5 * (1 - Math.exp(-cG * 0.1));
      surfaceMat.uniforms.uLight.value = lighting;
    };
    return {
      glassMat,
      trimMat,
      meniscusMat,
      meniscus,
      surfaceMat,
      sand,
      seams,
      update,
    };
  }, []);

  useHighlight("aquarium", [glassMat, trimMat]);

  useFrame((state) => {
    update(state.clock.elapsedTime, useSimStore.getState().engine.scenario.lighting, env);
  });

  return (
    <group name="aquarium">
      {/* sand: rippled surface plus a shallow layer visible through the glass */}
      <mesh geometry={sand.geo} material={sand.mat} receiveShadow />
      <mesh position={[0, -SD / 2 - 0.003, 0]} material={sand.mat}>
        <boxGeometry args={[INNER_L, SD - 0.006, INNER_W]} />
      </mesh>

      {/* the water body itself is not a mesh: components/lab/water.ts attenuates every view ray inside it */}
      <mesh position={[0, WL, 0]} rotation={[-Math.PI / 2, 0, 0]} material={surfaceMat} renderOrder={2}>
        <planeGeometry args={[INNER_L, INNER_W, 48, 24]} />
      </mesh>
      <Particles min={PARTICLES_MIN} max={PARTICLES_MAX} count={2400} drift={DRIFT[env]} />

      {/* glass: four walls and the bottom pane */}
      <group renderOrder={3}>
        <mesh position={[0, BOTTOM + WALL_H / 2, W / 2 - G / 2]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[L, WALL_H, G]} />
        </mesh>
        <mesh position={[0, BOTTOM + WALL_H / 2, -W / 2 + G / 2]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[L, WALL_H, G]} />
        </mesh>
        <mesh position={[L / 2 - G / 2, BOTTOM + WALL_H / 2, 0]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[G, WALL_H, W - 2 * G]} />
        </mesh>
        <mesh position={[-L / 2 + G / 2, BOTTOM + WALL_H / 2, 0]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[G, WALL_H, W - 2 * G]} />
        </mesh>
        <mesh position={[0, BOTTOM + G / 2, 0]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[L - 2 * G, G, W - 2 * G]} />
        </mesh>
      </group>

      {/* silicone seams, rim trim, meniscus line at the fill level */}
      <mesh geometry={seams} material={trimMat} />
      <mesh geometry={meniscus} material={meniscusMat} renderOrder={3} />
    </group>
  );
}
