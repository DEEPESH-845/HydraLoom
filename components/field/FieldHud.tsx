"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { useFieldStore } from "@/lib/field/store";
import type { EnvironmentDefinition } from "@/lib/world/schema";
import { terrainHeight } from "@/lib/world/terrain";
import { HUD_LAYER, merge, useDeferredDispose } from "./common";

/*
 * HUD drawn inside the 3D view, on the HUD layer: never in the platform camera, never water patched.
 *   FlowField: instanced arrows over the site at several heights above the bed, length and colour by the local
 *              water speed sampled from engine.current (the same field the physics and the particles use)
 *   RouteAndTrail: the mission route from engine.route() and the platform's travelled path
 *   SiteOutline: the water column's footprint at the surface
 * Per-frame work lives in closures built with the objects, so React state is never mutated during render.
 */

const SLOW = new THREE.Color("#1d4f55");
const FAST = new THREE.Color("#a8ece4");

/** Dev and test access to the arrows' last refresh. */
export const flowProbe = { update: 0, meanSpeed: 0, count: 0, heading: 0, meanDir: [0, 0, 0] as [number, number, number] };

function arrowGeometry(): THREE.BufferGeometry {
  // unit arrow along +x from 0 to 1
  const shaft = new THREE.CylinderGeometry(0.035, 0.035, 0.72, 6).rotateZ(-Math.PI / 2).translate(0.36, 0, 0);
  const head = new THREE.ConeGeometry(0.11, 0.28, 8).rotateZ(-Math.PI / 2).translate(0.86, 0, 0);
  return merge([shaft, head]);
}

function hud<T extends THREE.Object3D>(o: T, name: string): T {
  o.name = name;
  o.layers.set(HUD_LAYER);
  o.frustumCulled = false;
  o.userData.noWater = true;
  return o;
}

function buildFlow(env: EnvironmentDefinition, baseY: number) {
  const [ex, ez] = env.geometry.extentM;
  const n = ex > 100 ? 14 : 11;
  const nz = Math.max(4, Math.round((n * ez) / ex));
  const cell = Math.min(ex / n, ez / nz);
  const t = env.geometry.terrain;
  const pts: [number, number, number][] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < nz; j++) {
      const x = -ex / 2 + ((i + 0.5) * ex) / n;
      const z = -ez / 2 + ((j + 0.5) * ez) / nz;
      const bed = terrainHeight(t, x, z);
      const depth = -bed;
      for (const h of [1, 3, 8]) if (h < depth - 0.5 && (h === 1 || depth > h + 2)) pts.push([x, bed + h, z]);
    }
  const mat = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false });
  const mesh = hud(new THREE.InstancedMesh(arrowGeometry(), mat, pts.length), "hud-flow-arrows");
  mesh.renderOrder = 3;
  for (let i = 0; i < pts.length; i++) mesh.setColorAt(i, SLOW);
  const st = { acc: 1 };
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const X = new THREE.Vector3(1, 0, 0);
  const c = new THREE.Color();
  const update = (show: boolean, dt: number) => {
    mesh.visible = show;
    if (!show) return;
    st.acc += dt;
    if (st.acc < 0.25) return;
    st.acc = 0;
    const engine = useFieldStore.getState().engine;
    const cur = engine.current;
    const ref = Math.max(0.15, cur.config.speedMps * 1.4);
    let sum = 0;
    const md: [number, number, number] = [0, 0, 0];
    pts.forEach((pt, i) => {
      const v = cur.sample(pt, engine.time);
      const sp = Math.hypot(v[0], v[1], v[2]);
      sum += sp;
      md[0] += v[0];
      md[1] += v[1];
      md[2] += v[2];
      const k = Math.min(1.3, sp / ref);
      const L = Math.max(0.0001, Math.min(cell * 0.7, 6) * k);
      if (sp > 1e-5) q.setFromUnitVectors(X, dir.set(v[0], v[1], v[2]).normalize());
      p.set(pt[0], pt[1] - baseY, pt[2]);
      const th = Math.min(cell * 0.12, 0.8);
      m.compose(p, q, sc.set(L, th, th));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.lerpColors(SLOW, FAST, Math.min(1, k)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const N = Math.max(1, pts.length);
    flowProbe.update = performance.now();
    flowProbe.meanSpeed = sum / N;
    flowProbe.count = pts.length;
    flowProbe.heading = cur.config.headingDeg;
    flowProbe.meanDir = [md[0] / N, md[1] / N, md[2] / N];
  };
  const dispose = () => {
    mesh.geometry.dispose();
    mat.dispose();
    mesh.dispose();
  };
  return { mesh, update, dispose };
}

/** Grid of flow arrows, refreshed four times per second. */
export function FlowField({ env, baseY }: { env: EnvironmentDefinition; baseY: number }) {
  const show = useFieldStore((s) => s.showFlow);
  const flow = useMemo(() => buildFlow(env, baseY), [env, baseY]);
  useDeferredDispose(flow, flow.dispose);
  useFrame((_, dt) => flow.update(show, dt));
  return <primitive object={flow.mesh} />;
}

const TRAIL_MAX = 6000;

function buildRoute(env: EnvironmentDefinition, baseY: number) {
  const routeGeo = new THREE.BufferGeometry();
  routeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 512), 3));
  const route = hud(new THREE.Line(routeGeo, new THREE.LineBasicMaterial({ color: "#3db9b0", transparent: true, opacity: 0.9, toneMapped: false })), "hud-route");
  const wps = hud(new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshBasicMaterial({ color: "#3db9b0", toneMapped: false }), 512), "hud-waypoints");
  wps.count = 0;
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * TRAIL_MAX), 3));
  const trail = hud(new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: "#e6edf3", transparent: true, opacity: 0.55, toneMapped: false })), "hud-track");
  const st = { routeKey: "", n: 0, lastTime: -1, last: new THREE.Vector3(1e9, 0, 0) };
  const m = new THREE.Matrix4();
  const rad = Math.max(0.08, Math.max(...env.geometry.extentM) / 400);
  const update = () => {
    const engine = useFieldStore.getState().engine;
    const r = engine.route();
    const key = `${r.length}:${r[0]?.x ?? 0}:${r[0]?.z ?? 0}:${r[r.length - 1]?.x ?? 0}:${r[r.length - 1]?.z ?? 0}`;
    if (key !== st.routeKey) {
      st.routeKey = key;
      const a = routeGeo.attributes.position as THREE.BufferAttribute;
      const n = Math.min(512, r.length);
      for (let i = 0; i < n; i++) {
        const w = r[i];
        const y = w.altitude !== undefined ? terrainHeight(env.geometry.terrain, w.x, w.z) + w.altitude : w.y;
        a.setXYZ(i, w.x, y - baseY, w.z);
        wps.setMatrixAt(i, m.makeScale(rad, rad, rad).setPosition(w.x, y - baseY, w.z));
      }
      a.needsUpdate = true;
      routeGeo.setDrawRange(0, n);
      wps.count = n;
      wps.instanceMatrix.needsUpdate = true;
    }
    // trail: a point every 0.25 m of travel; cleared when the run restarts
    if (engine.time < st.lastTime) {
      st.n = 0;
      st.last.set(1e9, 0, 0);
      trailGeo.setDrawRange(0, 0);
    }
    st.lastTime = engine.time;
    trail.visible = !!engine.vehicle;
    if (!engine.vehicle) return;
    const p = engine.renderPose().position;
    const dx = p[0] - st.last.x;
    const dy = p[1] - st.last.y;
    const dz = p[2] - st.last.z;
    if (dx * dx + dy * dy + dz * dz < 0.0625) return;
    const a = trailGeo.attributes.position as THREE.BufferAttribute;
    if (st.n >= TRAIL_MAX) {
      (a.array as Float32Array).copyWithin(0, 3 * (TRAIL_MAX / 2));
      st.n = TRAIL_MAX / 2;
    }
    a.setXYZ(st.n++, p[0], p[1] - baseY, p[2]);
    a.needsUpdate = true;
    trailGeo.setDrawRange(0, st.n);
    st.last.set(p[0], p[1], p[2]);
  };
  const dispose = () => {
    for (const o of [route, wps, trail]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    wps.dispose();
  };
  return { route, wps, trail, update, dispose };
}

export function RouteAndTrail({ env, baseY }: { env: EnvironmentDefinition; baseY: number }) {
  const parts = useMemo(() => buildRoute(env, baseY), [env, baseY]);
  useDeferredDispose(parts, parts.dispose);
  useFrame(() => parts.update());
  return (
    <>
      <primitive object={parts.route} />
      <primitive object={parts.wps} />
      <primitive object={parts.trail} />
    </>
  );
}

/** The water column's footprint: the surface rectangle and its corner verticals down to the seabed. */
export function SiteOutline({ env, baseY, minY }: { env: EnvironmentDefinition; baseY: number; minY: number }) {
  const line = useMemo(() => {
    const [ex, ez] = env.geometry.extentM;
    const top = env.light.source === "lamp" ? Math.min(0, minY + 10) : 0;
    const pts: number[] = [];
    const c: [number, number][] = [
      [-ex / 2, -ez / 2],
      [ex / 2, -ez / 2],
      [ex / 2, ez / 2],
      [-ex / 2, ez / 2],
    ];
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = c[i];
      const [x1, z1] = c[(i + 1) % 4];
      pts.push(x0, top - baseY, z0, x1, top - baseY, z1);
      pts.push(x0, top - baseY, z0, x0, terrainHeight(env.geometry.terrain, x0, z0) - baseY, z0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return hud(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: "#4b6a80", transparent: true, opacity: 0.55, toneMapped: false })), "hud-site-outline");
  }, [env, baseY, minY]);
  const disposeLine = useMemo(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line],
  );
  useDeferredDispose(line, disposeLine);
  return <primitive object={line} />;
}
