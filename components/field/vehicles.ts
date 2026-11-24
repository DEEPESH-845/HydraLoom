"use client";

import * as THREE from "three";
import type { FieldEngine } from "@/lib/field/engine";
import type { PlatformId } from "@/lib/platforms";
import { merge, paint, std } from "./common";

/*
 * Platform models, real scale, in the body frame of lib/physics (x forward, y up, z starboard), so the root's
 * quaternion is the engine's attitude as is. Drawn at engine.renderPose() (interpolated between physics substeps).
 * Everything here goes on the vehicle layer: the main view draws it, the platform's own camera does not see it.
 */

export interface VehicleModel {
  root: THREE.Group;
  /** per-frame pose and actuator animation; dt is wall-clock seconds */
  update: (engine: FieldEngine, baseY: number, dt: number) => void;
  /** parts drawn in world space beside the body (the ROV's tether) */
  extras: THREE.Object3D[];
}

const UP = new THREE.Vector3(0, 1, 0);
const clamp1 = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));

function propeller(r: number, blades: number, color: string): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(r * 0.22, r * 0.22, r * 0.5, 10)];
  for (let k = 0; k < blades; k++) {
    const b = new THREE.BoxGeometry(r * 0.38, r * 0.06, r * 0.9);
    b.translate(0, 0, r * 0.5);
    b.rotateZ(0.5);
    b.rotateY((k / blades) * Math.PI * 2);
    parts.push(b);
  }
  return paint(merge(parts), color);
}

/** Observation ROV of the BlueROV2 Heavy class: open frame, 8 thrusters, foam, dome, 4 lamps, tether. */
function rovModel(): VehicleModel {
  const root = new THREE.Group();
  root.name = "platform-rov";
  const black = std({ color: "#1b1d1f", roughness: 0.6, metalness: 0.1 });
  const frameParts: THREE.BufferGeometry[] = [];
  // side frame plates with cut-outs, HDPE
  const plate = new THREE.Shape();
  plate.moveTo(-0.22, -0.12);
  plate.lineTo(0.2, -0.12);
  plate.quadraticCurveTo(0.23, -0.12, 0.23, -0.08);
  plate.lineTo(0.23, 0.06);
  plate.quadraticCurveTo(0.23, 0.12, 0.17, 0.12);
  plate.lineTo(-0.17, 0.12);
  plate.quadraticCurveTo(-0.23, 0.12, -0.23, 0.06);
  plate.lineTo(-0.23, -0.08);
  plate.quadraticCurveTo(-0.23, -0.12, -0.22, -0.12);
  for (const [cx, cy, w, h] of [
    [-0.12, 0, 0.13, 0.12],
    [0.06, 0, 0.13, 0.12],
  ]) {
    const hole = new THREE.Path();
    hole.moveTo(cx - w / 2, cy - h / 2);
    hole.lineTo(cx + w / 2, cy - h / 2);
    hole.lineTo(cx + w / 2, cy + h / 2);
    hole.lineTo(cx - w / 2, cy + h / 2);
    hole.closePath();
    plate.holes.push(hole);
  }
  for (const sz of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(plate, { depth: 0.012, bevelEnabled: false, curveSegments: 6 });
    g.translate(0, 0, sz * 0.27 - 0.006);
    frameParts.push(g);
  }
  // cross members
  for (const [x, y] of [
    [0.2, -0.11],
    [-0.2, -0.11],
    [0.2, 0.11],
    [-0.2, 0.11],
  ])
    frameParts.push(new THREE.BoxGeometry(0.03, 0.02, 0.54).translate(x, y, 0));
  const frame = new THREE.Mesh(merge(frameParts), black);
  root.add(frame);
  // electronics enclosure (acrylic tube, aluminium end caps) with the camera dome, and the battery tube
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 24).rotateZ(Math.PI / 2).translate(0.01, 0.02, 0), std({ color: "#9fb2bb", roughness: 0.15, metalness: 0.1 }));
  root.add(tube);
  const caps = new THREE.Mesh(
    merge([new THREE.CylinderGeometry(0.056, 0.056, 0.03, 24).rotateZ(Math.PI / 2).translate(-0.15, 0.02, 0), new THREE.CylinderGeometry(0.056, 0.056, 0.02, 24).rotateZ(Math.PI / 2).translate(0.165, 0.02, 0), new THREE.CylinderGeometry(0.04, 0.04, 0.26, 18).rotateZ(Math.PI / 2).translate(-0.02, -0.075, 0)]),
    std({ color: "#5d6266", roughness: 0.35, metalness: 0.7 }),
  );
  root.add(caps);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.05, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-Math.PI / 2).translate(0.175, 0.02, 0), std({ color: "#28333a", roughness: 0.05, metalness: 0.3 }));
  root.add(dome);
  // buoyancy foam on top
  const foam = new THREE.Mesh(
    merge([new THREE.BoxGeometry(0.42, 0.07, 0.19).translate(0, 0.1, -0.15), new THREE.BoxGeometry(0.42, 0.07, 0.19).translate(0, 0.1, 0.15)]),
    std({ color: "#a88b3c", roughness: 0.8 }),
  );
  root.add(foam);
  // lamps at the front frame
  const lampMat = new THREE.MeshBasicMaterial({ color: "#fff4dc" });
  const lampBody = new THREE.Mesh(
    merge(
      [
        [0.2, 0.08, -0.18],
        [0.2, 0.08, 0.18],
        [0.2, -0.08, -0.18],
        [0.2, -0.08, 0.18],
      ].map(([x, y, z]) => new THREE.CylinderGeometry(0.02, 0.02, 0.04, 14).rotateZ(Math.PI / 2).translate(x, y, z)),
    ),
    std({ color: "#3b3f43", roughness: 0.4, metalness: 0.6 }),
  );
  root.add(lampBody);
  const lampFaces = new THREE.Mesh(
    merge(
      [
        [0.221, 0.08, -0.18],
        [0.221, 0.08, 0.18],
        [0.221, -0.08, -0.18],
        [0.221, -0.08, 0.18],
      ].map(([x, y, z]) => new THREE.CircleGeometry(0.017, 14).rotateY(Math.PI / 2).translate(x, y, z)),
    ),
    lampMat,
  );
  root.add(lampFaces);
  // thrusters: four vectored horizontals at the corners, four verticals
  const ductMat = std({ color: "#202224", roughness: 0.5, side: THREE.DoubleSide });
  const propMat = std({ color: "#ffffff", vertexColors: true, roughness: 0.5 });
  const props: { mesh: THREE.Mesh; kind: "h" | "v"; sx: number; sz: number }[] = [];
  const thr = (pos: THREE.Vector3, axis: THREE.Vector3, kind: "h" | "v", sx: number, sz: number) => {
    const g = new THREE.Group();
    g.position.copy(pos);
    g.quaternion.setFromUnitVectors(UP, axis);
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.055, 22, 1, true), ductMat));
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 12).translate(0, -0.01, 0), black));
    const p = new THREE.Mesh(propeller(0.045, 3, "#3b3d40"), propMat);
    g.add(p);
    root.add(g);
    props.push({ mesh: p, kind, sx, sz });
  };
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      thr(new THREE.Vector3(sx * 0.17, -0.03, sz * 0.205), new THREE.Vector3(sx, 0, -sz * sx).normalize(), "h", sx, sz);
      thr(new THREE.Vector3(sx * 0.1, 0.075, sz * 0.205), UP.clone(), "v", sx, sz);
    }
  // tether: instanced segments from the vehicle's rear to the surface, swept downstream by the current
  const SEG = 48;
  const tether = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0045, 0.0045, 1, 5, 1, true).translate(0, 0.5, 0), std({ color: "#c79a2a", roughness: 0.6 }), SEG);
  tether.name = "platform-rov-tether";
  tether.frustumCulled = false;
  const tetherPts = Array.from({ length: SEG + 1 }, () => new THREE.Vector3());
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const d = new THREE.Vector3();
  const anchor = new THREE.Vector3();
  const spin = new Float32Array(props.length);

  return {
    root,
    update(engine, baseY, dt) {
      const pose = engine.renderPose();
      root.position.set(pose.position[0], pose.position[1] - baseY, pose.position[2]);
      root.quaternion.set(pose.attitude[0], pose.attitude[1], pose.attitude[2], pose.attitude[3]);
      const s = engine.vehicle;
      const p = engine.params;
      if (s && p) {
        const fx = s.thrustForce[0] / p.maxForce[0];
        const fy = s.thrustForce[1] / p.maxForce[1];
        const fz = s.thrustForce[2] / p.maxForce[2];
        const mx = s.thrustMoment[0] / p.maxMoment[0];
        const my = s.thrustMoment[1] / p.maxMoment[1];
        const mz = s.thrustMoment[2] / p.maxMoment[2];
        props.forEach((t, i) => {
          // a simple allocation for the vectored frame: enough to show which thrusters work and which way
          const cmd = t.kind === "h" ? clamp1(fx * t.sx + fz * t.sz * t.sx - my * t.sz) : clamp1(fy + mx * t.sz * 0.6 + mz * t.sx * 0.6);
          spin[i] += cmd * 70 * dt;
          t.mesh.rotation.y = spin[i];
        });
      }
      // tether from the rear of the frame toward the surface, leaning downstream
      const c = engine.current.mean();
      anchor.set(-0.2, 0.08, 0).applyQuaternion(root.quaternion).add(root.position);
      const depth = -(anchor.y + baseY);
      const rise = Math.min(depth, 40);
      const lean = Math.min(1.2, Math.hypot(c[0], c[2]) * 3);
      for (let k = 0; k <= SEG; k++) {
        const t = k / SEG;
        const sag = Math.sin(Math.PI * t) * 0.6;
        tetherPts[k].set(anchor.x + (c[0] * lean * 6 - 0.6) * t + sag * 0.3, anchor.y + rise * t * t - sag * 0.2, anchor.z + c[2] * lean * 6 * t);
      }
      for (let k = 0; k < SEG; k++) {
        d.subVectors(tetherPts[k + 1], tetherPts[k]);
        const L = d.length();
        q.setFromUnitVectors(UP, d.normalize());
        m4.compose(tetherPts[k], q, sc.set(1, L, 1));
        tether.setMatrixAt(k, m4);
      }
      tether.instanceMatrix.needsUpdate = true;
    },
    extras: [tether],
  };
}

/** Survey AUV of the REMUS 100 class: torpedo hull, nose, cruciform fins, stern propeller. */
function auvModel(): VehicleModel {
  const root = new THREE.Group();
  root.name = "platform-auv";
  const pts: THREE.Vector2[] = [];
  const R = 0.095;
  // profile along the axis from the nose (y = +0.67) to the tail (y = -0.64), radius in x
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const y = 0.67 - 0.2 * t;
    pts.push(new THREE.Vector2(Math.max(0.001, R * Math.sqrt(Math.max(0, 1 - (1 - t) ** 2))), y));
  }
  pts.push(new THREE.Vector2(R, -0.25));
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    pts.push(new THREE.Vector2(R * (1 - 0.72 * t * t), -0.25 - 0.39 * t));
  }
  pts.push(new THREE.Vector2(0.001, -0.64));
  pts.reverse();
  const hull = new THREE.LatheGeometry(pts, 36);
  hull.rotateZ(-Math.PI / 2); // lathe axis y -> body x
  const col = new Float32Array(hull.attributes.position.count * 3);
  const yellow = new THREE.Color("#b8973a");
  const dark = new THREE.Color("#25272a");
  const p = hull.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const c = x < -0.3 ? dark : x > 0.58 ? new THREE.Color("#33383c") : yellow;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  hull.setAttribute("color", new THREE.BufferAttribute(col, 3));
  root.add(new THREE.Mesh(hull, std({ color: "#ffffff", vertexColors: true, roughness: 0.45, metalness: 0.05 })));
  // details: antenna mast, camera and lamp windows underneath, a DVL head
  root.add(
    new THREE.Mesh(
      merge([
        new THREE.BoxGeometry(0.04, 0.09, 0.012).translate(-0.05, 0.13, 0),
        new THREE.CylinderGeometry(0.035, 0.035, 0.02, 16).translate(0.15, -0.093, 0),
        new THREE.CylinderGeometry(0.02, 0.02, 0.01, 12).translate(0.3, -0.095, 0),
        new THREE.CylinderGeometry(0.018, 0.018, 0.01, 12).translate(0.1, -0.095, -0.06),
        new THREE.CylinderGeometry(0.018, 0.018, 0.01, 12).translate(0.55, -0.075, 0.06),
      ]),
      std({ color: "#1c1e20", roughness: 0.4, metalness: 0.3 }),
    ),
  );
  // fins: rudders (vertical, about body y) and elevators (horizontal, about body z)
  const finMat = std({ color: "#202224", roughness: 0.5 });
  const finGeo = new THREE.BoxGeometry(0.07, 0.085, 0.008).translate(-0.02, 0.085 + 0.04, 0);
  const rudders: THREE.Object3D[] = [];
  const elevators: THREE.Object3D[] = [];
  for (const k of [0, 1, 2, 3]) {
    const pivot = new THREE.Group();
    pivot.position.set(-0.5, 0, 0);
    pivot.rotation.x = (k * Math.PI) / 2;
    const hinge = new THREE.Group();
    hinge.add(new THREE.Mesh(finGeo, finMat));
    pivot.add(hinge);
    root.add(pivot);
    (k % 2 === 0 ? rudders : elevators).push(hinge);
  }
  const prop = new THREE.Mesh(propeller(0.07, 3, "#3a3c3f").rotateZ(Math.PI / 2), std({ color: "#ffffff", vertexColors: true, roughness: 0.5 }));
  prop.position.set(-0.65, 0, 0);
  root.add(prop);
  let spin = 0;
  let rud = 0;
  let elev = 0;
  return {
    root,
    update(engine, baseY, dt) {
      const pose = engine.renderPose();
      root.position.set(pose.position[0], pose.position[1] - baseY, pose.position[2]);
      root.quaternion.set(pose.attitude[0], pose.attitude[1], pose.attitude[2], pose.attitude[3]);
      const s = engine.vehicle;
      const pr = engine.params;
      if (!s || !pr) return;
      spin += (s.thrustForce[0] / Math.max(1e-6, pr.maxForce[0])) * 60 * dt;
      prop.rotation.x = spin;
      // the commanded fin angles are internal to the pilot, so they are inferred from the turn and pitch rates
      const k = Math.min(1, dt * 8);
      rud += (clamp1(-s.angularVelocity[1] / 0.35) - rud) * k;
      elev += (clamp1(s.angularVelocity[2] / 0.25) - elev) * k;
      const max = (13.6 * Math.PI) / 180;
      for (const r of rudders) r.rotation.y = rud * max;
      for (const e of elevators) e.rotation.y = -elev * max;
    },
    extras: [],
  };
}

/** Seabed camera station: tripod, mast, pan-tilt head with a camera housing and two lamps. */
function stationModel(): VehicleModel {
  const root = new THREE.Group();
  root.name = "platform-station";
  const steel = std({ color: "#4f5458", roughness: 0.45, metalness: 0.6 });
  const legs: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    const foot = new THREE.Vector3(Math.cos(a) * 0.62, 0.02, Math.sin(a) * 0.62);
    const top = new THREE.Vector3(0, 0.95, 0);
    const d = top.clone().sub(foot);
    const g = new THREE.CylinderGeometry(0.018, 0.022, d.length(), 10).translate(0, d.length() / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.clone().normalize()));
    g.translate(foot.x, foot.y, foot.z);
    legs.push(g, new THREE.CylinderGeometry(0.07, 0.08, 0.03, 16).translate(foot.x, 0.015, foot.z));
  }
  legs.push(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 12).translate(0, 1.0, 0));
  legs.push(new THREE.BoxGeometry(0.12, 0.08, 0.12).translate(0, 0.92, 0));
  root.add(new THREE.Mesh(merge(legs), steel));
  // pan (about y) then tilt (about z) at the lens height
  const pan = new THREE.Group();
  pan.position.set(0, 1.2, 0);
  root.add(pan);
  pan.add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 18).translate(0, -0.06, 0), std({ color: "#2a2d30", roughness: 0.5 })));
  const tilt = new THREE.Group();
  pan.add(tilt);
  tilt.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.26, 22).rotateZ(Math.PI / 2).translate(-0.1, 0, 0), std({ color: "#3a4146", roughness: 0.35, metalness: 0.5 })));
  tilt.add(new THREE.Mesh(new THREE.CircleGeometry(0.05, 20).rotateY(Math.PI / 2).translate(0.031, 0, 0), std({ color: "#101418", roughness: 0.05 })));
  const arm = merge([new THREE.BoxGeometry(0.03, 0.03, 0.74).translate(-0.05, 0.25, 0), new THREE.BoxGeometry(0.03, 0.25, 0.03).translate(-0.05, 0.125, 0)]);
  tilt.add(new THREE.Mesh(arm, steel));
  for (const sz of [-1, 1]) {
    tilt.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 14).rotateZ(Math.PI / 2).translate(0, 0.25, sz * 0.35), std({ color: "#3b3f43", roughness: 0.4, metalness: 0.6 })));
    tilt.add(new THREE.Mesh(new THREE.CircleGeometry(0.026, 14).rotateY(Math.PI / 2).translate(0.036, 0.25, sz * 0.35), new THREE.MeshBasicMaterial({ color: "#fff4dc" })));
  }
  return {
    root,
    update(engine, baseY) {
      const st = engine.station;
      root.position.set(st.position[0], st.position[1] - baseY, st.position[2]);
      const pose = engine.renderPose();
      root.quaternion.set(pose.attitude[0], pose.attitude[1], pose.attitude[2], pose.attitude[3]);
      const mount = engine.platform.camera;
      pan.rotation.y = (st.panDeg * Math.PI) / 180;
      tilt.rotation.z = (-(mount.tiltDeg + st.tiltDeg) * Math.PI) / 180;
    },
    extras: [],
  };
}

export function createVehicleModel(id: PlatformId): VehicleModel {
  return id === "auv" ? auvModel() : id === "station" ? stationModel() : rovModel();
}
