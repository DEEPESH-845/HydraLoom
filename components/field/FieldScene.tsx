"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useFieldStore, type ViewMode } from "@/lib/field/store";
import { ENVIRONMENT_LIBRARY } from "@/lib/world/environments";
import type { FieldEnvironmentId } from "@/lib/world/schema";
import type { PlatformId } from "@/lib/platforms";
import { patchSceneWater, waterClock, waterTime, waterUniforms } from "@/components/lab/water";
import { buildAssets } from "./assets";
import { Disposables, FIELD_FEED_ELEMENT_ID, HUD_LAYER, VEHICLE_LAYER, WORLD_LAYER, measureFreeRect, prefersReducedMotion, setLayer, useDeferredDispose, type FreeRect } from "./common";
import { applyPass, fieldFeedCam, fieldLights, fieldWaterBox, lampIntensity, placeLamps, poseCamera, rayToBed, site } from "./feed";
import { FieldParticles } from "./FieldParticles";
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

function FieldDriver() {
  const acc = useRef(0);
  const fpsAcc = useRef({ t: 0, n: 0 });
  useFrame((_, dt) => {
    const s = useFieldStore.getState();
    s.engine.tick(dt);
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

function Lights() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const L = fieldLights;
    const objs = [L.sun, L.sun.target, L.hemi, L.fill, ...L.spots, ...L.spots.map((s) => s.target)];
    for (const o of objs) scene.add(o);
    return () => {
      for (const o of objs) scene.remove(o);
    };
  }, [scene]);
  return null;
}

/* ---------- camera rig ---------- */

const MAIN_FOV = 45;
let free: FreeRect | null = null;

function useFreeRect() {
  useEffect(() => {
    const update = () => {
      free = measureFreeRect();
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
  }, []);
}

/** Live camera access for tests and dev tools. */
export const rigState = { controls: null as OrbitControlsImpl | null, view: "overview" as ViewMode, moving: false };

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
    const r = free;
    return r ? `${width}x${height}:${Math.round(r.x0)},${Math.round(r.y0)},${Math.round(r.x1)},${Math.round(r.y1)}` : `${width}x${height}`;
  };
  const desired = new THREE.Vector3();
  const look = new THREE.Vector3();
  const rig = {
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
      tween = { from: camera.position.clone(), to, fromT: controls.target.clone(), toT, t: 0, dur: 0.9 };
    },
    /** Fits the whole site into the part of the canvas no panel covers. */
    fitOverview(camera: THREE.Camera, width: number, height: number, instant: boolean) {
      const env = useFieldStore.getState().engine.env;
      const [ex, ez] = env.geometry.extentM;
      const target = new THREE.Vector3(0, (site.minY + site.maxY) / 2, 0);
      const r = free ?? { x0: 0, y0: 0, x1: width, y1: height };
      const fh = Math.max(80, r.y1 - r.y0) / height;
      const fw = Math.max(80, r.x1 - r.x0) / width;
      const dir = new THREE.Vector3(0.42, 0.78, 1).normalize();
      const radius = 0.5 * Math.hypot(ex, ez * 0.75, site.maxY - site.minY + 2);
      const tanV = Math.tan((MAIN_FOV * Math.PI) / 360);
      const tanH = tanV * (width / height);
      const dist = (radius * 0.8) / Math.min(tanV * fh, tanH * fw);
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
      if (c) {
        c.enabled = v === "overview" || v === "free";
        c.enablePan = v === "free";
        c.enableDamping = !reduced;
        c.dampingFactor = 1 - Math.pow(1 - 0.08, Math.min(4, dt * 60));
      }
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
        const h = Math.hypot(fwd[0], fwd[2]) || 1;
        const p = pose.position;
        const back = engine.vehicle ? (engine.platform.id === "auv" ? 4.5 : 2.6) : 3.2;
        desired.set(p[0] - (fwd[0] / h) * back, p[1] + back * 0.55 + (engine.vehicle ? 0 : 1.2), p[2] - (fwd[2] / h) * back);
        look.set(p[0] + (fwd[0] / h) * 1.2, p[1] + (engine.vehicle ? 0 : 1.0), p[2] + (fwd[2] / h) * 1.2);
        const k = reduced ? 1 : 1 - Math.exp(-dt * 5);
        if (camera.position.distanceTo(desired) > 30) camera.position.copy(desired);
        else camera.position.lerp(desired, k);
        camera.lookAt(look);
        viewState.focus.copy(look);
        viewState.distance = camera.position.distanceTo(look);
      } else if (c) {
        if (v === "overview" && fitKey && layoutKey(width, height) !== fitKey) rig.fitOverview(camera, width, height, false);
        if (tween) {
          tween.t = Math.min(1, tween.t + dt / tween.dur);
          const e = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
          camera.position.lerpVectors(tween.from, tween.to, e);
          c.target.lerpVectors(tween.fromT, tween.toT, e);
          if (tween.t >= 1) tween = null;
        }
        c.update();
        viewState.focus.copy(c.target);
        viewState.distance = camera.position.distanceTo(c.target);
      }
      // centre the projection in the part of the canvas no panel covers
      const r = free;
      if (r && width > 0) camera.setViewOffset(width, height, width / 2 - (r.x0 + r.x1) / 2, height / 2 - (r.y0 + r.y1) / 2, width, height);
      else camera.clearViewOffset();
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
  const rig = useMemo(() => createRig(prefersReducedMotion()), []);
  useFreeRect();

  useEffect(() => {
    rig.attach(controls.current);
  });

  // refit the overview when the site, the view, the readiness or the canvas size changes
  useEffect(() => {
    rigState.view = view;
    if (view === "overview") rig.fitOverview(camera, size.width, size.height, !worldReady);
  }, [rig, camera, view, envId, worldReady, size.width, size.height]);

  useEffect(() => {
    const el = gl.domElement;
    const onDbl = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      rig.focusAt(camera, scene, new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1));
    };
    el.addEventListener("dblclick", onDbl);
    return () => el.removeEventListener("dblclick", onDbl);
  }, [rig, gl, camera, scene]);

  useFrame((state, dt) => rig.frame(state.camera as THREE.PerspectiveCamera, state.size.width, state.size.height, dt), -0.5);

  return <OrbitControls ref={controls} makeDefault enableDamping minDistance={1} maxDistance={900} maxPolarAngle={Math.PI * 0.49} zoomSpeed={0.9} rotateSpeed={0.6} />;
}

/* ---------- render passes ---------- */

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
    gl.shadowMap.needsUpdate = true;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, fullW, fullH);
    waterUniforms.uWaterViewportH.value = fullH;
    gl.render(scene, camera);
    fieldStats.mainCalls = gl.info.render.calls;
    fieldStats.triangles = gl.info.render.triangles;
    fieldStats.calls = fieldStats.mainCalls;
    scene.background = bg;

    if (passControl.captureActive) return;
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
      <DevHooks />
    </Canvas>
  );
}
