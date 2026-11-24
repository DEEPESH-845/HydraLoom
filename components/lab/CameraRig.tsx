"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { CAMERA, GANTRY, TANK, gantryToWorld } from "@/lib/sim/constants";
import { useSimStore, type CameraPreset } from "@/lib/sim/store";
import { OVERHEAD_ARM_Y, OVERHEAD_LAYER, OVERHEAD_MAST_X, SHELF } from "./Electronics";
import { FOOT_HALF_H, FOOT_HALF_W } from "./Overlays";
import { type FreeRect, armOverlaySettle, freeRect, observeOverlay, refreshFreeRect } from "./util";

type V3 = [number, number, number];

/** Vertical FOV of the main camera, degrees. */
export const MAIN_FOV = 40;

/** Fraction of the fit rect the subject may fill; the rest is breathing room and keeps the perspective gentle. */
const FILL = 0.8;

/**
 * A preset is a view direction (from the subject toward the camera) plus the world points that must stay in the
 * free rect. Follow presets give points relative to the carriage reference point and move with it.
 */
interface Preset {
  dir: V3;
  points: V3[];
  follow?: boolean;
  /** never closer than this, so a low outside-the-glass shot cannot end up inside the tank */
  minDist?: number;
  /** hide the overhead ground-truth rig: it would sit between a top-down lens and the tank */
  hideOverhead?: boolean;
}

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): V3[] => [
  [x0, y0, z0],
  [x1, y0, z0],
  [x0, y1, z0],
  [x1, y1, z0],
  [x0, y0, z1],
  [x1, y0, z1],
  [x0, y1, z1],
  [x1, y1, z1],
];

const FRAME_TOP = GANTRY.railHeight + 0.12; // beam, Y motor and chains sit under this
const TABLE_TOP = -TANK.sandDepth - TANK.glass - 0.04;
const HOUSING_R = 0.03;

const PRESETS: Record<CameraPreset, Preset> = {
  // three-quarter overview from front right, about 21 degrees above the rim: tank on its table, gantry frame, electronics shelf
  // the overhead ground-truth mast and arm are part of the machine, so the frame includes their top
  A: {
    dir: [1.78, 0.95, 1.7],
    points: [...box(-0.66, SHELF.x1 + 0.01, TABLE_TOP, FRAME_TOP, -0.36, 0.37), [OVERHEAD_MAST_X, OVERHEAD_ARM_Y + 0.02, 0], [0, OVERHEAD_ARM_Y + 0.02, 0]],
  },
  // top-down, camera just off the +Z side so screen right = +X and screen down = +Z like the feed
  B: { dir: [0, 1, 0.012], hideOverhead: true, points: box(-0.66, 0.66, 0, FRAME_TOP, -0.37, 0.37) },
  // underwater side view through the +Z glass: the water volume
  C: { dir: [-0.35, 0.18, 1], points: box(-TANK.length / 2, TANK.length / 2, 0, TANK.waterLevel, -TANK.width / 2, TANK.width / 2) },
  // detection camera context: footprint, housing and carriage seen from the +Z side, steep enough to clear the
  // X cable chain and the +Z rail, with screen right = +world X exactly as in the feed
  D: {
    dir: [0, 1.35, 0.25],
    follow: true,
    points: [
      ...box(-FOOT_HALF_W, FOOT_HALF_W, 0, 0, -FOOT_HALF_H, FOOT_HALF_H),
      ...box(-HOUSING_R, HOUSING_R, CAMERA.lensHeight, CAMERA.lensHeight + 0.1, -HOUSING_R, HOUSING_R),
      ...box(-0.06, 0.03, GANTRY.railHeight + 0.09, GANTRY.railHeight + 0.09, -0.06, 0.06),
    ],
  },
  // just under the waterline outside the -Z glass: housing and the mirrored surface underside
  E: { dir: [0.42, -0.18, -0.55], follow: true, minDist: 0.72, points: box(-0.12, 0.12, CAMERA.lensHeight - 0.08, TANK.waterLevel + 0.1, -0.12, 0.12) },
};
export const INITIAL_CAMERA: V3 = [1.9, 1.35, 1.7];

// Camera moves are wall-clock: without this a slow frame makes GSAP step 33 ms per frame and a 1.4 s
// preset move can take tens of seconds on a struggling GPU.
gsap.ticker.lagSmoothing(0);

/** Carriage reference point: the lens, on the mast axis. */
function carriagePoint(out: THREE.Vector3) {
  const p = useSimStore.getState().engine.renderPose();
  const [wx, wz] = gantryToWorld(p.x, p.y);
  return out.set(wx, CAMERA.lensHeight, wz);
}

const fitCam = new THREE.PerspectiveCamera(MAIN_FOV, 1, 0.02, 40);

/** Orbit damping per frame at 60 Hz; CameraRig rescales it by the real frame time. */
const ORBIT_DAMPING_60HZ = 0.08;
const fv = new THREE.Vector3();
const fRight = new THREE.Vector3();
const fUp = new THREE.Vector3();

/**
 * Screen rect the subject is fitted into: centred on the frame horizontally (the model reads as the hero of the
 * page), centred vertically in the band between the header and the bottom card, and never wider than the nearest
 * side obstruction (scene rail, right column) allows. The card therefore never covers the subject.
 */
function fitRect(width: number, height: number) {
  const r = freeRect(width, height);
  const cx = width / 2;
  const cy = (r.y0 + r.y1) / 2;
  const hw = Math.min(cx - r.x0, r.x1 - cx);
  const hh = (r.y1 - r.y0) / 2;
  return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
}

/**
 * Places the camera along `dir` from `target` so every point projects inside the free rect, centred on it.
 * A few fixed-point iterations: shift the target by the bbox centre error, scale the distance by the
 * bbox size error. Deterministic for a given viewport, so a preset always ends in the same pose.
 */
function fit(
  preset: Preset,
  origin: THREE.Vector3 | null,
  width: number,
  height: number,
  outPos: THREE.Vector3,
  outTarget: THREE.Vector3,
  override?: { dir?: THREE.Vector3; rect?: FreeRect },
) {
  const rect = override?.rect ?? fitRect(width, height);
  const cx = (rect.x0 + rect.x1) / width - 1;
  const cy = 1 - (rect.y0 + rect.y1) / height;
  const hw = ((rect.x1 - rect.x0) / width) * FILL;
  const hh = ((rect.y1 - rect.y0) / height) * FILL;
  const dir = override?.dir ? override.dir.clone().normalize() : fv.set(...preset.dir).normalize().clone();
  const sx = origin && origin.x < 0 ? -1 : 1; // follow shots stand on the outer X side of the carriage
  if (!override?.dir) dir.x *= sx;
  const pts = preset.points.map(([x, y, z]) => (origin ? new THREE.Vector3(origin.x + x * sx, y, origin.z + z) : new THREE.Vector3(x, y, z)));

  outTarget.set(0, 0, 0);
  for (const p of pts) outTarget.add(p);
  outTarget.divideScalar(pts.length);
  let dist = 1;
  fitCam.aspect = width / height;
  fitCam.updateProjectionMatrix();
  const tanHalf = Math.tan((MAIN_FOV * Math.PI) / 360);
  for (let i = 0; i < 8; i++) {
    fitCam.position.copy(outTarget).addScaledVector(dir, dist);
    fitCam.lookAt(outTarget);
    fitCam.updateMatrixWorld();
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const p of pts) {
      fv.copy(p).project(fitCam);
      minX = Math.min(minX, fv.x);
      maxX = Math.max(maxX, fv.x);
      minY = Math.min(minY, fv.y);
      maxY = Math.max(maxY, fv.y);
    }
    const halfH = dist * tanHalf;
    fRight.setFromMatrixColumn(fitCam.matrixWorld, 0);
    fUp.setFromMatrixColumn(fitCam.matrixWorld, 1);
    outTarget.addScaledVector(fRight, ((minX + maxX) / 2 - cx) * halfH * fitCam.aspect).addScaledVector(fUp, ((minY + maxY) / 2 - cy) * halfH);
    dist = Math.max(preset.minDist ?? 0.25, dist * Math.max((maxX - minX) / 2 / hw, (maxY - minY) / 2 / hh));
  }
  outPos.copy(outTarget).addScaledVector(dir, dist);
}

/**
 * Screen rect for free exploration: the panels are hidden, so the machine gets the whole window below the header,
 * minus the explore hint strip at the bottom. Centred, so the orbit pivot sits in the middle of the screen.
 */
function exploreRect(width: number, height: number): FreeRect {
  const header = document.querySelector('[data-lab="header"]')?.getBoundingClientRect();
  const top = (header?.bottom ?? 48) + 12;
  const bottom = height - 84;
  const inset = Math.max(16, (width - 2 * Math.min(width / 2, 900)) / 2);
  // keep the band symmetric about the screen centre so the pivot lands mid-window
  const half = Math.min(height / 2 - top, bottom - height / 2);
  return { x0: inset, x1: width - inset, y0: height / 2 - half, y1: height / 2 + half };
}

/**
 * Drops any orbit velocity the damping still carries from the user's last drag. Without this the leftover delta keeps
 * rotating the camera while a preset or focus tween runs, and the move lands a few centimetres off its pose.
 */
function flushDamping(c: OrbitControlsImpl) {
  c.enableDamping = false;
  c.update();
  c.enableDamping = true;
}

export function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const preset = useSimStore((s) => s.cameraPreset);
  const viewEpoch = useSimStore((s) => s.viewEpoch);
  // bumps whenever the DOM overlay leaves a materially different free area (scene card height, compact layout, resize)
  const [layout, setLayout] = useState(0);
  useEffect(() => observeOverlay(() => setLayout((n) => n + 1)), []);
  // A scene change swaps the card even when the preset stays (04 to 06), so the overlay settles toward the new layout.
  const sceneId = useSimStore((s) => s.scene);
  useEffect(() => armOverlaySettle(), [sceneId]);
  const tween = useRef<gsap.core.Tween | null>(null);
  // Explore glide: eases the orbit pivot and distance toward the whole-machine framing while the user keeps orbiting.
  // `userZoom` is set by any wheel or pinch: from then on the distance is the user's and the glide only centres.
  const glide = useRef<{ target: THREE.Vector3; pos: THREE.Vector3; dir: THREE.Vector3; userZoom: boolean } | null>(null);
  const exploring = useSimStore((s) => s.exploring);
  // true while the user drags a pan (right button, modifier + left, two fingers): the pivot is theirs, the glide stops
  const panning = useRef(false);
  const following = useRef(false);
  const userMoved = useRef(false);
  const tmp = useMemo(
    () => ({
      anchor: new THREE.Vector3(),
      now: new THREE.Vector3(),
      delta: new THREE.Vector3(),
      fromPos: new THREE.Vector3(),
      fromTarget: new THREE.Vector3(),
      relPos: new THREE.Vector3(),
      relTarget: new THREE.Vector3(),
      endPos: new THREE.Vector3(),
      endTarget: new THREE.Vector3(),
    }),
    [],
  );

  useEffect(() => {
    camera.layers.enable(1); // mast and housing
    camera.layers.enable(2); // HUD overlays
    camera.layers.enable(OVERHEAD_LAYER); // overhead ground-truth rig, disabled by top-down presets
  }, [camera]);

  // Dev only: lets browser tests read the live camera pose and orbit target.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __labCamera?: { camera: THREE.Camera; controls: OrbitControlsImpl | null; tweening: () => boolean; presets: typeof PRESETS } };
    w.__labCamera = { camera, controls: controls.current, tweening: () => tween.current !== null, presets: PRESETS };
  }, [camera]);

  const lastPreset = useRef<CameraPreset | null>(null);
  const lastEpoch = useRef(0);
  const mountedAt = useRef(0);
  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const { width: W, height: H } = size;
    refreshFreeRect();
    // A resize or a card height change refits the preset unless the user has taken the camera; a preset change or a
    // recenter request always does.
    const recenter = viewEpoch !== lastEpoch.current;
    lastEpoch.current = viewEpoch;
    if (preset === lastPreset.current && userMoved.current && !recenter) return;
    // While exploring the explore glide owns the view; leaving explore bumps the epoch and refits the scene preset.
    if (useSimStore.getState().exploring) return;
    // the first fit, and any layout settling in the first second after mount, snaps instead of tweening
    const instant = lastPreset.current === null || performance.now() - mountedAt.current < 1000;
    lastPreset.current = preset;
    userMoved.current = false;
    tween.current?.kill();
    flushDamping(c);
    const p = PRESETS[preset];
    if (p.hideOverhead) camera.layers.disable(OVERHEAD_LAYER);
    else camera.layers.enable(OVERHEAD_LAYER);
    following.current = !!p.follow;
    const origin = p.follow ? carriagePoint(tmp.anchor) : null;
    fit(p, origin, W, H, tmp.endPos, tmp.endTarget);
    if (origin) {
      tmp.relPos.subVectors(tmp.endPos, origin);
      tmp.relTarget.subVectors(tmp.endTarget, origin);
    }
    if (instant) {
      camera.position.copy(tmp.endPos);
      c.target.copy(tmp.endTarget);
      return;
    }
    tmp.fromPos.copy(camera.position);
    tmp.fromTarget.copy(c.target);
    const s = { t: 0 };
    // Follow shots re-read the carriage on every step, so the camera lands attached even if it moved mid-tween.
    const tl = gsap.to(s, {
      t: 1,
      duration: 1.4,
      ease: "power2.inOut",
      onUpdate: () => {
        if (origin) {
          carriagePoint(tmp.anchor);
          tmp.endPos.addVectors(tmp.anchor, tmp.relPos);
          tmp.endTarget.addVectors(tmp.anchor, tmp.relTarget);
        }
        camera.position.lerpVectors(tmp.fromPos, tmp.endPos, s.t);
        c.target.lerpVectors(tmp.fromTarget, tmp.endTarget, s.t);
      },
      onComplete: () => (tween.current = null),
    });
    tween.current = tl;
    return () => {
      tl.kill();
      tween.current = null;
    };
  }, [preset, layout, camera, tmp, size, viewEpoch]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    let gesture = false;
    const onStart = () => {
      tween.current?.kill();
      tween.current = null;
      userMoved.current = true;
      gesture = true;
    };
    // The first real orbit, pan or zoom with mouse or trackpad enters explore mode: the panels step aside and the
    // machine glides to the middle. A click without movement does not count.
    const onChange = () => {
      if (!gesture) return;
      gesture = false;
      const s = useSimStore.getState();
      if (!s.exploring && !s.demo.active && !s.showVision) s.setExploring(true);
    };
    const onEnd = () => {
      // wheel and pinch emit start, change and end inside one event, so only a drag that never moved resets here
      gesture = false;
    };
    c.addEventListener("start", onStart);
    c.addEventListener("change", onChange);
    c.addEventListener("end", onEnd);
    return () => {
      c.removeEventListener("start", onStart);
      c.removeEventListener("change", onChange);
      c.removeEventListener("end", onEnd);
    };
  }, []);

  // Entering explore: frame the whole machine for the current line of sight in the uncovered window, then glide there.
  useEffect(() => {
    const c = controls.current;
    if (!c || !exploring) {
      glide.current = null;
      return;
    }
    following.current = false;
    userMoved.current = true;
    camera.layers.enable(OVERHEAD_LAYER); // explore shows the whole machine from any side; leaving refits the preset's layers
    // a pan that opened explore keeps the pivot where the user puts it; only an orbit or a zoom glides to the machine
    glide.current = panning.current ? null : { target: new THREE.Vector3(), pos: new THREE.Vector3(), dir: new THREE.Vector3(), userZoom: false };
  }, [exploring, camera, size, viewEpoch]);

  // A wheel tick or a two-finger touch means the user is choosing the distance; the glide stops dollying.
  useEffect(() => {
    const el = gl.domElement;
    const own = () => {
      if (glide.current) glide.current.userZoom = true;
    };
    // A pan moves the pivot on purpose, so it ends the glide that would otherwise pull the pivot back to the machine.
    // OrbitControls pans with the right button, or the left button with Ctrl, Meta or Shift held.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      panning.current = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey));
      if (panning.current) glide.current = null;
    };
    const onUp = () => {
      panning.current = false;
    };
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      // two fingers pinch and pan together: the distance and the pivot are the user's
      own();
      panning.current = true;
      glide.current = null;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) panning.current = false;
    };
    el.addEventListener("wheel", own, { passive: true });
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    el.addEventListener("touchstart", onTouch, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("wheel", own);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      el.removeEventListener("touchstart", onTouch);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [gl]);

  // Double-click any part of the machine to orbit around it: the clicked point becomes the orbit target and the camera
  // closes in along its current line of sight. Glass, water and HUD overlays are looked through, not focused.
  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const offset = new THREE.Vector3();
    const onDbl = (e: MouseEvent) => {
      const c = controls.current;
      if (!c) return;
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      ray.layers.mask = camera.layers.mask & ~(1 << 2);
      const hit = ray.intersectObjects(scene.children, true).find((h) => {
        const m = (h.object as THREE.Mesh).material as THREE.Material | undefined;
        // every see-through layer (glass, water volume, surface, meniscus) is transparent without depth write
        if (!(h.object as THREE.Mesh).isMesh || !m || (m.transparent && (m.opacity < 0.5 || !m.depthWrite))) return false;
        // the raycaster ignores .visible, so a hidden part or a part under a hidden group must be skipped here
        for (let o: THREE.Object3D | null = h.object; o; o = o.parent) if (!o.visible) return false;
        return true;
      });
      if (!hit) return;
      glide.current = null;
      tween.current?.kill();
      flushDamping(c);
      userMoved.current = true;
      following.current = false;
      offset.subVectors(camera.position, c.target);
      const dist = THREE.MathUtils.clamp(offset.length(), 0.3, 0.9);
      offset.setLength(dist);
      const from = { px: camera.position.x, py: camera.position.y, pz: camera.position.z, tx: c.target.x, ty: c.target.y, tz: c.target.z };
      const to = { px: hit.point.x + offset.x, py: hit.point.y + offset.y, pz: hit.point.z + offset.z, tx: hit.point.x, ty: hit.point.y, tz: hit.point.z };
      const s = { t: 0 };
      tween.current = gsap.to(s, {
        t: 1,
        duration: 0.8,
        ease: "power2.inOut",
        onUpdate: () => {
          camera.position.set(from.px + (to.px - from.px) * s.t, from.py + (to.py - from.py) * s.t, from.pz + (to.pz - from.pz) * s.t);
          c.target.set(from.tx + (to.tx - from.tx) * s.t, from.ty + (to.ty - from.ty) * s.t, from.tz + (to.tz - from.tz) * s.t);
        },
        onComplete: () => (tween.current = null),
      });
    };
    el.addEventListener("dblclick", onDbl);
    return () => el.removeEventListener("dblclick", onDbl);
  }, [gl, scene, camera]);

  // While a follow preset is active, translate the rig with the carriage. Orbiting still works.
  useFrame((_, dt) => {
    const c = controls.current;
    const g = glide.current;
    // OrbitControls damps per update, so a fixed factor coasts 2.4 times shorter at 144 Hz than at 60 Hz. Scale it
    // by the frame time so a flick of the mouse feels the same on every display (0.08 per 60 Hz frame).
    if (c) c.dampingFactor = 1 - Math.pow(1 - ORBIT_DAMPING_60HZ, Math.min(dt, 0.1) * 60);
    if (c && g && !tween.current) {
      // Re-fit the whole machine for the live line of sight every frame, so rotation during the glide never pushes it
      // off screen. Only the pivot and the distance ease; the user's rotation is never overridden.
      g.dir.subVectors(camera.position, c.target);
      const d = g.dir.length();
      fit(PRESETS.A, null, size.width, size.height, g.pos, g.target, { dir: g.dir, rect: exploreRect(size.width, size.height) });
      const goal = g.userZoom ? d : g.pos.distanceTo(g.target);
      const k = 1 - Math.exp(-Math.min(dt, 0.1) * 5);
      c.target.lerp(g.target, k);
      camera.position.copy(c.target).addScaledVector(g.dir.divideScalar(d || 1), d + (goal - d) * k);
      if (c.target.distanceToSquared(g.target) < 1e-8 && Math.abs(goal - d) < 1e-4) glide.current = null;
    }
    if (!c || !following.current) return;
    carriagePoint(tmp.now);
    tmp.delta.subVectors(tmp.now, tmp.anchor);
    tmp.anchor.copy(tmp.now);
    if (tween.current) return;
    if (tmp.delta.lengthSq() === 0) return;
    camera.position.add(tmp.delta);
    c.target.add(tmp.delta);
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={ORBIT_DAMPING_60HZ}
      target={[0.12, 0.2, 0]}
      minDistance={0.08}
      maxDistance={14}
      minPolarAngle={0}
      maxPolarAngle={Math.PI}
      enablePan
      panSpeed={0.6}
      rotateSpeed={0.7}
      zoomSpeed={0.8}
    />
  );
}
