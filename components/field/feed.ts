"use client";

import * as THREE from "three";
import type { CameraPose } from "@/lib/field/camera";
import { pathOptics } from "@/lib/field/detection";
import type { FieldEngine } from "@/lib/field/engine";
import type { Vec3 } from "@/lib/physics/math";
import { qRotate } from "@/lib/physics/math";
import type { WaterOptics } from "@/lib/optics/water";
import { ntuAt } from "@/lib/world/environments";
import { terrainHeight } from "@/lib/world/terrain";
import { setWater, waterUniforms } from "@/components/lab/water";
import { WHITE_AT_FULL_LIGHT, WORLD_LAYER } from "./common";
import { seabedUniforms } from "./terrain";

/*
 * Water, lights and cameras for the two render passes of the field world.
 *   main pass: the view the user flies; the water may be thinned (store.overviewThinning) and the lamp-lit deep gets a
 *              labelled dim fill light, so a whole site reads
 *   feed pass: the platform camera, always true water (uWaterViewScale = 1) and only the light the platform really has
 * The physical model is components/lab/water.ts; this module only chooses its inputs per pass. Scene fog is never used.
 */

/** World-space site box the water fills: the whole site from below the seabed to the surface at y = 0. */
export const fieldWaterBox = { min: new THREE.Vector3(), max: new THREE.Vector3() };

export interface SiteFrame {
  /** lowest and highest seabed point, world Y */
  minY: number;
  maxY: number;
  /** origin of the site root in Y, world */
  baseY: number;
}

export const site: SiteFrame = { minY: -10, maxY: -5, baseY: -7 };

/** The constant light set (three.js compiles every shader for the light count, so it never changes on a switch). */
export const fieldLights = (() => {
  const sun = new THREE.DirectionalLight("#f3f0e8", 1.8);
  sun.name = "light-sun";
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  const hemi = new THREE.HemisphereLight("#9ab8c8", "#1a2026", 0.8);
  hemi.name = "light-ambient";
  // labelled overview aid for the lamp-lit deep: main pass only
  const fill = new THREE.HemisphereLight("#9fb6c8", "#2a2a2a", 0);
  fill.name = "light-overview-fill";
  const spots = [0, 1].map((i) => {
    const s = new THREE.SpotLight("#fff3dc", 0, 0, 1.1, 0.55, 2);
    s.name = `light-platform-lamp-${i}`;
    s.target.name = `light-platform-lamp-${i}-aim`;
    return s;
  });
  for (const l of [sun, hemi, fill, ...spots]) l.layers.set(WORLD_LAYER);
  return { sun, hemi, fill, spots };
})();

/** The platform camera. Layer 0 only: its own hull (vehicle layer) and the HUD are never in its image. */
export const fieldFeedCam = (() => {
  const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 120);
  c.name = "platform-camera";
  c.layers.set(WORLD_LAYER);
  return c;
})();

/**
 * Builds a PerspectiveCamera pose from a lib/field/camera pose exactly as project() assumes: looks along `forward`
 * with `up` as image up, vertical fov from the horizontal fov and the image aspect (tanV = tanH / aspect).
 */
export function poseCamera(cam: THREE.PerspectiveCamera, pose: CameraPose, baseY = 0): void {
  cam.position.set(pose.position[0], pose.position[1] - baseY, pose.position[2]);
  cam.up.set(pose.up[0], pose.up[1], pose.up[2]);
  cam.lookAt(pose.position[0] + pose.forward[0], pose.position[1] - baseY + pose.forward[1], pose.position[2] + pose.forward[2]);
  const tanH = Math.tan((pose.hfovDeg * Math.PI) / 360);
  cam.fov = (2 * Math.atan(tanH / pose.aspect) * 180) / Math.PI;
  cam.aspect = pose.aspect;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}

const LUMA = [0.2126, 0.7152, 0.0722];
/** Share of the depth colour cast the camera's auto white balance removes (0 none, 1 full). */
const WHITE_BALANCE = 0.65;
/** Colour of the platform's LED lamps, linear. */
const LAMP_WHITE = new THREE.Color("#fff3dc");
const lum = (v: readonly number[]) => LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2];

/** Distance along a ray to the seabed, or null within maxD. */
export function rayToBed(engine: FieldEngine, from: Vec3, dir: Vec3, maxD: number): number | null {
  const t = engine.env.geometry.terrain;
  let prev = 0;
  for (let d = 0.1; d <= maxD; d += Math.max(0.1, d * 0.05)) {
    const x = from[0] + dir[0] * d;
    const y = from[1] + dir[1] * d;
    const z = from[2] + dir[2] * d;
    if (terrainHeight(t, x, z) >= y) {
      // refine between prev and d
      let a = prev;
      let b = d;
      for (let k = 0; k < 8; k++) {
        const m = (a + b) / 2;
        if (terrainHeight(t, from[0] + dir[0] * m, from[2] + dir[2] * m) >= from[1] + dir[1] * m) b = m;
        else a = m;
      }
      return b;
    }
    prev = d;
  }
  return null;
}

export interface PassLight {
  /** linear radiance of a white surface under the light source in this pass */
  white: number;
  lamp: boolean;
}

/** Positions the two platform lamp lights at the platform's lamps, aimed along the camera. */
export function placeLamps(engine: FieldEngine, pose: { position: Vec3; attitude: [number, number, number, number] }, cam: CameraPose, baseY: number, intensity: number): void {
  const lamps = engine.platform.lamps;
  const station = !engine.vehicle;
  const groups: Vec3[][] = [[], []];
  for (const off of lamps.offsets) groups[off[2] < 0 ? 0 : 1].push(off);
  const halfAngle = Math.min(Math.PI / 2 - 0.05, ((lamps.beamDeg || 90) * Math.PI) / 360);
  fieldLights.spots.forEach((s, i) => {
    const g = groups[i].length ? groups[i] : groups[1 - i];
    let p: Vec3 = [0, 0, 0];
    for (const o of g) p = [p[0] + o[0] / g.length, p[1] + o[1] / g.length, p[2] + o[2] / g.length];
    // station lamps ride on the pan-tilt head beside the lens; vehicle lamps are fixed to the frame
    const w: Vec3 = station ? [cam.position[0] + cam.right[0] * p[2] + cam.up[0] * p[1], cam.position[1] + cam.right[1] * p[2] + cam.up[1] * p[1], cam.position[2] + cam.right[2] * p[2] + cam.up[2] * p[1]] : (() => {
      const r = qRotate(pose.attitude, p);
      return [pose.position[0] + r[0], pose.position[1] + r[1], pose.position[2] + r[2]] as Vec3;
    })();
    s.position.set(w[0], w[1] - baseY, w[2]);
    s.target.position.set(w[0] + cam.forward[0] * 3, w[1] - baseY + cam.forward[1] * 3, w[2] + cam.forward[2] * 3);
    s.target.updateMatrixWorld();
    s.angle = halfAngle;
    s.intensity = lamps.count > 0 ? intensity / 2 : 0;
  });
}

export interface WaterPass {
  optics: WaterOptics;
  /** clear colour of the pass: the veil at infinite distance, linear */
  background: THREE.Color;
  /** exposure applied */
  exposure: number;
}

const bgColor = new THREE.Color();

/**
 * Sets the water uniforms and the lights for one pass.
 * `viewScale` thins the water for the main view only; the feed passes 1. `fill` adds the deep's labelled overview
 * light (main view only). `depthRefY` is the world Y the exposure is set for (the seabed the view is looking at).
 */
export function applyPass(
  engine: FieldEngine,
  opts: { feed: boolean; viewScale: number; fill: boolean; depthRefY: number; cameraPos: Vec3; viewDistance: number; time: number },
): WaterPass {
  const env = engine.env;
  const c = engine.conditions;
  const lampEnv = env.light.source === "lamp";
  // the feed reads the water at the camera (a stratified lake's metalimnion included), the main view the mean water
  const optics = opts.feed ? pathOptics(env, c.turbidity, opts.cameraPos, [opts.cameraPos[0], opts.depthRefY, opts.cameraPos[2]]) : pathOptics(env, c.turbidity, [0, 0, 0], [0, 0, 0]);
  const spec = { ...env.water.optics, ntu: ntuAt(env, c.turbidity) };
  // pathOptics already folded the stratified layer in; express it back as an equivalent NTU for setWater
  const ntuEq = spec.ntu + (optics.c[1] - pathOptics(env, c.turbidity, [0, 0, 0], [0, 0, 0]).c[1]) / Math.max(1e-6, env.water.optics.cPerNtu);
  const daylight = WHITE_AT_FULL_LIGHT * (0.08 + 0.92 * c.lighting);
  const lampWhite = WHITE_AT_FULL_LIGHT * c.lighting;
  const lampMode = lampEnv && !opts.fill;
  // in fill mode the deep is lit from a notional surface a few metres above the site, so the overview reads
  const surfaceY = lampEnv && opts.fill ? site.maxY + 8 : 0;
  setWater(
    { ...spec, ntu: Math.max(0, ntuEq) },
    {
      white: lampEnv ? (opts.fill ? WHITE_AT_FULL_LIGHT * 0.35 : lampWhite) : daylight,
      surfaceY,
      lamp: lampMode,
      lampHeight: 1,
      // no extra column tint: the real depth below y = 0 attenuates the light per fragment
      columnM: surfaceY,
      box: fieldWaterBox,
    },
  );
  const u = waterUniforms;
  u.uWaterViewScale.value = opts.viewScale;
  // caustics are drawn by the seabed material at real-world scale, and only in shallow sunlit water
  u.uWaterCaustic.value = 0;
  const shallow = !lampEnv ? Math.max(0, -site.maxY) : Infinity;
  seabedUniforms.uFieldCaustic.value = env.id === "reef" || shallow < 4 ? 0.5 * daylight * Math.exp(-optics.b[1] * Math.max(0, -opts.depthRefY)) : 0;
  seabedUniforms.uFieldTime.value = opts.time;

  // exposure: for the seabed in view, as a camera on auto-exposure would
  let exposure: number;
  const kd = optics.kd;
  if (lampMode) {
    const d = Math.max(0.5, opts.viewDistance);
    // the lamps are the only light: the camera's white balance is applied through their colour
    // lamp to seabed (Kd) and seabed back to the lens (c): the colour cast the camera balances
    const g = kd.map((k) => Math.exp(-k * d));
    const cast = kd.map((k, i) => Math.exp(-(k + optics.c[i]) * d));
    const wb = cast.map((x) => Math.pow(Math.max(1e-6, x), -0.8));
    const top = Math.max(...wb);
    for (const sp of fieldLights.spots) sp.color.setRGB((LAMP_WHITE.r * wb[0]) / top, (LAMP_WHITE.g * wb[1]) / top, (LAMP_WHITE.b * wb[2]) / top, THREE.LinearSRGBColorSpace);
    exposure = 1 / Math.max(1e-6, lum(g.map((x, i) => (x * wb[i]) / top)));
  } else {
    for (const sp of fieldLights.spots) sp.color.copy(LAMP_WHITE);
    // the main view looks through the whole column at once: it exposes between the bright mid-water veil and the
    // seabed, so a deep, absorbing lake does not blow out; the camera feed exposes for the seabed it looks at
    const depth = Math.max(0, surfaceY - opts.depthRefY) * (opts.feed ? 1 : 0.85);
    // auto white balance, as an under-water camera does: the light reaching the seabed is blue-green, and the camera
    // takes back WHITE_BALANCE of that cast (in log space) through the light colour. Path attenuation and the veil
    // keep their colour, so distant water still reads as water.
    const g = kd.map((k) => Math.exp(-k * depth));
    // the deep's overview fill is a notional light: balanced fully, so the ooze reads in its own colour
    const tint = g.map((x) => Math.pow(Math.max(opts.feed ? 1e-4 : 0.01, x), opts.fill ? -1 : -WHITE_BALANCE));
    u.uWaterDepthTint.value.set(tint[0], tint[1], tint[2]);
    exposure = 1 / Math.max(1e-6, lum(g.map((x, i) => x * tint[i])));
  }
  if (opts.feed) {
    // frame mean: seabed through the water plus veil (the lab's auto-exposure, lib/sim/environments lightPaths)
    const d = Math.max(0.3, opts.viewDistance);
    const t = Math.exp(-optics.c[1] * d);
    const veilDepth = lampMode ? d / 2 : Math.max(0, -(opts.cameraPos[1] + opts.depthRefY) / 2);
    const objDepth = lampMode ? d : Math.max(0, -opts.depthRefY);
    const k = (optics.rInf[1] * Math.exp(-kd[1] * veilDepth)) / (env.seabed.reflectance * Math.exp(-kd[1] * objDepth));
    const lampFall = lampMode ? Math.min(1, (2.5 / d) ** 2) : 1;
    const mean = lampFall * t + k * (1 - t);
    exposure *= Math.min(lampMode ? 4 : 2.5, Math.max(1, 1 / Math.max(1e-3, mean)));
  }
  exposure = Math.min(400, exposure);
  u.uWaterExposure.value = exposure;
  u.uWaterLampPos.value.set(opts.cameraPos[0], opts.cameraPos[1], opts.cameraPos[2]);
  if (lampMode) {
    // the shared water model lights the veil by exp(-Kd r) from the lamp; a lamp's light also spreads with the
    // square of distance, so the scattering water in front of the camera is lit at about half the viewing range
    const mid = Math.max(0.6, Math.min(opts.viewDistance, 8) / 2);
    u.uWaterBinf.value.multiplyScalar(Math.min(1, (0.6 / mid) ** 2));
  }

  // lights
  const L = fieldLights;
  const k = 0.08 + 0.92 * c.lighting;
  L.sun.intensity = lampEnv ? 0 : 0.25 + 1.75 * c.lighting;
  L.hemi.intensity = lampEnv ? 0 : 0.9 * k;
  L.fill.intensity = lampEnv && opts.fill ? 2.2 : 0;

  // veil at infinite distance along a roughly horizontal ray from the camera, for the clear colour
  const binf = u.uWaterBinf.value;
  let lightAtCam: number[];
  if (lampMode) lightAtCam = kd.map((x) => Math.exp(-x * 6) * 0.02);
  else {
    const depth = Math.max(0, surfaceY - opts.cameraPos[1]);
    const tint = u.uWaterDepthTint.value;
    lightAtCam = [tint.x, tint.y, tint.z].map((ti, i) => ti * Math.exp(-kd[i] * depth) * 1.6);
  }
  bgColor.setRGB(binf.x * lightAtCam[0] * exposure, binf.y * lightAtCam[1] * exposure, binf.z * lightAtCam[2] * exposure, THREE.LinearSRGBColorSpace);
  return { optics, background: bgColor, exposure };
}

/** Lamp power for this pass: lamp environments use the lighting control, surface environments the lamp control. */
export function lampIntensity(engine: FieldEngine, depthY: number): number {
  const env = engine.env;
  const c = engine.conditions;
  const lampEnv = env.light.source === "lamp";
  const scale = Math.sqrt(engine.platform.lamps.lumens / 6000);
  if (lampEnv) return 30 * c.lighting * scale;
  // the water patch attenuates every light by the depth below the surface (daylight); a lamp's light did not come
  // from the surface, so its intensity carries that factor back out
  const o = pathOptics(env, c.turbidity, [0, depthY, 0], [0, depthY, 0]);
  const atDepth = lum(o.kd.map((x) => Math.exp(-x * Math.max(0, -depthY))));
  return (1.2 * c.lamps * scale) / Math.max(0.02, atDepth);
}
