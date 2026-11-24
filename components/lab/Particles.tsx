"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { useDeferredDispose } from "@/components/field/common";
import { mulberry32 } from "@/lib/sim/rng";
import { WATER_GLSL, currentWater, waterTime, waterUniforms } from "./water";

/*
 * Suspended sediment: soft flecks that drift with the current, lit by the light that reaches them and seen through
 * the same water as everything else, so far flecks melt into the veil and near ones read as out-of-focus snow.
 * In lamp-lit water the flecks right in front of the lens catch the lamp and glow: marine snow.
 */

const VERT = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
uniform float uWaterViewportH;
uniform vec3 uBoxMin;
uniform vec3 uBoxSize;
uniform vec2 uDrift;
attribute float seed;
varying vec3 vWorld;
varying float vSeed;
void main() {
  vec3 p = position;
  // carried by the current and wrapped inside the box, so the cloud never thins out
  p.xz += uDrift * uTime * (0.7 + 0.6 * seed);
  p.x += 0.012 * sin(uTime * 0.25 + seed * 6.28);
  p.z += 0.010 * cos(uTime * 0.21 + seed * 9.4);
  p.y += 0.008 * sin(uTime * 0.17 + seed * 3.1) - 0.004 * uTime * 0.05 * seed;
  p = uBoxMin + mod(p - uBoxMin, uBoxSize);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vSeed = seed;
  vec4 mv = viewMatrix * w;
  // flecks are 0.4 to 1 mm: projected size from the projection's focal length, with a defocus floor of one pixel
  float focalPx = projectionMatrix[1][1] * 0.5 * uWaterViewportH;
  float size = (0.0004 + 0.0006 * seed) * focalPx / -mv.z;
  gl_PointSize = clamp(size, 1.0, 4.0 * uPixelRatio);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform float uOpacity;
uniform float uWaterWhite;
${WATER_GLSL}
varying vec3 vWorld;
varying float vSeed;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r2 = dot(q, q) * 4.0;
  if (r2 > 1.0) discard;
  float soft = exp(-3.0 * r2);
  vec3 lit = uWaterWhite * vec3(0.55, 0.53, 0.47);
  // a lamp's light also falls off with the square of distance; daylight does not
  if (uWaterLamp > 0.5) lit *= clamp(0.18 / max(1e-4, dot(vWorld - uWaterLampPos, vWorld - uWaterLampPos)), 0.0, 6.0);
  vec3 col = waterApply(lit, vWorld, 1.0, true);
  float vis = dot(exp(-uWaterC * waterPath(cameraPosition, vWorld) * uWaterViewScale), vec3(0.3333));
  gl_FragColor = vec4(col, uOpacity * soft * (0.35 + 0.65 * vSeed) * vis);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface ParticlesProps {
  /** box the flecks live in, world metres */
  min: [number, number, number];
  max: [number, number, number];
  count: number;
  /** horizontal current, m/s */
  drift?: [number, number];
}

const NO_DRIFT: [number, number] = [0, 0];

export function Particles({ min, max, count, drift = NO_DRIFT }: ParticlesProps) {
  // props must be stable (module constants), so this builds once per box; the drift is a live uniform, so a new
  // environment's current never rebuilds (and never leaks) the cloud
  const { geo, mat, update } = useMemo(() => {
    const rand = mulberry32(99);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) pos[i * 3 + k] = min[k] + rand() * (max[k] - min[k]);
      seed[i] = rand();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
    // the cloud moves and wraps in the shader; never cull it on stale bounds
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uOpacity: { value: 0.7 },
        uBoxMin: { value: new THREE.Vector3(...min) },
        uBoxSize: { value: new THREE.Vector3(max[0] - min[0], max[1] - min[1], max[2] - min[2]) },
        uDrift: { value: new THREE.Vector2() },
        ...waterUniforms,
      },
      transparent: true,
      depthWrite: false,
    });
    /** Per-frame uniforms. Suspended particles are what turbidity is: their number follows particle scattering. */
    const update = (t: number, pixelRatio: number, current: readonly [number, number]) => {
      mat.uniforms.uTime.value = waterTime(t);
      (mat.uniforms.uDrift.value as THREE.Vector2).set(current[0], current[1]);
      mat.uniforms.uPixelRatio.value = pixelRatio;
      const bG = currentWater.optics.b[1];
      geo.setDrawRange(0, Math.round(count * Math.min(1, 0.08 + 0.3 * Math.max(0, bG - 0.002))));
    };
    return { geo, mat, update };
  }, [min, max, count]);
  const resources = useMemo(() => ({ geo, mat }), [geo, mat]);
  useDeferredDispose(resources, () => {
    geo.dispose();
    mat.dispose();
  });

  useFrame((state) => update(state.clock.elapsedTime, state.gl.getPixelRatio(), drift));

  return <points geometry={geo} material={mat} renderOrder={2} />;
}
