"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFieldStore } from "@/lib/field/store";
import { mulberry32 } from "@/lib/sim/rng";
import { WATER_GLSL, currentWater, waterUniforms } from "@/components/lab/water";
import { WORLD_LAYER, useDeferredDispose } from "./common";
import { fieldFeedCam, site } from "./feed";

/*
 * Suspended sediment and marine snow carried by the ACTUAL current field: every fleck's position is advected on the
 * CPU with engine.current.sample(p, t) in simulation time (paused with the simulation, faster at higher time scales).
 * A quarter of the flecks is advanced per frame, each with its own elapsed time, so the cost stays flat.
 * The cloud lives in a box around the platform camera and wraps at its faces (a wrap is not motion and is not counted
 * as travel). Shading is the lab's particle model through the same water (components/lab/Particles.tsx).
 */

const VERT = /* glsl */ `
uniform float uPixelRatio;
uniform float uWaterViewportH;
attribute float seed;
varying vec3 vWorld;
varying float vSeed;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vSeed = seed;
  vec4 mv = viewMatrix * w;
  // flecks are 0.4 to 1.5 mm: projected size from the focal length, with a one-pixel defocus floor
  float focalPx = projectionMatrix[1][1] * 0.5 * uWaterViewportH;
  float size = (0.0004 + 0.0011 * seed) * focalPx / -mv.z;
  gl_PointSize = clamp(size, 1.0, 5.0 * uPixelRatio);
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
  if (uWaterLamp > 0.5) lit *= clamp(0.6 / max(1e-4, dot(vWorld - uWaterLampPos, vWorld - uWaterLampPos)), 0.0, 8.0);
  vec3 col = waterApply(lit, vWorld, 1.0, true);
  float vis = dot(exp(-uWaterC * waterPath(cameraPosition, vWorld) * uWaterViewScale), vec3(0.3333));
  gl_FragColor = vec4(col, uOpacity * soft * (0.35 + 0.65 * vSeed) * vis);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Dev and test access: the mean actual displacement of the flecks since the last reset, world metres. */
export const particleProbe = {
  travel: [0, 0, 0] as [number, number, number],
  samples: 0,
  reset() {
    this.travel = [0, 0, 0];
    this.samples = 0;
    resetFlag.value = true;
  },
};
const resetFlag = { value: false };

/** Re-wraps the cloud around a camera position at once (the dataset capture moves the camera between frames). */
export const particleSync = { wrapAround: null as null | ((p: THREE.Vector3) => void) };

export function FieldParticles({ density, marineSnow }: { density: number; marineSnow: boolean }) {
  const count = Math.round(Math.min(6000, Math.max(800, 2600 * density)));
  const sim = useMemo(() => {
    const rand = mulberry32(4242);
    const pos = new Float64Array(count * 3);
    const travel = new Float64Array(count * 3);
    const last = new Float64Array(count);
    const seed = new Float32Array(count);
    const render = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      seed[i] = rand();
      for (let k = 0; k < 3; k++) pos[i * 3 + k] = (rand() * 2 - 1) * 4;
    }
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(render, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", attr);
    geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uPixelRatio: { value: 1 }, uOpacity: { value: 0.75 }, ...waterUniforms },
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    points.name = "field-particles";
    points.frustumCulled = false;
    points.renderOrder = 2;
    points.layers.set(WORLD_LAYER);
    points.userData.noWater = true;
    const st = { centre: new THREE.Vector3(), half: 4, frame: 0, primed: false };
    const wrapAll = (writeRender: boolean) => {
      const { centre, half } = st;
      for (let i = 0; i < count; i++)
        for (let k = 0; k < 3; k++) {
          const c = k === 0 ? centre.x : k === 1 ? centre.y : centre.z;
          let v = pos[i * 3 + k] - c;
          if (v > half || v < -half) {
            v = ((((v + half) % (2 * half)) + 2 * half) % (2 * half)) - half;
            pos[i * 3 + k] = c + v;
          }
          if (writeRender) render[i * 3 + k] = v;
        }
    };
    const wrapAround = (c: THREE.Vector3) => {
      st.centre.copy(c);
      wrapAll(true);
      attr.needsUpdate = true;
      points.position.set(c.x, c.y - site.baseY, c.z);
      points.updateMatrixWorld();
    };
    const step = (pixelRatio: number) => {
      const engine = useFieldStore.getState().engine;
      const t = engine.time;
      const { centre } = st;
      // the cloud follows the platform camera (posed by the feed pass each frame), world coordinates
      const cam = fieldFeedCam.position;
      st.half = Math.min(9, Math.max(2.5, 0.8 * engine.visibility()));
      const half = st.half;
      centre.set(cam.x, cam.y, cam.z);
      if (!st.primed || resetFlag.value) {
        for (let i = 0; i < count; i++) {
          for (let k = 0; k < 3; k++) {
            pos[i * 3 + k] = (k === 0 ? centre.x : k === 1 ? centre.y : centre.z) + (seed[(i * 7 + k * 13) % count] * 2 - 1) * half;
            travel[i * 3 + k] = 0;
          }
          last[i] = t;
        }
        st.primed = true;
        resetFlag.value = false;
      }
      const chunk = st.frame++ % 4;
      const p: [number, number, number] = [0, 0, 0];
      const sink = marineSnow ? -0.0015 : -0.0004; // settling velocity of flocs, m/s
      for (let i = chunk; i < count; i += 4) {
        const dt = t - last[i];
        last[i] = t;
        if (!(dt > 0) || dt > 5) continue;
        p[0] = pos[i * 3];
        p[1] = pos[i * 3 + 1];
        p[2] = pos[i * 3 + 2];
        const v = engine.current.sample(p, t);
        const dx = v[0] * dt;
        const dy = (v[1] + sink * (0.5 + seed[i])) * dt;
        const dz = v[2] * dt;
        pos[i * 3] += dx;
        pos[i * 3 + 1] += dy;
        pos[i * 3 + 2] += dz;
        travel[i * 3] += dx;
        travel[i * 3 + 1] += dy;
        travel[i * 3 + 2] += dz;
      }
      // wrap into the box around the camera (a wrap is not motion: travel is untouched)
      wrapAll(true);
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let i = 0; i < count; i++) {
        sx += travel[i * 3];
        sy += travel[i * 3 + 1];
        sz += travel[i * 3 + 2];
      }
      particleProbe.travel = [sx / count, sy / count, sz / count];
      particleProbe.samples = count;
      attr.needsUpdate = true;
      points.position.set(centre.x, centre.y - site.baseY, centre.z);
      mat.uniforms.uPixelRatio.value = pixelRatio;
      // suspended particles are what turbidity is: their number follows particle scattering
      const bG = currentWater.optics.b[1];
      const share = Math.min(1, (marineSnow ? 0.35 : 0.12) + 0.3 * Math.max(0, bG - 0.002));
      geo.setDrawRange(0, Math.round(count * share));
    };
    const dispose = () => {
      geo.dispose();
      mat.dispose();
    };
    return { points, geo, mat, step, wrapAround, dispose };
  }, [count, marineSnow]);

  useEffect(() => {
    particleSync.wrapAround = sim.wrapAround;
    return () => {
      if (particleSync.wrapAround === sim.wrapAround) particleSync.wrapAround = null;
    };
  }, [sim]);
  useDeferredDispose(sim, sim.dispose);

  useFrame((state) => sim.step(state.gl.getPixelRatio()));

  return <primitive object={sim.points} />;
}
