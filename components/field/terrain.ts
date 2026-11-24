"use client";

import * as THREE from "three";
import { GLSL_NOISE } from "@/components/lab/weathering";
import type { EnvironmentDefinition, SeabedMaterial } from "@/lib/world/schema";
import { terrainHeight } from "@/lib/world/terrain";

/*
 * The seabed of a field site: one mesh sampled from lib/world/terrain.ts terrainHeight, the same pure function the
 * physics collides with and the targets are placed on, so what is drawn is what is simulated (to within the linear
 * interpolation between grid vertices, a few millimetres at these spacings).
 * Surface detail that is too fine for the grid (sand ripples, gravel, mottled mud, burrows) is procedural in the
 * shader, band-limited so it fades instead of sparkling at distance.
 */

/** Vertex budget of one terrain mesh. */
export const TERRAIN_VERTEX_BUDGET = 250_000;

export interface TerrainInfo {
  /** grid spacing, m */
  spacing: number;
  /** lowest and highest seabed point, world Y */
  minY: number;
  maxY: number;
  /** mean seabed height, world Y */
  meanY: number;
  /** the mesh's local origin in Y (geometry is stored relative to it for precision at abyssal depths) */
  baseY: number;
}

const KIND: Record<SeabedMaterial, number> = { sand: 0, mud: 1, gravel: 2, ooze: 3, "coral-sand": 4, silt: 5 };

/** Grid spacing for a site: 0.25 m where the budget allows, coarser for wide sites. */
export function terrainSpacing(env: EnvironmentDefinition): number {
  const [ex, ez] = env.geometry.extentM;
  return Math.max(0.25, Math.sqrt((ex * ez) / (TERRAIN_VERTEX_BUDGET * 0.96)));
}

/** Samples the seabed height field once, for the mesh and for placement. */
export function surveyTerrain(env: EnvironmentDefinition): TerrainInfo {
  const [ex, ez] = env.geometry.extentM;
  const spacing = terrainSpacing(env);
  let minY = Infinity;
  let maxY = -Infinity;
  let sum = 0;
  let n = 0;
  const step = Math.max(spacing, Math.max(ex, ez) / 120);
  for (let x = -ex / 2; x <= ex / 2 + 1e-6; x += step)
    for (let z = -ez / 2; z <= ez / 2 + 1e-6; z += step) {
      const y = terrainHeight(env.geometry.terrain, x, z);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sum += y;
      n++;
    }
  const meanY = sum / n;
  return { spacing, minY, maxY, meanY, baseY: Math.round(meanY) };
}

/** The seabed mesh geometry, local to (0, baseY, 0). Normals come from the analytic height field. */
export function buildTerrainGeometry(env: EnvironmentDefinition, info: TerrainInfo): THREE.BufferGeometry {
  const [ex, ez] = env.geometry.extentM;
  const nx = Math.max(2, Math.round(ex / info.spacing) + 1);
  const nz = Math.max(2, Math.round(ez / info.spacing) + 1);
  const pos = new Float32Array(nx * nz * 3);
  const nor = new Float32Array(nx * nz * 3);
  const t = env.geometry.terrain;
  const h = (x: number, z: number) => terrainHeight(t, x, z);
  const e = info.spacing * 0.5;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const x = -ex / 2 + (ex * i) / (nx - 1);
      const z = -ez / 2 + (ez * j) / (nz - 1);
      const k = (j * nx + i) * 3;
      pos[k] = x;
      pos[k + 1] = h(x, z) - info.baseY;
      pos[k + 2] = z;
      const dx = (h(x + e, z) - h(x - e, z)) / (2 * e);
      const dz = (h(x, z + e) - h(x, z - e)) / (2 * e);
      const l = Math.hypot(dx, 1, dz);
      nor[k] = -dx / l;
      nor[k + 1] = 1 / l;
      nor[k + 2] = -dz / l;
    }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let q = 0;
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[q++] = a;
      idx[q++] = c;
      idx[q++] = b;
      idx[q++] = b;
      idx[q++] = c;
      idx[q++] = d;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/**
 * Cut faces around the site, down to below the lowest point: the site reads as a surveyed block in the overview
 * instead of a sheet floating in the dark. Local to (0, baseY, 0) like the seabed.
 */
export function buildSkirtGeometry(env: EnvironmentDefinition, info: TerrainInfo): THREE.BufferGeometry {
  const [ex, ez] = env.geometry.extentM;
  const bottom = info.minY - Math.max(1.5, (info.maxY - info.minY) * 0.6) - info.baseY;
  const pos: number[] = [];
  const nor: number[] = [];
  const t = env.geometry.terrain;
  const edge = (x0: number, z0: number, x1: number, z1: number, n: [number, number, number]) => {
    const L = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(2, Math.ceil(L / Math.max(info.spacing, L / 400)));
    for (let s = 0; s < steps; s++) {
      const a = s / steps;
      const b = (s + 1) / steps;
      const xa = x0 + (x1 - x0) * a;
      const za = z0 + (z1 - z0) * a;
      const xb = x0 + (x1 - x0) * b;
      const zb = z0 + (z1 - z0) * b;
      const ya = terrainHeight(t, xa, za) - info.baseY;
      const yb = terrainHeight(t, xb, zb) - info.baseY;
      pos.push(xa, ya, za, xa, bottom, za, xb, yb, zb, xb, yb, zb, xa, bottom, za, xb, bottom, zb);
      for (let i = 0; i < 6; i++) nor.push(...n);
    }
  };
  edge(-ex / 2, ez / 2, ex / 2, ez / 2, [0, 0, 1]);
  edge(ex / 2, -ez / 2, -ex / 2, -ez / 2, [0, 0, -1]);
  edge(ex / 2, ez / 2, ex / 2, -ez / 2, [1, 0, 0]);
  edge(-ex / 2, -ez / 2, -ex / 2, ez / 2, [-1, 0, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** Uniforms shared by every seabed material: shallow-water caustics and the current direction for ripples. */
export const seabedUniforms = {
  uFieldCaustic: { value: 0 },
  uFieldTime: { value: 0 },
  /** horizontal direction ripple crests run across (the flow direction), world xz */
  uRippleDir: { value: new THREE.Vector2(1, 0) },
};

/**
 * Seabed material: the environment's seabed colour with procedural variation per material class.
 *   sand, coral sand: current ripples (crests across the flow), heavy minerals and shell hash in the troughs
 *   gravel: rounded pebbles of mixed tone
 *   mud, silt: low mottling, flocculent patches and burrow openings
 *   ooze: pale, smooth, faint mottles and the odd track
 * Caustics (reef) are evaluated here at a real-world cell size of about 0.6 m.
 */
export function seabedMaterial(env: EnvironmentDefinition): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: env.seabed.color, roughness: 0.96, metalness: 0 });
  const uniforms = { uSeabedKind: { value: KIND[env.seabed.material] }, uSeabedSeed: { value: env.geometry.terrain.seed % 97 } };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, seabedUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSbPos;\nvarying vec3 vSbNormal;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSbPos = position;\nvSbNormal = normal;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uSeabedKind;
uniform float uSeabedSeed;
uniform float uFieldCaustic;
uniform float uFieldTime;
uniform vec2 uRippleDir;
varying vec3 vSbPos;
varying vec3 vSbNormal;
${GLSL_NOISE}
vec2 sbHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
// distance to the nearest and second nearest feature point (cells for pebbles and caustics)
vec2 sbCells(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.4 * sin(t + 6.2831 * sbHash2(i + g));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  return vec2(sqrt(d1), sqrt(d2));
}
float sbCaustic(vec2 xz, float t) {
  vec2 w = xz + 0.08 * vec2(sin(xz.y * 3.1 + t * 0.7), sin(xz.x * 2.7 - t * 0.6));
  vec2 a = sbCells(w / 0.62, t * 0.45);
  vec2 b = sbCells(w / 0.38 + 7.3, t * 0.7);
  float ca = pow(max(0.0, 1.0 - (a.y - a.x) / 0.3), 3.5);
  float cb = pow(max(0.0, 1.0 - (b.y - b.x) / 0.26), 3.5);
  return 0.55 * ca + 0.35 * cb + 0.9 * ca * cb;
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec3 sp = vSbPos + vec3(uSeabedSeed * 7.31, 0.0, uSeabedSeed * 3.17);
float sbFw = length(fwidth(sp));
// large-scale tone: patches of finer and coarser sediment
float sbLarge = wFbm(sp * 0.12, sbFw * 0.12);
float sbMid = wFbm(sp * 0.9 + 11.0, sbFw * 0.9);
float sbTone = 0.82 + 0.36 * sbLarge + 0.12 * (sbMid - 0.5);
float sbHeight = 0.0;
int kind = int(uSeabedKind + 0.5);
if (kind == 0 || kind == 4) {
  // current ripples: crests across the flow, wavelength about 12 cm, bent by noise; fade as they approach a pixel
  vec2 dir = normalize(uRippleDir + vec2(1e-4));
  float ph = dot(sp.xz, dir) / 0.12 + 2.2 * wFbm(sp * 0.35, sbFw * 0.35);
  float fade = 1.0 - smoothstep(0.35, 0.9, fwidth(ph));
  float rip = sin(6.2831 * ph);
  // asymmetric profile: gentle stoss side, steep lee side
  rip = rip + 0.35 * sin(12.566 * ph);
  sbHeight += 0.008 * rip * fade;
  sbTone *= 1.0 - 0.08 * fade * smoothstep(0.2, 1.0, -rip);
  // shell hash and coarse grains
  float hash = smoothstep(0.72, 0.8, wNoise(sp * 22.0)) * (1.0 - smoothstep(0.1, 0.4, sbFw * 22.0));
  sbTone *= 1.0 + (kind == 4 ? 0.35 : 0.18) * hash;
} else if (kind == 2) {
  // gravel: rounded pebbles about 4 cm, each its own tone
  vec2 c = sbCells(sp.xz / 0.04, 0.0);
  float fade = 1.0 - smoothstep(0.15, 0.5, sbFw / 0.04);
  float peb = smoothstep(0.75, 0.15, c.x);
  sbHeight += 0.012 * peb * fade;
  float id = fract(sin(dot(floor(sp.xz / 0.04), vec2(12.9898, 78.233))) * 43758.5453);
  sbTone *= mix(1.0, 0.7 + 0.6 * id, fade) * mix(1.0, 0.8 + 0.2 * peb, fade);
} else if (kind == 1 || kind == 5) {
  // mud and silt: soft mottling, darker flocculent patches, burrow openings
  float mot = wFbm(sp * 2.4 + 5.0, sbFw * 2.4);
  sbTone *= 0.85 + 0.3 * mot;
  float burrow = smoothstep(0.86, 0.9, wNoise(sp * 9.0 + 3.0)) * (1.0 - smoothstep(0.2, 0.5, sbFw * 9.0));
  sbTone *= 1.0 - 0.55 * burrow;
  sbHeight += 0.01 * (mot - 0.5) - 0.01 * burrow;
} else {
  // ooze: pale and smooth with faint mottles and meandering trails
  float mot = wFbm(sp * 1.3 + 9.0, sbFw * 1.3);
  sbTone *= 0.92 + 0.14 * mot;
  float trail = 1.0 - smoothstep(0.0, 0.02, abs(wFbm(sp * 0.25 + 4.0, sbFw * 0.25) - 0.5));
  sbTone *= 1.0 - 0.1 * trail * (1.0 - smoothstep(0.02, 0.08, sbFw));
  sbHeight += 0.004 * (mot - 0.5);
}
// steeper ground sheds fines: a little darker and coarser
float sbSlope = 1.0 - normalize(vSbNormal).y;
sbTone *= 1.0 - 0.6 * smoothstep(0.08, 0.5, sbSlope);
diffuseColor.rgb *= sbTone;`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
normal = wPerturb(-vViewPosition, normal, vec2(dFdx(sbHeight), dFdy(sbHeight)), faceDirection);`,
      )
      .replace(
        "#include <tonemapping_fragment>",
        `if (uFieldCaustic > 0.0) {
  gl_FragColor.rgb += diffuseColor.rgb * uFieldCaustic * max(normalize(vSbNormal).y, 0.0) * sbCaustic(vSbPos.xz, uFieldTime) * (1.0 - smoothstep(0.08, 0.3, sbFw));
}
#include <tonemapping_fragment>`,
      );
  };
  m.customProgramCacheKey = () => "field-seabed-1";
  return m;
}

/** Material of the cut faces around the site: layered sediment in section. */
export function skirtMaterial(env: EnvironmentDefinition): THREE.MeshStandardMaterial {
  const c = new THREE.Color(env.seabed.color).multiplyScalar(0.55);
  return new THREE.MeshStandardMaterial({ color: c, roughness: 1, metalness: 0 });
}
