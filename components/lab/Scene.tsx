"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { TANK } from "@/lib/sim/constants";
import { ENVIRONMENTS } from "@/lib/sim/environments";
import { useSimStore } from "@/lib/sim/store";
import { Aquarium } from "./Aquarium";
import { CameraRig, INITIAL_CAMERA } from "./CameraRig";
import { Electronics } from "./Electronics";
import { RigLamps, TankDressing, buildDressingWarmup, overviewFill } from "./TankDressing";
import { FeedRenderer, feedCam, renderStats } from "./FeedRenderer";
import { Gantry } from "./Gantry";
import { Callouts, Overlays } from "./Overlays";
import { SimDriver } from "./SimDriver";
import { TestObjects } from "./TestObjects";
import { mergeBoxes, std } from "./util";
import { patchSceneWater, waterClock } from "./water";

const FLOOR_Y = -0.85;

/** Procedural environment map so metals and acrylic have something to reflect. No downloads. */
function Env() {
  const gl = useThree((s) => s.gl);
  const tex = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const t = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    return t;
  }, [gl]);
  useFrame(({ scene }) => {
    if (scene.environment !== tex) scene.environment = tex;
    // reflections dim with the lighting too, so the slider reads on the metals; with the lab lights off for the
    // deep-sea emulation there is nothing to reflect.
    const { lighting, environment } = useSimStore.getState().engine.scenario;
    const env = ENVIRONMENTS[environment];
    const share = env.light === "lamp" ? 0 : 0.35;
    scene.environmentIntensity = share * (0.08 + 0.92 * lighting);
  });
  return null;
}

function Lights() {
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const fill = useRef<THREE.PointLight>(null);
  useFrame(() => {
    const { lighting: l, environment } = useSimStore.getState().engine.scenario;
    // deep-sea emulation: the lab lights are off and the rig's own lamps (components/lab/TankDressing.tsx) light the tank
    const day = ENVIRONMENTS[environment].light === "lamp" ? 0 : 1;
    const k = 0.08 + 0.92 * l;
    if (sun.current) sun.current.intensity = day * (0.25 + 1.6 * l);
    if (hemi.current) hemi.current.intensity = day * 1.0 * k;
    if (fill.current) fill.current.intensity = day * 2.5 * k;
  });
  return (
    <>
      <directionalLight
        ref={sun}
        position={[1.2, 3.2, 0.9]}
        intensity={1.9}
        color="#f3f0e8"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-radius={4}
        shadow-bias={-0.0004}
        shadow-normalBias={0.01}
        shadow-camera-left={-1.1}
        shadow-camera-right={1.2}
        shadow-camera-top={0.9}
        shadow-camera-bottom={-0.9}
        shadow-camera-near={0.5}
        shadow-camera-far={7}
      />
      <hemisphereLight ref={hemi} args={["#7fa6b8", "#0b1219", 0.6]} />
      {/* the deep's lights, always mounted (dark elsewhere) so the light count, and every shader, never changes */}
      <RigLamps />
      <primitive object={overviewFill} />
      <pointLight ref={fill} position={[-1.6, 1.4, -1.2]} intensity={2.5} decay={2} color="#c9d6e0" />
    </>
  );
}

/** Dark lab room: concrete floor with a faint grid and a steel table under the tank. */
function Room() {
  const floorMat = useMemo(() => std({ color: "#151b21", roughness: 0.95, fog: false }), []);
  const steelMat = useMemo(() => std({ color: "#262c33", roughness: 0.6, metalness: 0.5, fog: false }), []);
  const tableGeo = useMemo(() => {
    const top = -TANK.sandDepth - TANK.glass; // glass underside
    const legH = top - 0.04 - FLOOR_Y;
    const parts: Parameters<typeof mergeBoxes>[0] = [{ size: [1.32, 0.04, 0.72], at: [0, top - 0.02, 0] }];
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        parts.push({ size: [0.04, legH, 0.04], at: [sx * 0.62, FLOOR_Y + legH / 2, sz * 0.32] });
      }
    for (const sz of [-1, 1]) parts.push({ size: [1.24, 0.03, 0.03], at: [0, FLOOR_Y + 0.25, sz * 0.32] });
    return mergeBoxes(parts);
  }, []);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, 0]} material={floorMat} receiveShadow>
        <planeGeometry args={[14, 14]} />
      </mesh>
      <mesh geometry={tableGeo} material={steelMat} castShadow receiveShadow />
    </group>
  );
}

/** The lab room and tank, or an open-water site with the rig standing on the seabed. */
/** How long the view takes to fade out before the site is swapped; matches the veil transition in LabUI. */
const SITE_FADE_MS = 220;

/**
 * The lab room and tank, or an open-water site with the rig standing on the seabed.
 * Switching is seamless: the UI veils the view (store.siteReady false), the new site mounts behind the veil, its
 * materials get the water patch and are compiled off the critical path (compileAsync), and only then does the veil
 * lift, so neither the swap nor the first-frame shader compile is ever seen.
 */
function Site() {
  const target = useSimStore((s) => s.scenario.environment);
  const [shown, setShown] = useState(target);
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    // switched away and straight back inside the fade: nothing to swap, so lift the veil again
    if (target === shown) {
      if (!useSimStore.getState().siteReady) useSimStore.getState().setSiteReady(true);
      return;
    }
    useSimStore.getState().setSiteReady(false);
    const id = window.setTimeout(() => setShown(target), SITE_FADE_MS);
    return () => window.clearTimeout(id);
  }, [target, shown]);
  useEffect(() => {
    let cancelled = false;
    // the new site's meshes are in the scene graph after this commit; patch and compile them before revealing
    patchSceneWater(scene, 2);
    const reveal = () => !cancelled && requestAnimationFrame(() => requestAnimationFrame(() => !cancelled && useSimStore.getState().setSiteReady(true)));
    gl.compileAsync(scene, camera).then(reveal, reveal);
    return () => {
      cancelled = true;
    };
  }, [shown, gl, scene, camera]);
  return (
    <>
      <Room />
      <Aquarium env={shown} />
      <TankDressing env={shown} />
    </>
  );
}

/** Precompiles the tank dressings' shader variants once, when the browser is idle after the first site is shown. */
function DressingWarmup() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      const warm = buildDressingWarmup();
      patchSceneWater(warm, 2);
      // compiled against the main scene, so the programs match its lights and environment map
      gl.compileAsync(warm, camera, scene).catch(() => {});
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const id = ric ? ric(run, { timeout: 4000 }) : window.setTimeout(run, 1500);
    return () => {
      done = true;
      if (!ric) window.clearTimeout(id);
    };
  }, [gl, scene, camera]);
  return null;
}

/** Dev only: lets browser tests drive the store and read draw call counts. */
function DevHooks() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __labStore?: typeof useSimStore; __labStats?: typeof renderStats; __labScene?: THREE.Scene; __labFeedCam?: THREE.PerspectiveCamera };
    w.__labStore = useSimStore;
    w.__labStats = renderStats;
    w.__labScene = scene;
    w.__labFeedCam = feedCam;
    (w as unknown as { __labFreezeWater?: (t: number | null) => void }).__labFreezeWater = (t) => {
      waterClock.frozen = t;
    };
  }, [scene]);
  return null;
}

export function LabScene() {
  return (
    <Canvas
      dpr={[1, 1.5]}
      shadows={{ type: THREE.PCFShadowMap }}
      frameloop="always"
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: 40, near: 0.02, far: 40, position: INITIAL_CAMERA }}
      onPointerMissed={() => useSimStore.getState().selectObject(null)}
    >
      <color attach="background" args={["#0b1219"]} />
      <SimDriver />
      <CameraRig />
      <Env />
      <Lights />
      <Site />
      <DressingWarmup />
      <Gantry />
      <Electronics />
      <TestObjects />
      <Overlays />
      <Callouts />
      <FeedRenderer />
      <DevHooks />
    </Canvas>
  );
}
