"use client";

import * as THREE from "three";

/**
 * Procedural weathering for objects that have sat on a tank floor: paint lost to rust, fine silt settled on every
 * up-facing surface, a thin film of marine growth, and surface relief (pitting, plate texture) as a bump.
 * Everything is evaluated per fragment from 3D value noise in object space, so it needs no UVs, no downloads,
 * and stays fixed to the object as it moves. Deterministic: the noise is a pure hash of position and seed.
 */
export interface Weathering {
  /** noise cells per metre; about 1 / feature size */
  scale: number;
  /** share of the surface turned to rust, 0..1 */
  rust: number;
  /** silt cover on up-facing surfaces, 0..1 */
  silt: number;
  /** marine growth film, 0..1 */
  growth: number;
  /** relief strength; 1 is a few tenths of a millimetre */
  bump: number;
  /** decorrelates objects that share parameters */
  seed: number;
  /** rust colour pair, dark and light */
  rustColors?: [THREE.ColorRepresentation, THREE.ColorRepresentation];
}

/** Settled kaolin and sand fines: pale, warm, matte. */
const SILT = new THREE.Color("#8d846c");
const GROWTH = new THREE.Color("#3a3d22");

const GLSL_NOISE = /* glsl */ `
float wHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
// Gradient noise: unlike value noise it has no lattice-aligned plateaus, so thresholded masks stay organic
// instead of turning into squares. Returns about 0..1 with mean 0.5.
vec3 wGrad(vec3 i) {
  return normalize(vec3(wHash(i), wHash(i + 31.7), wHash(i + 77.3)) * 2.0 - 1.0 + 1e-4);
}
float wNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(wGrad(i), f);
  float n100 = dot(wGrad(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
  float n010 = dot(wGrad(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
  float n110 = dot(wGrad(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
  float n001 = dot(wGrad(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
  float n101 = dot(wGrad(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
  float n011 = dot(wGrad(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
  float n111 = dot(wGrad(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
  float n = mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
  return clamp(0.5 + 0.9 * n, 0.0, 1.0);
}
// rotation between octaves so no octave shares the lattice axes of another
const mat3 W_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
// Band-limited fbm: an octave fades out as its cells approach a pixel (fw = noise units per pixel), so fine
// detail never aliases into sparkle at distance; the lost octave's mean (0.5) is kept so brightness holds.
float wFbm(vec3 p, float fw) {
  float v = 0.0;
  float a = 0.5;
  float f = 1.0;
  for (int i = 0; i < 4; i++) {
    float keep = 1.0 - smoothstep(0.25, 0.6, fw * f);
    v += a * mix(0.5, wNoise(p), keep);
    p = W_ROT * p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
    f *= 2.03;
  }
  return v;
}
vec3 wPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}`;

/** Adds weathering to a standard material, after any onBeforeCompile it already has. Call once, at creation. */
export function weather<T extends THREE.MeshStandardMaterial>(m: T, w: Weathering): T {
  const [rLo, rHi] = w.rustColors ?? ["#3b1a0c", "#7a3a17"];
  const uniforms = {
    uWScale: { value: w.scale },
    uWRust: { value: w.rust },
    uWSilt: { value: w.silt },
    uWGrowth: { value: w.growth },
    uWBump: { value: w.bump },
    uWSeed: { value: w.seed },
    uWRustLo: { value: new THREE.Color(rLo) },
    uWRustHi: { value: new THREE.Color(rHi) },
    uWSiltColor: { value: SILT.clone() },
    uWGrowthColor: { value: GROWTH.clone() },
  };
  // kept on the material so an environment can retune a surface (the tank floor) without rebuilding it
  m.userData.weather = uniforms;
  const prevCompile = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(m, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWUp;\nvarying vec3 vWNormal;")
      .replace(
        "#include <beginnormal_vertex>",
        // object-space "up" for silt: the world up vector carried into object space, so silt sits on the top
        // of a listing hull, not on its object-space top
        "#include <beginnormal_vertex>\nvWNormal = objectNormal;\nvWUp = normalize(transpose(mat3(modelMatrix)) * vec3(0.0, 1.0, 0.0));",
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWPos = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uWScale;
uniform float uWRust;
uniform float uWSilt;
uniform float uWGrowth;
uniform float uWBump;
uniform float uWSeed;
uniform vec3 uWRustLo;
uniform vec3 uWRustHi;
uniform vec3 uWSiltColor;
uniform vec3 uWGrowthColor;
varying vec3 vWPos;
varying vec3 vWUp;
varying vec3 vWNormal;
${GLSL_NOISE}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec3 wp = vWPos * uWScale + uWSeed * 13.7;
float wFw = length(fwidth(wp));
float wLarge = wFbm(wp, wFw);
float wFine = wFbm(wp * 5.1 + 3.3, wFw * 5.1);
// object-space normal (flipped on back faces of open shells) against world up carried into object space
float wUp = dot(normalize(vWNormal) * (gl_FrontFacing ? 1.0 : -1.0), vWUp);
// paint loss: rust where large-scale noise crosses the rust share, with ragged edges from the fine noise
// features with zero weight are skipped: the branches depend on uniforms only, so they cost nothing
float wRust = uWRust > 0.0 ? smoothstep(1.0 - uWRust - 0.06, 1.0 - uWRust + 0.06, wLarge * 0.75 + wFine * 0.35) : 0.0;
// rust streaks run down from edges: noise stretched along up
float wStreak = uWRust > 0.0 ? smoothstep(0.62, 0.8, wFbm(vec3(wp.x * 3.0, wp.y * 0.25, wp.z * 3.0), wFw * 3.0)) * uWRust : 0.0;
vec3 wRustCol = mix(uWRustLo, uWRustHi, wFine);
diffuseColor.rgb = mix(diffuseColor.rgb, wRustCol, clamp(wRust + wStreak * 0.5, 0.0, 1.0));
// marine growth: a patchy olive film, thicker in crevices of the large noise
float wGrowth = uWGrowth > 0.0 ? smoothstep(0.45, 0.7, wFbm(wp * 1.7 + 21.0, wFw * 1.7)) * uWGrowth : 0.0;
diffuseColor.rgb = mix(diffuseColor.rgb, uWGrowthColor, wGrowth * 0.75);
// silt on faces that look up, in drifts: thick where it collected, bare where the current scoured it
float wDrift = uWSilt > 0.0 ? smoothstep(0.32, 0.62, wFbm(wp * 0.6 + 40.0, wFw * 0.6) + 0.25 * wFine) : 0.0;
float wSilt = smoothstep(0.35, 0.95, wUp) * uWSilt * wDrift;
diffuseColor.rgb = mix(diffuseColor.rgb, uWSiltColor, wSilt);
float wHeight = wFine * 0.6 + (wRust > 0.0 ? wRust * 0.5 * wFbm(wp * 14.0, wFw * 14.0) : 0.0) - wSilt * 0.2;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.95, clamp(wRust + wSilt + wGrowth, 0.0, 1.0));",
      )
      .replace(
        "#include <metalnessmap_fragment>",
        "#include <metalnessmap_fragment>\nmetalnessFactor *= (1.0 - wRust) * (1.0 - wSilt) * (1.0 - wGrowth);",
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
normal = wPerturb(-vViewPosition, normal, vec2(dFdx(wHeight), dFdy(wHeight)) * uWBump * 0.0015, faceDirection);`,
      );
  };
  m.customProgramCacheKey = () => `${prevKey.call(m)}|weather`;
  return m;
}
