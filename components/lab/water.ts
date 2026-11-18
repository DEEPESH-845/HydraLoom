"use client";

import * as THREE from "three";
import { TANK } from "@/lib/sim/constants";
import { waterOptics, type WaterOptics, type WaterSpec } from "@/lib/optics/water";

/**
 * Physically based water for every lit material in the scene, both render passes.
 *
 * Per fragment, in linear light before tone mapping:
 *   1. light reaching a submerged point has crossed water on its way: from the surface in daylight,
 *      J *= exp(-Kd (surface - y)), or from the rig's lamp in the deep, J *= exp(-Kd |p - lamp|)
 *   2. the view ray's path inside the water volume, d, is found analytically (segment vs box), so a camera in air
 *      looking through the glass, a camera under water and parts above the surface all get the right path
 *   3. image formation (Akkaynak and Treibitz 2018, with beta_D = beta_B = c):
 *        I = J exp(-c d) + Binf (1 - exp(-c d))
 *      Binf is the deep-water reflectance rInf times the light reaching the midpoint of the view path, so the veil
 *      is as bright as the water that scatters it (lib/sim/environments.ts lightPaths uses the same paths)
 *   4. exposure: a camera exposes for the seabed, so the result is divided by the light reaching the floor
 * The main view may thin the water (uWaterViewScale < 1) so a whole site stays visible; the feed never does.
 * Forward-scatter blur is not modelled yet; it belongs to a separate screen-space pass.
 */

const INNER_L = TANK.length - 2 * TANK.glass;
const INNER_W = TANK.width - 2 * TANK.glass;

/** The tank's water box. Field environments use an open box around the site instead. */
export const TANK_WATER_BOX = {
  min: new THREE.Vector3(-INNER_L / 2, -TANK.sandDepth, -INNER_W / 2),
  max: new THREE.Vector3(INNER_L / 2, TANK.waterLevel, INNER_W / 2),
};

/** Shared uniform objects. Every patched material references these same objects, so one write updates all. */
export const waterUniforms = {
  uWaterC: { value: new THREE.Vector3() },
  uWaterKd: { value: new THREE.Vector3() },
  /** rInf times the white level: the veil before the light path to the scattering water is applied */
  uWaterBinf: { value: new THREE.Vector3() },
  /** linear radiance of a white diffuse surface under the current lighting, before any water */
  uWaterWhite: { value: 1 },
  /** height in device pixels of the viewport being rendered, for shaders that size things in pixels */
  uWaterViewportH: { value: 900 },
  /** caustic irradiance added to up-facing submerged surfaces, relative to the white level */
  uWaterCaustic: { value: 0 },
  uWaterTime: { value: 0 },
  uWaterMin: { value: TANK_WATER_BOX.min.clone() },
  uWaterMax: { value: TANK_WATER_BOX.max.clone() },
  /** world Y of the sea surface; daylight is attenuated from here */
  uWaterSurfaceY: { value: TANK.waterLevel as number },
  /** 1 when the only light is the rig's lamp at uWaterLampPos */
  uWaterLamp: { value: 0 },
  uWaterLampPos: { value: new THREE.Vector3() },
  /** camera exposure for the seabed */
  uWaterExposure: { value: 1 },
  /** 1 for true water; below 1 the main view thins it (unused while every environment lives in the tank) */
  uWaterViewScale: { value: 1 },
  /**
   * Spectral filter on the lab light that emulates the colour of daylight at the environment's depth, normalised to
   * keep its brightness: exp(-Kd (column - tank depth)) / luminance. White in the tank and in the lamp-lit deep.
   */
  uWaterDepthTint: { value: new THREE.Vector3(1, 1, 1) },
};

/**
 * Clock for the water's animation (caustics, surface ripples, drifting particles). Screenshot tests freeze it through
 * the dev-only `window.__labFreezeWater` hook so their frames are deterministic; otherwise it is wall-clock time.
 */
export const waterClock = { frozen: null as number | null };
export const waterTime = (t: number) => waterClock.frozen ?? t;

/** Optics of the water currently applied, for components that shade themselves (surface, particles). */
export const currentWater: { optics: WaterOptics; white: number } = {
  optics: waterOptics({ ntu: 0, cPerNtu: 1, particleAlbedo: 0.95, particleBackscatterRatio: 0.019, particleSlope: 0.5, cdom440: 0 }),
  white: 1,
};

export interface WaterSetup {
  /** linear radiance a white diffuse surface would have under the current lights, before any water */
  white: number;
  /** world Y of the surface */
  surfaceY: number;
  /** true when only the rig's lamp lights the scene */
  lamp: boolean;
  /** height of the lamp above the floor when lamp is true, m */
  lampHeight: number;
  /** water column of the emulated environment, m; its extra depth over the tank tints the light */
  columnM: number;
  box: { min: THREE.Vector3; max: THREE.Vector3 };
}

const LUMA = [0.2126, 0.7152, 0.0722];

/** Applies a water body and its lighting to the shared uniforms. */
export function setWater(spec: WaterSpec, setup: WaterSetup): WaterOptics {
  const o = waterOptics(spec);
  const u = waterUniforms;
  u.uWaterC.value.set(...o.c);
  u.uWaterKd.value.set(...o.kd);
  u.uWaterBinf.value.set(o.rInf[0] * setup.white, o.rInf[1] * setup.white, o.rInf[2] * setup.white);
  u.uWaterWhite.value = setup.white;
  u.uWaterMin.value.copy(setup.box.min);
  u.uWaterMax.value.copy(setup.box.max);
  u.uWaterSurfaceY.value = setup.surfaceY;
  u.uWaterLamp.value = setup.lamp ? 1 : 0;
  const extra = setup.lamp ? 0 : Math.max(0, setup.columnM - setup.surfaceY);
  const tint = o.kd.map((k) => Math.exp(-k * extra));
  const tintLum = LUMA.reduce((sum, w, i) => sum + w * tint[i], 0);
  u.uWaterDepthTint.value.set(tint[0] / tintLum, tint[1] / tintLum, tint[2] / tintLum);
  // expose for the floor: the luminance of the light that reaches it, from the surface or from the lamp
  const toFloor = setup.lamp ? setup.lampHeight : setup.surfaceY;
  const floorLight = LUMA.reduce((sum, w, i) => sum + w * Math.exp(-o.kd[i] * toFloor), 0);
  u.uWaterExposure.value = Math.min(400, 1 / Math.max(1e-6, floorLight));
  // focusing by the rippled surface survives only while light crosses the column unscattered: exp(-b depth)
  // the emulated column sets it: a deep harbour has none even though the tank is shallow
  u.uWaterCaustic.value = setup.lamp ? 0 : 0.42 * setup.white * Math.exp(-o.b[1] * Math.max(setup.surfaceY, setup.columnM));
  currentWater.optics = o;
  currentWater.white = setup.white;
  return o;
}

const VERT_DECL = /* glsl */ `
varying vec3 vWaterWorld;`;

const VERT_BODY = /* glsl */ `
{
  vec4 waterWorld = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    waterWorld = batchingMatrix * waterWorld;
  #endif
  #ifdef USE_INSTANCING
    waterWorld = instanceMatrix * waterWorld;
  #endif
  vWaterWorld = (modelMatrix * waterWorld).xyz;
}`;

/** Uniforms and functions for self-written shaders that want the same water (particles use it). */
export const WATER_GLSL = /* glsl */ `
uniform vec3 uWaterC;
uniform vec3 uWaterKd;
uniform vec3 uWaterBinf;
uniform vec3 uWaterMin;
uniform vec3 uWaterMax;
uniform float uWaterSurfaceY;
uniform float uWaterLamp;
uniform vec3 uWaterLampPos;
uniform float uWaterExposure;
uniform float uWaterViewScale;
uniform vec3 uWaterDepthTint;
// Parameters [tn, tf] in 0..1 of the part of segment a -> b that lies inside the water box.
vec2 waterSegment(vec3 a, vec3 b) {
  vec3 d = b - a;
  vec3 safe = mix(d, vec3(1e-6), vec3(equal(d, vec3(0.0))));
  vec3 t0 = (uWaterMin - a) / safe;
  vec3 t1 = (uWaterMax - a) / safe;
  vec3 lo = min(t0, t1);
  vec3 hi = max(t0, t1);
  return vec2(max(max(lo.x, lo.y), max(lo.z, 0.0)), min(min(hi.x, hi.y), min(hi.z, 1.0)));
}
float waterPath(vec3 a, vec3 b) {
  vec2 s = waterSegment(a, b);
  return max(s.y - s.x, 0.0) * length(b - a);
}
// Per-channel fraction of the scene light that reaches a submerged point.
vec3 waterLightAt(vec3 p) {
  if (uWaterLamp > 0.5) return exp(-uWaterKd * distance(p, uWaterLampPos));
  return uWaterDepthTint * exp(-uWaterKd * max(0.0, uWaterSurfaceY - p.y));
}
// Water between the camera and p: attenuation, veil and exposure. col is p's radiance before any water.
vec3 waterApply(vec3 col, vec3 p, float alpha, bool submerged) {
  if (submerged) col *= waterLightAt(p);
  vec2 s = waterSegment(cameraPosition, p);
  float d = max(s.y - s.x, 0.0) * length(p - cameraPosition) * uWaterViewScale;
  vec3 tr = exp(-uWaterC * d);
  vec3 mid = mix(cameraPosition, p, 0.5 * (s.x + s.y));
  vec3 veil = uWaterBinf * waterLightAt(mid);
  // Daylight under water is far from isotropic: looking down sees the upwelling radiance (Binf as set, about
  // rInf of the downwelling), looking sideways about twice that, looking up toward the bright surface up
  // to 1 / R times it (the asymptotic radiance distribution, simplified). The camera feed looks straight down,
  // so it and the detection model see factor 1.
  if (uWaterLamp < 0.5) {
    float up = normalize(p - cameraPosition).y;
    float rLum = max(0.01, dot(uWaterBinf, vec3(0.2126, 0.7152, 0.0722)) / max(1e-4, uWaterWhite));
    veil *= up < 0.0 ? mix(2.0, 1.0, -up) : mix(2.0, 0.25 / rLum, up * up);
  }
  return (col * tr + veil * (1.0 - tr) * alpha) * uWaterExposure;
}`;

/**
 * Caustics: light focused by the rippled surface forms a network of bright filaments around darker cells.
 * Distance to the nearest Voronoi edge (F2 - F1) of drifting seeds gives that network; two scales are summed,
 * domain-warped into curves, and modulated by larger swells. World XZ, so every surface shares one pattern.
 */
export const CAUSTIC_GLSL = /* glsl */ `
uniform float uWaterCaustic;
uniform float uWaterTime;
vec2 causticHash(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float causticEdge(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.38 * sin(t + 6.2831 * causticHash(i + g));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  return sqrt(d2) - sqrt(d1);
}
float caustic(vec2 xz, float t) {
  vec2 w = xz + 0.006 * vec2(sin(xz.y * 61.0 + t * 0.7), sin(xz.x * 53.0 - t * 0.6));
  float a = pow(max(0.0, 1.0 - causticEdge(w / 0.05, t * 0.45) / 0.32), 3.5);
  float b = pow(max(0.0, 1.0 - causticEdge(w / 0.031 + 7.3, t * 0.7) / 0.28), 3.5);
  float c = 0.55 * a + 0.35 * b + 0.9 * a * b;
  return c * (0.65 + 0.35 * sin(xz.x * 9.0 + t * 0.3) * sin(xz.y * 11.0 - t * 0.25));
}`;

const FRAG_DECL = /* glsl */ `
varying vec3 vWaterWorld;
uniform float uWaterWhite;
${WATER_GLSL}
${CAUSTIC_GLSL}`;

const FRAG_APPLY = /* glsl */ `
{
  vec3 p = vWaterWorld;
  bool submerged = all(greaterThanEqual(p, uWaterMin)) && all(lessThanEqual(p, uWaterMax));
  #ifdef WATER_CAUSTICS
    if (submerged && uWaterCaustic > 0.0) {
      // extra light on faces that look up at the surface; the face normal comes from screen derivatives
      vec3 fn = normalize(cross(dFdx(p), dFdy(p)));
      if (dot(fn, cameraPosition - p) < 0.0) fn = -fn;
      gl_FragColor.rgb += diffuseColor.rgb * uWaterCaustic * max(fn.y, 0.0) * caustic(p.xz, uWaterTime);
    }
  #endif
  gl_FragColor.rgb = waterApply(gl_FragColor.rgb, p, gl_FragColor.a, submerged);
}`;

/** Flag on the material itself: a module-level set would be emptied by a hot reload while the materials survive. */
const PATCH_FLAG = "gantrylabWater";

/** Materials that are drawn as part of the physical scene and include the standard tone-mapping chunk. */
const isPatchable = (m: THREE.Material) =>
  m instanceof THREE.MeshStandardMaterial ||
  m instanceof THREE.MeshBasicMaterial ||
  m instanceof THREE.MeshLambertMaterial ||
  m instanceof THREE.MeshPhongMaterial ||
  m instanceof THREE.PointsMaterial;

/** Adds the water model to a material, keeping any onBeforeCompile it already has. Idempotent. */
export function patchWaterMaterial(m: THREE.Material): void {
  if (m.userData[PATCH_FLAG] || !isPatchable(m)) return;
  m.userData[PATCH_FLAG] = true;
  const prevCompile = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(m, shader, renderer);
    Object.assign(shader.uniforms, waterUniforms);
    // lit surfaces receive caustics; unlit ones (labels, the meniscus line) and points do not
    if (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshLambertMaterial || m instanceof THREE.MeshPhongMaterial)
      shader.fragmentShader = `#define WATER_CAUSTICS
${shader.fragmentShader}`;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>${VERT_DECL}`)
      .replace("#include <fog_vertex>", `#include <fog_vertex>${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>${FRAG_DECL}`)
      .replace("#include <tonemapping_fragment>", `${FRAG_APPLY}\n#include <tonemapping_fragment>`);
  };
  m.customProgramCacheKey = () => `${prevKey.call(m)}|water3`;
  // the analytic path replaces scene fog entirely
  m.fog = false;
  m.needsUpdate = true;
}

/**
 * Patches every scene material once. HUD overlays (lines, and anything on the overlay layer only) are skipped,
 * because they are drawn on top of the world, not inside it.
 */
export function patchSceneWater(root: THREE.Object3D, overlayLayer: number): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh || o instanceof THREE.Points)) return;
    if (o.layers.mask === 1 << overlayLayer) return;
    if (o.userData.noWater) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) patchWaterMaterial(mat);
  });
}
