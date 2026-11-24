"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useFieldStore, type ViewMode } from "@/lib/field/store";
import { ENVIRONMENT_LIBRARY } from "@/lib/world/environments";
import { terrainHeight } from "@/lib/world/terrain";
import type { FieldEnvironmentId } from "@/lib/world/schema";
import type { PlatformId } from "@/lib/platforms";
import { patchSceneWater, waterClock, waterTime, waterUniforms } from "@/components/lab/water";
import { buildAssets } from "./assets";
import { Disposables, FIELD_FEED_ELEMENT_ID, HUD_LAYER, VEHICLE_LAYER, WORLD_LAYER, measureFreeRect, measureOverviewRect, prefersReducedMotion, setLayer, useDeferredDispose, type FreeRect } from "./common";
import { applyPass, fieldFeedCam, fieldLights, fieldWaterBox, lampIntensity, placeLamps, poseCamera, rayToBed, site } from "./feed";
import { FieldParticles } from "./FieldParticles";
import { createHeadlights, type Headlights } from "./headlights";
import { FlowField, RouteAndTrail, SiteOutline, flowProbe } from "./FieldHud";
import { particleProbe } from "./FieldParticles";
import { buildTarget, inertLabelTexture, placeTarget } from "./targets";
import { buildSkirtGeometry, buildTerrainGeometry, seabedMaterial, seabedUniforms, skirtMaterial, surveyTerrain } from "./terrain";
import { swayUniforms } from "./assets";
import { createVehicleModel, type VehicleModel } from "./vehicles";
import { captureTarget, passControl, targetSync } from "./runtime";
import { probeTarget } from "./capture";

/*
 * The field world: one open-water site (terrain, scenery, targets, water, current), one platform, two render passes.
 * FieldDriver is the only loop that advances the simulation. Nothing here is the bench-top Gantry Lab.
 */

/** Draw calls and triangles of the last frame (main + feed pass), for profiling and tests. */
export const fieldStats = { calls: 0, triangles: 0, mainCalls: 0, feedCalls: 0, fps: 0 };

/** Live state shared between the camera rig, the passes and the capture. */
export const viewState = {
  /** world point the main view is looking at, for its exposure and water thinning */
  focus: new THREE.Vector3(),
  /** distance from the main camera to its focus */
  distance: 10,
  /** water thinning applied to the main pass this frame (1 = true water) */
  viewScale: 1,
  fillOn: false,
  mainUnderwater: false,
};

/* ---------- driver ---------- */

/**
 * Frame time as the display shows it. The raw frame time is read when the callback happens to run, which jitters by
 * milliseconds against the display and reads as judder; a smoothed one advances evenly, and a small correction keeps it
 * locked to the wall clock so the simulation never drifts.
 */
export const pace = { step: 1 / 60, lag: 0, smooth: 1 / 60 };
function advancePace(dt: number): number {
  // a stall (tab switch, shader compile) is passed on as it is and forgets the history
  if (dt > 0.1) {
    pace.smooth = 1 / 60;
    pace.lag = 0;
    return (pace.step = dt);
  }
  pace.smooth += (dt - pace.smooth) * 0.08;
  pace.lag += dt;
  pace.step = Math.max(0, pace.smooth + (pace.lag - pace.smooth) * 0.06);
  pace.lag -= pace.step;
  return pace.step;
}

function FieldDriver() {
  const acc = useRef(0);
  const fpsAcc = useRef({ t: 0, n: 0 });
  useFrame((_, dt) => {
    const s = useFieldStore.getState();
    s.engine.tick(advancePace(dt));
    acc.current += dt;
    if (acc.current >= 1 / 15) {
      acc.current = 0;
      s.publish();
    }
    const f = fpsAcc.current;
    f.t += dt;
    f.n++;
    if (f.t >= 1) {
      fieldStats.fps = f.n / f.t;
      f.t = 0;
      f.n = 0;
    }
    waterUniforms.uWaterTime.value = waterTime(performance.now() / 1000);
    swayUniforms.uSwayTime.value = waterTime(performance.now() / 1000);
    const m = s.engine.current.mean();
    const sp = Math.hypot(m[0], m[2]);
    swayUniforms.uSwayDir.value.set(sp > 1e-6 ? (m[0] / sp) * Math.min(1, sp / 0.6) : 0, sp > 1e-6 ? (m[2] / sp) * Math.min(1, sp / 0.6) : 0);
    if (sp > 1e-6) seabedUniforms.uRippleDir.value.set(m[0] / sp, m[2] / sp);
  }, -1);
  return null;
}

/* ---------- world ---------- */

const SITE_FADE_MS = 220;

interface WorldKey {
  env: FieldEnvironmentId;
  platform: PlatformId;
}

/**
 * The site and its platform. Switching is seamless: the UI veils the view (store.worldReady false), the new world
 * mounts behind the veil, its materials get the water patch and compile with compileAsync, then the veil lifts.
 */
function World() {
  const env = useFieldStore((s) => s.envId);
  const platform = useFieldStore((s) => s.platformId);
  const [shown, setShown] = useState<WorldKey>({ env, platform });
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (env === shown.env && platform === shown.platform) {
      if (!useFieldStore.getState().worldReady) useFieldStore.getState().setWorldReady(true);
      return;
    }
    useFieldStore.getState().setWorldReady(false);
    const id = window.setTimeout(() => setShown({ env, platform }), SITE_FADE_MS);
    return () => window.clearTimeout(id);
  }, [env, platform, shown]);
  useEffect(() => {
    let cancelled = false;
    patchSceneWater(scene, HUD_LAYER);
    const reveal = () => !cancelled && requestAnimationFrame(() => requestAnimationFrame(() => !cancelled && useFieldStore.getState().setWorldReady(true)));
    gl.compileAsync(scene, camera).then(reveal, reveal);
    return () => {
      cancelled = true;
    };
  }, [shown, gl, scene, camera]);
  return <Site key={`${shown.env}`} envId={shown.env} platform={shown.platform} />;
}

function Site({ envId, platform }: { envId: FieldEnvironmentId; platform: PlatformId }) {
  const env = ENVIRONMENT_LIBRARY[envId];
  const built = useMemo(() => {
    const res = new Disposables();
    const info = surveyTerrain(env);
    const root = new THREE.Group();
    root.name = `field-site-${env.id}`;
    root.position.set(0, info.baseY, 0);
    const terrain = new THREE.Mesh(res.track(buildTerrainGeometry(env, info)), res.track(seabedMaterial(env)));
    terrain.name = "seabed";
    terrain.receiveShadow = true;
    root.add(terrain);
    const skirt = new THREE.Mesh(res.track(buildSkirtGeometry(env, info)), res.track(skirtMaterial(env)));
    skirt.name = "seabed-section";
    root.add(skirt);
    const assets = buildAssets(env, info.baseY);
    res.trackTree(assets);
    root.add(assets);
    const label = res.track(inertLabelTexture());
    const targets = new THREE.Group();
    targets.name = "targets";
    for (const t of env.targets) targets.add(buildTarget(t, label));
    res.trackTree(targets);
    root.add(targets);
    return { res, info, root, targets, dispose: () => res.dispose() };
  }, [env]);

  // site frame for the passes: water box over the whole site, seabed minimum to the surface
  useEffect(() => {
    const [ex, ez] = env.geometry.extentM;
    const bottom = built.info.minY - Math.max(1.5, (built.info.maxY - built.info.minY) * 0.6) - 1;
    fieldWaterBox.min.set(-ex / 2 - 0.5, bottom, -ez / 2 - 0.5);
    fieldWaterBox.max.set(ex / 2 + 0.5, 0, ez / 2 + 0.5);
    site.minY = built.info.minY;
    site.maxY = built.info.maxY;
    site.baseY = built.info.baseY;
    // the sun's shadow covers the site
    const sun = fieldLights.sun;
    const R = Math.hypot(ex, ez) / 2 + 2;
    const cam = sun.shadow.camera;
    cam.left = -R;
    cam.right = R;
    cam.top = R;
    cam.bottom = -R;
    cam.near = 1;
    cam.far = 4 * R + 80;
    cam.updateProjectionMatrix();
    sun.position.set(R * 0.6, built.info.maxY + 2 * R + 20, R * 0.9);
    sun.target.position.set(0, built.info.meanY, 0);
    sun.target.updateMatrixWorld();
  }, [built, env]);
  useDeferredDispose(built, built.dispose);

  const syncTargets = useMemo(
    () => () => {
      const engine = useFieldStore.getState().engine;
      for (const g of built.targets.children) {
        const t = engine.targets.find((x) => x.id === g.userData.gtId);
        if (t) placeTarget(g, t, built.info.baseY);
      }
      built.targets.updateMatrixWorld(true);
    },
    [built],
  );
  // targets follow the engine every frame (free-floating debris drifts with the current)
  useFrame(() => {
    if (useFieldStore.getState().engine.env.id === env.id) syncTargets();
  });
  useEffect(() => {
    targetSync.fn = syncTargets;
    syncTargets();
    return () => {
      if (targetSync.fn === syncTargets) targetSync.fn = null;
    };
  }, [syncTargets]);

  return (
    <>
      <primitive object={built.root}>
        <Platform key={platform} platform={platform} baseY={built.info.baseY} envId={env.id as FieldEnvironmentId} />
        <FieldParticles density={env.particles.density} marineSnow={env.particles.marineSnow} />
        <FlowField env={env} baseY={built.info.baseY} />
        <RouteAndTrail env={env} baseY={built.info.baseY} />
        <SiteOutline env={env} baseY={built.info.baseY} minY={built.info.minY} />
      </primitive>
    </>
  );
}

/** Draws the platform at the engine's render pose; hidden while the engine already runs another world. */
function runPlatform(model: VehicleModel, platform: PlatformId, envId: FieldEnvironmentId, baseY: number, dt: number) {
  const engine = useFieldStore.getState().engine;
  const ok = engine.platform.id === platform && engine.env.id === envId;
  model.root.visible = ok;
  for (const e of model.extras) e.visible = ok;
  if (ok) model.update(engine, baseY, Math.min(dt, 0.1));
}

function Platform({ platform, baseY, envId }: { platform: PlatformId; baseY: number; envId: FieldEnvironmentId }) {
  const model = useMemo(() => {
    const m = createVehicleModel(platform);
    setLayer(m.root, VEHICLE_LAYER);
    for (const e of m.extras) setLayer(e, VEHICLE_LAYER);
    const res = new Disposables();
    res.trackTree(m.root);
    for (const e of m.extras) res.trackTree(e);
    return { ...m, dispose: () => res.dispose() };
  }, [platform]);
  useDeferredDispose(model, model.dispose);
  useFrame((_, dt) => runPlatform(model, platform, envId, baseY, dt));
  return (
    <>
      <primitive object={model.root} />
      {model.extras.map((e) => (
        <primitive key={e.uuid} object={e} />
      ))}
    </>
  );
}

/* ---------- lights ---------- */

/** Visible beams at the platform's lamp lights (main view only); updated by the passes right after the lamps move. */
let headlights: Headlights | null = null;

function Lights() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const L = fieldLights;
    const beams = createHeadlights(L.spots.length);
    headlights = beams;
    const objs = [L.sun, L.sun.target, L.hemi, L.fill, ...L.spots, ...L.spots.map((s) => s.target), beams.group];
    for (const o of objs) scene.add(o);
    return () => {
      for (const o of objs) scene.remove(o);
      if (headlights === beams) headlights = null;
      beams.dispose();
    };
  }, [scene]);
  return null;
}

/* ---------- camera rig ---------- */

const MAIN_FOV = 45;
/** Part of the canvas no panel covers: the follow view keeps the platform in it. */
let free: FreeRect | null = null;
/** Box centred on the window the overview and free views frame the site in. */
let centred: FreeRect | null = null;

function useFreeRect() {
  const exploring = useFieldStore((s) => s.exploring);
  useEffect(() => {
    const update = () => {
      const exploring = useFieldStore.getState().exploring;
      free = measureFreeRect(exploring);
      centred = measureOverviewRect(exploring);
    };
    update();
    const ro = new ResizeObserver(update);
    let raf = 0;
    const attach = () => {
      const els = ["header", "column", "card", "nav"].map((n) => document.querySelector(`[data-field="${n}"]`)).filter(Boolean) as Element[];
      if (els.length < 3) {
        raf = requestAnimationFrame(attach);
        return;
      }
      for (const el of els) ro.observe(el);
      update();
    };
    attach();
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [exploring]);
}

/** Live camera access for tests and dev tools. */
export const rigState = { controls: null as OrbitControlsImpl | null, view: "overview" as ViewMode, moving: false };

/** Keys that glide the orbit pivot over the site in the overview and free views: [right, forward, up]. */
const GLIDE_KEYS: Record<string, [number, number, number]> = {
  ArrowLeft: [-1, 0, 0],
  ArrowRight: [1, 0, 0],
  ArrowUp: [0, 1, 0],
  ArrowDown: [0, -1, 0],
  PageUp: [0, 0, 1],
  PageDown: [0, 0, -1],
};
/** Camera clearance above the seabed, m; the pivot itself may sit on the bed. */
const BED_CLEARANCE = 0.4;
/** How far past the site edge the pivot may roam, as a multiple of the half extent. */
const ROAM = 1.15;

interface Tween {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromT: THREE.Vector3;
  toT: THREE.Vector3;
  t: number;
  dur: number;
}

/**
 * The main view's camera logic, outside React: overview fit, eased moves, chase camera, pilot camera, the free-rect
 * view offset and the depth range.
 */
function createRig(reduced: boolean) {
  let tween: Tween | null = null;
  let controls: OrbitControlsImpl | null = null;
  // layout the last overview fit was made for; a panel or viewport change refits it
  let fitKey = "";
  const layoutKey = (width: number, height: number) => {
    const r = centred;
    return r ? `${width}x${height}:${Math.round(r.x0)},${Math.round(r.y0)},${Math.round(r.x1)},${Math.round(r.y1)}` : `${width}x${height}`;
  };
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();
  // the chase camera's own eased heading and aim: the hull may pitch, sway and bob, the picture does not
  const chase = { yaw: 0, look: new THREE.Vector3(), ready: false };
  // view offset actually applied, eased toward the free rect so panels showing or hiding never jolt the picture
  const offset = { x: 0, y: 0, ready: false };
  // keyboard glide: held keys and the eased pivot velocity, m/s along [right, forward, up] of the camera heading
  const glide = { held: new Set<string>(), vel: new THREE.Vector3(), want: new THREE.Vector3(), right: new THREE.Vector3(), fwd: new THREE.Vector3(), step: new THREE.Vector3() };
  const shift = new THREE.Vector3();
  /**
   * Keeps the free camera in the site: the pivot inside the roam box and between the seabed and a little above the
   * surface, the camera above the seabed. A pivot clamp moves the camera with it, so a clamp never rotates the view.
   */
  const confine = (camera: THREE.Camera, c: OrbitControlsImpl) => {
    const env = useFieldStore.getState().engine.env;
    const [ex, ez] = env.geometry.extentM;
    const hx = (ex / 2) * ROAM;
    const hz = (ez / 2) * ROAM;
    const bed = (x: number, z: number) => terrainHeight(env.geometry.terrain, Math.max(-ex / 2, Math.min(ex / 2, x)), Math.max(-ez / 2, Math.min(ez / 2, z)));
    const t = c.target;
    const tx = Math.max(-hx, Math.min(hx, t.x));
    const tz = Math.max(-hz, Math.min(hz, t.z));
    const ty = Math.max(bed(tx, tz), Math.min(site.maxY + 6, t.y));
    shift.set(tx - t.x, ty - t.y, tz - t.z);
    if (shift.lengthSq() > 0) {
      t.add(shift);
      camera.position.add(shift);
    }
    const cp = camera.position;
    // under the surface the camera stays inside the site, never in the cut-away terrain skirt around it
    if (cp.y < 0) {
      cp.x = Math.max(-ex / 2, Math.min(ex / 2, cp.x));
      cp.z = Math.max(-ez / 2, Math.min(ez / 2, cp.z));
    }
    const floor = bed(cp.x, cp.z) + BED_CLEARANCE;
    if (cp.y < floor) cp.y = floor;
  };
  const rig = {
    /** Arrow keys and PageUp/PageDown held down; the frame loop turns them into an eased glide. Returns whether the key is one. */
    holdKey(key: string, down: boolean) {
      if (!(key in GLIDE_KEYS)) return false;
      if (down) glide.held.add(key);
      else glide.held.delete(key);
      return true;
    },
    releaseKeys() {
      glide.held.clear();
    },
    /** A user orbit, pan, zoom or glide stops any programmatic move: the camera is theirs. */
    cancelTween() {
      tween = null;
    },
    attach(c: OrbitControlsImpl | null) {
      controls = c;
      rigState.controls = c;
    },
    moveTo(camera: THREE.Camera, to: THREE.Vector3, toT: THREE.Vector3, instant: boolean) {
      if (!controls) return;
      if (instant || reduced) {
        camera.position.copy(to);
        controls.target.copy(toT);
        controls.update();
        tween = null;
        return;
      }
      tween = { from: camera.position.clone(), to, fromT: controls.target.clone(), toT, t: 0, dur: 0.7 };
    },
    /** Fits the whole site into the part of the canvas no panel covers. */
    fitOverview(camera: THREE.Camera, width: number, height: number, instant: boolean) {
      const env = useFieldStore.getState().engine.env;
      const [ex, ez] = env.geometry.extentM;
      const target = new THREE.Vector3(0, (site.minY + site.maxY) / 2, 0);
      const r = centred ?? { x0: 0, y0: 0, x1: width, y1: height };
      const fh = Math.max(80, r.y1 - r.y0) / height;
      const fw = Math.max(80, r.x1 - r.x0) / width;
      const dir = new THREE.Vector3(0.42, 0.78, 1).normalize();
      const radius = 0.5 * Math.hypot(ex, ez * 0.75, site.maxY - site.minY + 2);
      const tanV = Math.tan((MAIN_FOV * Math.PI) / 360);
      const tanH = tanV * (width / height);
      const dist = radius / Math.min(tanV * fh, tanH * fw);
      fitKey = layoutKey(width, height);
      rig.moveTo(camera, target.clone().addScaledVector(dir, dist), target, instant);
    },
    /** Double-click: orbit around the clicked point (enters the free view). */
    focusAt(camera: THREE.Camera, scene: THREE.Scene, ndc: THREE.Vector2) {
      const s = useFieldStore.getState();
      if (!controls || s.view === "pilot" || s.view === "follow") return;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      ray.layers.set(WORLD_LAYER);
      const hit = ray.intersectObjects(scene.children, true).find((h) => h.object.visible && (h.object as THREE.Mesh).isMesh);
      if (!hit) return;
      const d = Math.max(2, camera.position.distanceTo(controls.target) * 0.45);
      const dir = camera.position.clone().sub(controls.target).normalize();
      if (s.view !== "free") s.setView("free");
      rig.moveTo(camera, hit.point.clone().addScaledVector(dir, d), hit.point.clone(), false);
    },
    frame(camera: THREE.PerspectiveCamera, width: number, height: number, dt: number) {
      const s = useFieldStore.getState();
      const engine = s.engine;
      const v = s.view;
      const c = controls;
      rigState.moving = !!tween;
      const orbiting = v === "overview" || v === "free";
      if (c) {
        c.enabled = orbiting;
        // pan and zoom toward the cursor in both orbit views; the first gesture hands the camera to the free view
        c.enablePan = orbiting;
        c.zoomToCursor = orbiting;
        c.screenSpacePanning = true;
        // below the horizon is allowed (look up at a hull or a pier from the bed); confine() keeps the camera above it
        c.maxPolarAngle = Math.PI * 0.94;
        c.enableDamping = !reduced;
        c.dampingFactor = 1 - Math.pow(1 - 0.14, Math.min(4, dt * 60));
      }
      if (!orbiting) glide.vel.set(0, 0, 0);
      if (v !== "follow") chase.ready = false;
      if (v === "pilot") {
        // through the platform camera itself: same pose and vertical field of view, canvas aspect
        const pose = engine.cameraPose(true);
        camera.clearViewOffset();
        const aspect = width / height;
        const hfov = (2 * Math.atan((Math.tan((pose.hfovDeg * Math.PI) / 360) / pose.aspect) * aspect) * 180) / Math.PI;
        poseCamera(camera, { ...pose, aspect, hfovDeg: hfov });
        camera.near = 0.05;
        camera.far = 200;
        camera.updateProjectionMatrix();
        camera.layers.disable(VEHICLE_LAYER);
        camera.layers.disable(HUD_LAYER);
        viewState.focus.set(pose.position[0] + pose.forward[0] * 2, pose.position[1] + pose.forward[1] * 2, pose.position[2] + pose.forward[2] * 2);
        viewState.distance = 2;
        return;
      }
      camera.layers.enable(VEHICLE_LAYER);
      camera.layers.enable(HUD_LAYER);
      camera.fov = MAIN_FOV;
      camera.up.set(0, 1, 0);
      if (v === "follow") {
        // chase camera behind and above the platform, smoothed independently of the frame rate
        const pose = engine.renderPose();
        const fwd = engine.cameraPose(true).forward;
        const p = pose.position;
        // a downward camera has no horizontal forward: use the hull's
        const hf = Math.hypot(fwd[0], fwd[2]) > 0.2 ? fwd : engine.forward();
        const yaw = Math.atan2(hf[2], hf[0]);
        const back = engine.vehicle ? (engine.platform.id === "auv" ? 4.5 : 2.6) : 3.2;
        // entering the view, or a new site or reset, starts in place instead of flying across the world
        const jump = !chase.ready || chase.look.distanceTo(look.set(p[0], p[1], p[2])) > 12;
        const step = Math.min(dt, 0.1);
        chase.yaw = jump || reduced ? yaw : chase.yaw + Math.atan2(Math.sin(yaw - chase.yaw), Math.cos(yaw - chase.yaw)) * (1 - Math.exp(-step * 2.6));
        const cx = Math.cos(chase.yaw);
        const cz = Math.sin(chase.yaw);
        look.set(p[0] + cx * 1.2, p[1] + (engine.vehicle ? 0 : 1.0), p[2] + cz * 1.2);
        if (jump || reduced) chase.look.copy(look);
        else {
          // tight along the ground so the platform stays framed, soft vertically so bobbing does not shake the picture
          const kh = 1 - Math.exp(-step * 9);
          chase.look.x += (look.x - chase.look.x) * kh;
          chase.look.z += (look.z - chase.look.z) * kh;
          chase.look.y += (look.y - chase.look.y) * (1 - Math.exp(-step * 3));
        }
        chase.ready = true;
        desired.set(chase.look.x - cx * (back + 1.2), chase.look.y + back * 0.55 + (engine.vehicle ? 0 : 0.2), chase.look.z - cz * (back + 1.2));
        // inside the site, above the bed and what stands on it, below the surface
        const [ex, ez] = engine.env.geometry.extentM;
        desired.x = Math.max(-ex / 2 + 0.3, Math.min(ex / 2 - 0.3, desired.x));
        desired.z = Math.max(-ez / 2 + 0.3, Math.min(ez / 2 - 0.3, desired.z));
        desired.y = Math.min(-0.15, Math.max(desired.y, engine.floor(desired.x, desired.z) + BED_CLEARANCE));
        camera.position.copy(desired);
        camera.lookAt(chase.look);
        viewState.focus.copy(chase.look);
        viewState.distance = camera.position.distanceTo(chase.look);
      } else if (c) {
        if (v === "overview" && fitKey && layoutKey(width, height) !== fitKey) rig.fitOverview(camera, width, height, false);
        // keyboard glide: pivot and camera translate together, at a speed scaled to the view distance
        let ix = 0;
        let iy = 0;
        let iz = 0;
        for (const k of glide.held) {
          const g = GLIDE_KEYS[k];
          ix += g[0];
          iy += g[1];
          iz += g[2];
        }
        if (ix || iy || iz) {
          tween = null;
          if (v === "overview") useFieldStore.getState().setView("free");
        }
        const speed = Math.max(1.5, camera.position.distanceTo(c.target) * 0.7);
        const kv = reduced ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 8);
        glide.vel.lerp(glide.want.set(ix, iy, iz).normalize().multiplyScalar(speed), kv);
        if (glide.vel.lengthSq() > 1e-6) {
          glide.fwd.subVectors(c.target, camera.position).setY(0);
          if (glide.fwd.lengthSq() < 1e-8) glide.fwd.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
          glide.fwd.normalize();
          glide.right.set(-glide.fwd.z, 0, glide.fwd.x);
          glide.step
            .copy(glide.right)
            .multiplyScalar(glide.vel.x)
            .addScaledVector(glide.fwd, glide.vel.y)
            .addScaledVector(THREE.Object3D.DEFAULT_UP, glide.vel.z)
            .multiplyScalar(Math.min(dt, 0.1));
          camera.position.add(glide.step);
          c.target.add(glide.step);
        } else glide.vel.set(0, 0, 0);
        if (tween) {
          tween.t = Math.min(1, tween.t + dt / tween.dur);
          const e = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
          camera.position.lerpVectors(tween.from, tween.to, e);
          c.target.lerpVectors(tween.fromT, tween.toT, e);
          if (tween.t >= 1) tween = null;
        }
        c.update();
        if (!tween) confine(camera, c);
        viewState.focus.copy(c.target);
        viewState.distance = camera.position.distanceTo(c.target);
      }
      // overview and free: the site sits in the middle of the window; follow: the platform sits where no panel covers it
      const r = orbiting ? centred : free;
      if (r && width > 0) {
        const ox = width / 2 - (r.x0 + r.x1) / 2;
        const oy = height / 2 - (r.y0 + r.y1) / 2;
        const ko = !offset.ready || reduced ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 7);
        offset.x += (ox - offset.x) * ko;
        offset.y += (oy - offset.y) * ko;
        if (Math.abs(ox - offset.x) + Math.abs(oy - offset.y) < 0.05) {
          offset.x = ox;
          offset.y = oy;
        }
        offset.ready = true;
        camera.setViewOffset(width, height, offset.x, offset.y, width, height);
      } else camera.clearViewOffset();
      // near and far follow the distance so the depth buffer keeps its precision on a 240 m site
      const dist = viewState.distance;
      camera.near = Math.max(0.03, Math.min(2, dist * 0.004));
      camera.far = Math.max(150, dist * 6 + 400);
      camera.updateProjectionMatrix();
    },
  };
  return rig;
}

function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, gl, scene, size } = useThree();
  const view = useFieldStore((s) => s.view);
  const envId = useFieldStore((s) => s.envId);
  const worldReady = useFieldStore((s) => s.worldReady);
  const viewEpoch = useFieldStore((s) => s.viewEpoch);
  const rig = useMemo(() => createRig(prefersReducedMotion()), []);
  useFreeRect();

  useEffect(() => {
    rig.attach(controls.current);
  });

  // refit the overview when the site, the view, the readiness or the canvas size changes
  useEffect(() => {
    rigState.view = view;
    if (view === "overview") rig.fitOverview(camera, size.width, size.height, !worldReady);
  }, [rig, camera, view, envId, worldReady, size.width, size.height, viewEpoch]);

  // The first orbit, pan or zoom in the overview hands the camera to the free view, so a later layout refit of the
  // overview never pulls it back; any gesture also stops a programmatic move that is still running.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const onStart = () => {
      rig.cancelTween();
      const s = useFieldStore.getState();
      if (s.view === "overview") s.setView("free");
    };
    c.addEventListener("start", onStart);
    return () => c.removeEventListener("start", onStart);
  }, [rig]);

  // Arrow keys glide the pivot over the site, PageUp and PageDown raise and lower it. Fields and sliders keep their keys.
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || t.getAttribute("role") === "slider");
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = useFieldStore.getState().view;
      if (v !== "overview" && v !== "free") return;
      if (rig.holdKey(e.key, true)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      rig.holdKey(e.key, false);
    };
    const blur = () => rig.releaseKeys();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [rig]);

  useEffect(() => {
    const el = gl.domElement;
    const onDbl = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      rig.focusAt(camera, scene, new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1));
    };
    el.addEventListener("dblclick", onDbl);
    return () => el.removeEventListener("dblclick", onDbl);
  }, [rig, gl, camera, scene]);

  useFrame((state) => rig.frame(state.camera as THREE.PerspectiveCamera, state.size.width, state.size.height, pace.step), -0.5);

  return <OrbitControls ref={controls} makeDefault enableDamping minDistance={0.6} maxDistance={900} zoomSpeed={1.1} rotateSpeed={0.75} panSpeed={1} />;
}

/* ---------- render passes ---------- */

/** How much brighter the platform's lamps are drawn in the main view (not the pilot view, never the camera feed). */
export const HEADLIGHT_AID = { lamp: 6, daylight: 4 };

/**
 * The sun's shadow map only changes when the site changes or a drifting target moves, and it is not used at all where
 * the sun is off (the lamp-lit deep). Redrawing it, a second pass over every caster, each frame cost as much as the
 * view itself; it is redrawn at 10 Hz while the sun is up and for a few frames on a world or light change.
 */
const SHADOW_HZ = 10;
const shadowClock = { env: "", sun: false, last: -Infinity, settle: 0 };
function shadowDue(envId: string, now: number): boolean {
  const sun = fieldLights.sun.intensity > 0;
  const c = shadowClock;
  if (envId !== c.env || sun !== c.sun) {
    c.env = envId;
    c.sun = sun;
    // a new world settles (targets placed, shadow camera fitted) over its first frames
    c.settle = 8;
  }
  // the settle frames draw it even with the sun off: the map must exist, or every lit shader samples an unbound texture
  if (c.settle > 0 || (sun && (now - c.last >= 1 / SHADOW_HZ || now < c.last))) {
    c.settle = Math.max(0, c.settle - 1);
    c.last = now;
    return true;
  }
  return false;
}

interface FeedRect {
  el: HTMLElement | null;
  rect: DOMRect | null;
  dirty: boolean;
  ro: ResizeObserver | null;
}

function Passes() {
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
    const s = useFieldStore.getState();
    const engine = s.engine;
    const pr = gl.getPixelRatio();
    const canvas = gl.domElement;
    const fullW = canvas.clientWidth * pr;
    const fullH = canvas.clientHeight * pr;
    const time = waterTime(state.clock.elapsedTime);
    patchSceneWater(scene, HUD_LAYER);
    scene.fog = null;

    // platform camera pose (also used by particles and lamps)
    const pose = engine.cameraPose(true);
    poseCamera(fieldFeedCam, pose);
    const rp = engine.renderPose();
    const altitudeHit = rayToBed(engine, pose.position, pose.forward, 60);
    const feedDist = altitudeHit ?? Math.min(60, engine.visibility() * 1.5);
    const bedAhead = pose.position[1] + pose.forward[1] * feedDist;
    placeLamps(engine, rp as { position: [number, number, number]; attitude: [number, number, number, number] }, pose, 0, lampIntensity(engine, pose.position[1]));
    if (headlights) {
      const level = engine.env.light.source === "lamp" ? engine.conditions.lighting : engine.conditions.lamps;
      headlights.update(engine, fieldLights.spots, level, Math.max(0, Math.min(1, 1 - engine.visibility() / 15)));
    }

    // MAIN PASS
    const pilot = s.view === "pilot";
    const vis = engine.visibility();
    const focus = viewState.focus;
    // thinning: far side of the view at about one attenuation length, so the whole site reads; never in the pilot view
    const span = viewState.distance + (s.view === "overview" ? Math.max(...engine.env.geometry.extentM) * 0.5 : 4);
    const thin = !pilot && s.overviewThinning ? Math.min(1, (0.9 * vis) / (Math.log(50) * Math.max(1, span) * 0.35)) : 1;
    viewState.viewScale = thin;
    const lampEnv = engine.env.light.source === "lamp";
    viewState.fillOn = lampEnv && !pilot;
    const mainUnder = camera.position.y < 0 && camera.position.y > fieldWaterBox.min.y;
    viewState.mainUnderwater = mainUnder;
    const mainPass = pilot
      ? applyPass(engine, { feed: true, viewScale: 1, fill: false, depthRefY: bedAhead, cameraPos: pose.position, viewDistance: feedDist, time })
      : applyPass(engine, { feed: false, viewScale: thin, fill: viewState.fillOn, depthRefY: Math.min(focus.y, site.maxY), cameraPos: [camera.position.x, camera.position.y, camera.position.z], viewDistance: viewState.distance, time });
    const bg = scene.background;
    const mainBg = new THREE.Color("#0b1219");
    scene.background = (mainUnder && s.view === "follow") || pilot ? mainPass.background.clone() : mainBg;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = shadowDue(engine.env.id, state.clock.elapsedTime);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, fullW, fullH);
    waterUniforms.uWaterViewportH.value = fullH;
    // headlight aid: outside the pilot view the lamps compete with the overview's daylight or fill, so they are drawn
    // brighter there (labelled in the UI); the platform camera below sees their true power
    const aid = pilot ? 1 : lampEnv ? HEADLIGHT_AID.lamp : HEADLIGHT_AID.daylight;
    for (const sp of fieldLights.spots) sp.intensity *= aid;
    gl.render(scene, camera);
    for (const sp of fieldLights.spots) sp.intensity /= aid;
    fieldStats.mainCalls = gl.info.render.calls;
    fieldStats.triangles = gl.info.render.triangles;
    fieldStats.calls = fieldStats.mainCalls;
    scene.background = bg;

    fieldStats.feedCalls = 0;
    if (passControl.captureActive) return;
    // Explore hides the panels with visibility, which keeps the feed rect in layout; the feed must go with them.
    if (s.exploring) return;
    // FEED PASS into the DOM rect
    const f = feed.current;
    if (!f.el || !f.el.isConnected) {
      f.ro?.disconnect();
      f.ro = null;
      f.el = document.getElementById(FIELD_FEED_ELEMENT_ID);
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
    if (r.width < 4 || r.height < 4 || !s.worldReady) return;
    const cr = canvas.getBoundingClientRect();
    const x = Math.round((r.left - cr.left) * pr);
    const y = Math.round((cr.bottom - r.bottom) * pr);
    const w = Math.round(r.width * pr);
    const h = Math.round(r.height * pr);
    if (x + w <= 0 || y + h <= 0 || x >= fullW || y >= fullH) return;
    // the platform camera always sees true water and only the platform's own light
    const fp = applyPass(engine, { feed: true, viewScale: 1, fill: false, depthRefY: bedAhead, cameraPos: pose.position, viewDistance: feedDist, time });
    gl.setViewport(x, y, w, h);
    gl.setScissor(x, y, w, h);
    gl.setScissorTest(true);
    waterUniforms.uWaterViewportH.value = h;
    const prevBg = scene.background;
    scene.background = fp.background;
    gl.autoClear = false;
    gl.clear(true, true, false);
    gl.render(scene, fieldFeedCam);
    fieldStats.feedCalls = gl.info.render.calls;
    fieldStats.calls += fieldStats.feedCalls;
    fieldStats.triangles += gl.info.render.triangles;
    scene.background = prevBg;
    gl.autoClear = true;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, fullW, fullH);
  }, 1);
  return null;
}

/* ---------- adaptive resolution ---------- */

/** Pixel ratio steps the view may use; the top one is the display's own ratio, capped at 1.5. */
const DPR_MIN = 0.75;
const DPR_STEP = 0.25;

/**
 * Keeps the view at the display frame rate on a weak or busy GPU: when frames run long for a second, the canvas
 * renders fewer pixels; when they are short again for a few seconds, it steps back up. A step that had to be undone
 * holds the ratio down for a while, so it never oscillates.
 */
function AdaptiveResolution() {
  const setDpr = useThree((s) => s.setDpr);
  const st = useRef({ t: 0, n: 0, calm: 0, hold: 0, raisedAt: -Infinity });
  useFrame((state, dt) => {
    // a hidden tab, a world switch or a debugger pause is not the renderer being slow
    if (dt > 0.25 || !useFieldStore.getState().worldReady) return;
    const s = st.current;
    s.t += dt;
    s.n++;
    if (s.t < 1) return;
    const ms = (s.t / s.n) * 1000;
    s.t = 0;
    s.n = 0;
    const now = state.clock.elapsedTime;
    const max = Math.min(1.5, window.devicePixelRatio || 1);
    const dpr = state.viewport.dpr;
    if (ms > 22 && dpr > DPR_MIN) {
      if (now - s.raisedAt < 4) s.hold = now + 30;
      s.calm = 0;
      setDpr(Math.max(DPR_MIN, dpr - DPR_STEP));
    } else if (ms < 18.5 && dpr < max && now > s.hold) {
      if (++s.calm >= 3) {
        s.calm = 0;
        s.raisedAt = now;
        setDpr(Math.min(max, dpr + DPR_STEP));
      }
    } else s.calm = 0;
  });
  return null;
}

/* ---------- dev hooks ---------- */

function DevHooks() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    captureTarget.gl = gl;
    captureTarget.scene = scene;
    return () => {
      captureTarget.gl = null;
      captureTarget.scene = null;
    };
  }, [gl, scene]);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as Record<string, unknown>;
    w.__fieldStore = useFieldStore;
    w.__fieldScene = scene;
    w.__fieldFeedCam = fieldFeedCam;
    w.__fieldStats = fieldStats;
    w.__fieldCamera = { camera, rig: rigState, view: viewState };
    w.__fieldGl = gl;
    w.__fieldParticles = particleProbe;
    w.__fieldFlow = flowProbe;
    w.__fieldProbe = (id: string) => probeTarget(gl, scene, useFieldStore.getState().engine, id);
    w.__fieldFreezeWater = (t: number | null) => {
      waterClock.frozen = t;
    };
  }, [scene, camera, gl]);
  return null;
}

export function FieldScene() {
  return (
    <Canvas
      dpr={[1, 1.5]}
      shadows={{ type: THREE.PCFShadowMap }}
      frameloop="always"
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: MAIN_FOV, near: 0.05, far: 1200, position: [30, 25, 40] }}
    >
      <color attach="background" args={["#0b1219"]} />
      <FieldDriver />
      <CameraRig />
      <Lights />
      <World />
      <Passes />
      <AdaptiveResolution />
      <DevHooks />
    </Canvas>
  );
}
