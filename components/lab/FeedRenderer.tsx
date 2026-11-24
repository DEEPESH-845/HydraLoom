"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { CAMERA, gantryToWorld } from "@/lib/sim/constants";
import { FEED_ELEMENT_ID, useSimStore } from "@/lib/sim/store";
import { ENVIRONMENTS, environmentWater, lightPaths } from "@/lib/sim/environments";
import { TANK } from "@/lib/sim/constants";
import { OVERVIEW_FILL_INTENSITY, overviewFill } from "./TankDressing";
import { TANK_WATER_BOX, patchSceneWater, setWater, waterTime, waterUniforms } from "./water";
import { waterOptics } from "@/lib/optics/water";

/** HUD overlays live on this layer and are drawn on top of the world, so the water model skips them. */
const OVERLAY_LAYER = 2;

/**
 * Linear radiance of a white diffuse surface under the lab lights at full lighting, in the renderer's units.
 * Scales the veiling light so murky water is as bright as the lights that illuminate it.
 */
const WHITE_AT_FULL_LIGHT = 0.9;

/** Live draw call count of the last frame (main pass + feed pass), and GPU resources held, for profiling. */
export const renderStats = { calls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0 };

/**
 * Takes over the render loop: main pass to the full canvas, then the gantry camera
 * rendered into the screen rect of the DOM element with id FEED_ELEMENT_ID.
 * The feed camera matches lib/sim/detection.ts projectToFeed exactly:
 * lens at (wx, lensHeight, wz), looking straight down, up = (0, 0, -1).
 */
export const feedCam = (() => {
  const hfov = (CAMERA.hfovDeg * Math.PI) / 180;
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) / CAMERA.aspect);
  const cam = new THREE.PerspectiveCamera((vfov * 180) / Math.PI, CAMERA.aspect, 0.02, 3);
  cam.up.set(0, 0, -1);
  cam.layers.set(0); // mast and housing live on layer 1 and are excluded
  return cam;
})();
/** Colour the feed clears to: the veiling light, which is what an under-water camera sees at infinite range. */
export const feedBackground = new THREE.Color();

interface FeedRect {
  el: HTMLElement | null;
  rect: DOMRect | null;
  dirty: boolean;
  ro: ResizeObserver | null;
}

/**
 * Applies the lab water for the selected in-tank environment to the shared uniforms, with the rig lamps at the
 * carriage (world x, z of the lens). The same call drives the live render loop and the dataset capture.
 */
/** Water and light to render with. The live loop passes the scenario; the dataset capture passes its sweep values. */
export interface LabConditions {
  turbidity: number;
  lighting: number;
}

export function labWater(wx: number, wz: number, conditions?: LabConditions): { lamp: boolean } {
  const sc = useSimStore.getState().engine.scenario;
  const { environment } = sc;
  const { turbidity, lighting } = conditions ?? sc;
  const env = ENVIRONMENTS[environment];
  const lamp = env.light === "lamp";
  setWater(environmentWater(env, turbidity), {
    // lamps are sized for the floor at full power; daylight and the lab lights never go fully dark
    white: WHITE_AT_FULL_LIGHT * (lamp ? lighting : 0.08 + 0.92 * lighting),
    // every environment is emulated in the tank: its water, its floor, and its light at depth
    surfaceY: TANK.waterLevel,
    columnM: env.columnM,
    lamp,
    lampHeight: CAMERA.lensHeight,
    box: TANK_WATER_BOX,
  });
  waterUniforms.uWaterLampPos.value.set(wx, CAMERA.lensHeight + 0.02, wz);
  return { lamp };
}

/**
 * Switches the uniforms from the main view to the camera feed: true water, only the rig's own light, auto-exposure.
 * Sets `feedBackground` to the veiling light. Returns the main pass exposure so the caller can restore it.
 */
export function labFeedPass(conditions?: LabConditions): number {
  const sc = useSimStore.getState().engine.scenario;
  const { environment } = sc;
  const { turbidity } = conditions ?? sc;
  const env = ENVIRONMENTS[environment];
  const optics = waterOptics(environmentWater(env, turbidity));
  // the camera feed always sees true water and only the rig's own light
  waterUniforms.uWaterViewScale.value = 1;
  overviewFill.intensity = 0;
  // Auto-exposure, as the real camera does: expose for the mean of the frame (seabed seen through the water plus
  // veil), so murky water reads as a properly exposed murky image instead of a near-black one. Exposure scales the
  // whole frame, so contrast, and therefore detection, is unchanged.
  const mainExposure = waterUniforms.uWaterExposure.value;
  const d = CAMERA.lensHeight;
  const paths = lightPaths(env, 0, d);
  const t = Math.exp(-optics.c[1] * d);
  const k = (optics.rInf[1] * Math.exp(-optics.kd[1] * paths.veilDepthM)) / (env.seabedReflectance * Math.exp(-optics.kd[1] * paths.objectDepthM));
  const mean = t + k * (1 - t);
  waterUniforms.uWaterExposure.value = mainExposure * Math.min(4, Math.max(1, 1 / Math.max(1e-3, mean)));
  const binf = waterUniforms.uWaterBinf.value;
  const exposure = waterUniforms.uWaterExposure.value;
  feedBackground.setRGB(binf.x * exposure, binf.y * exposure, binf.z * exposure, THREE.LinearSRGBColorSpace);
  return mainExposure;
}

export function FeedRenderer() {
  // The feed element's rect is cached and refreshed by ResizeObserver, window resize and scroll,
  // plus one re-read on the frame after any change, instead of a layout read every frame.
  const feed = useRef<FeedRect>({ el: null, rect: null, dirty: true, ro: null });

  useEffect(() => {
    const f = feed.current;
    const mark = () => {
      f.rect = f.el?.getBoundingClientRect() ?? null;
      f.dirty = true;
    };
    window.addEventListener("resize", mark);
    window.addEventListener("scroll", mark, true);
    return () => {
      window.removeEventListener("resize", mark);
      window.removeEventListener("scroll", mark, true);
      f.ro?.disconnect();
      f.ro = null;
      f.el = null;
    };
  }, []);

  useFrame((state) => {
    const { gl, scene, camera } = state;
    const pr = gl.getPixelRatio();
    const canvas = gl.domElement;
    const fullW = canvas.clientWidth * pr;
    const fullH = canvas.clientHeight * pr;

    // interpolated between simulation substeps so the carriage, lamps and feed glide at any display rate
    const pose = useSimStore.getState().engine.renderPose();
    const [wx, wz] = gantryToWorld(pose.x, pose.y);
    // One physical water model for both passes: components/lab/water.ts. Patching is idempotent and cheap,
    // and picks up meshes that mount later (scenario objects, a newly selected environment).
    patchSceneWater(scene, OVERLAY_LAYER);
    const { lamp } = labWater(wx, wz);
    waterUniforms.uWaterTime.value = waterTime(state.clock.elapsedTime);
    // the tank is always shown as it is
    const viewScale = 1;
    waterUniforms.uWaterViewScale.value = viewScale;
    // the deep's overview fill lights the main pass only
    overviewFill.intensity = lamp ? OVERVIEW_FILL_INTENSITY : 0;
    scene.fog = null;

    // Shadow maps are rendered once per frame, in the main pass only.
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, fullW, fullH);
    waterUniforms.uWaterViewportH.value = fullH;
    gl.render(scene, camera);
    renderStats.calls = gl.info.render.calls;
    renderStats.triangles = gl.info.render.triangles;
    renderStats.geometries = gl.info.memory.geometries;
    renderStats.textures = gl.info.memory.textures;
    renderStats.programs = gl.info.programs?.length ?? 0;

    // Explore mode hides the panels with visibility, which keeps the feed rect in layout; the feed must go with them.
    if (useSimStore.getState().exploring) return;

    const f = feed.current;
    if (!f.el || !f.el.isConnected) {
      f.ro?.disconnect();
      f.ro = null;
      f.el = document.getElementById(FEED_ELEMENT_ID);
      f.rect = null;
      if (!f.el) return;
      f.ro = new ResizeObserver(() => {
        f.rect = f.el?.getBoundingClientRect() ?? null;
        f.dirty = true;
      });
      f.ro.observe(f.el);
      f.dirty = true;
    }
    if (f.dirty || !f.rect) {
      f.rect = f.el.getBoundingClientRect();
      f.dirty = false;
    }
    const r = f.rect;
    if (r.width < 4 || r.height < 4) return;
    const c = canvas.getBoundingClientRect();
    const x = Math.round((r.left - c.left) * pr);
    const y = Math.round((c.bottom - r.bottom) * pr);
    const w = Math.round(r.width * pr);
    const h = Math.round(r.height * pr);
    if (x + w <= 0 || y + h <= 0 || x >= fullW || y >= fullH) return;

    feedCam.position.set(wx, CAMERA.lensHeight, wz);
    feedCam.lookAt(wx, 0, wz);

    const mainExposure = labFeedPass();
    gl.setViewport(x, y, w, h);
    waterUniforms.uWaterViewportH.value = h;
    gl.setScissor(x, y, w, h);
    gl.setScissorTest(true);
    // A Color background forces a clear inside the scissor rect, so swap it for the veiling light.
    const bg = scene.background;
    scene.background = feedBackground;
    gl.autoClear = false;
    gl.clear(true, true, false);
    gl.render(scene, feedCam);
    renderStats.calls += gl.info.render.calls;
    renderStats.triangles += gl.info.render.triangles;
    scene.background = bg;
    waterUniforms.uWaterViewScale.value = viewScale;
    waterUniforms.uWaterExposure.value = mainExposure;
    gl.autoClear = true;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, fullW, fullH);
  }, 1);

  return null;
}
