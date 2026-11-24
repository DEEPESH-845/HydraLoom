"use client";

import * as THREE from "three";
import type { FieldEngine } from "@/lib/field/engine";
import { VEHICLE_LAYER } from "./common";

/*
 * Visible headlight beams for the main view: a soft cone of lit water and a glow at each of the platform's lamp
 * lights (fieldLights.spots), so it is obvious where the platform is shining and what it lights up ahead.
 * They live on the vehicle layer: the main view draws them, the platform camera and the pilot view never do, so the
 * camera image stays the physical one (its lamps light the scene through the spot lights alone).
 */

/** How far a beam is drawn ahead of the lamp, m, at full lamp power in clear water. */
const BEAM_LENGTH_M = 7;
/** The visible core of a beam is narrower than the lamp's full beam angle. */
const MAX_CORE_HALF_ANGLE = 0.26;

const BEAM_VERT = /* glsl */ `
varying float vAlong;
varying float vEdge;
void main() {
  // the cone runs from the lamp (local z = 0) to the far end (z = 1)
  vAlong = position.z;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vec3 toCam = normalize(cameraPosition - world.xyz);
  // 1 where the cone is seen face on (its middle), 0 at its silhouette, so the edges fade out
  vEdge = abs(dot(n, toCam));
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
varying float vAlong;
varying float vEdge;
void main() {
  float fall = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.6);
  float start = smoothstep(0.0, 0.06, vAlong);
  // seen along the beam (from behind the platform) the shell is at a grazing angle everywhere, so the edge fade is soft
  float a = uStrength * fall * start * (0.15 + 0.85 * vEdge);
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.18, "rgba(255,246,225,0.85)");
  r.addColorStop(0.5, "rgba(255,240,210,0.22)");
  r.addColorStop(1, "rgba(255,240,210,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface Headlights {
  group: THREE.Group;
  /** Follows the spot lights; `level` 0..1 is the lamp power the user set, `turbidity` 0..1 how much the water scatters. */
  update: (engine: FieldEngine, spots: readonly THREE.SpotLight[], level: number, turbidity: number) => void;
  dispose: () => void;
}

export function createHeadlights(count: number): Headlights {
  const group = new THREE.Group();
  group.name = "platform-headlights";
  // unit cone: apex at the origin, opening along +z to radius 1 at z = 1
  const geo = new THREE.ConeGeometry(1, 1, 40, 8, true);
  geo.translate(0, -0.5, 0);
  geo.rotateX(-Math.PI / 2);
  const tex = glowTexture();
  const beams: { cone: THREE.Mesh; mat: THREE.ShaderMaterial; glow: THREE.Sprite; glowMat: THREE.SpriteMaterial }[] = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: { uColor: { value: new THREE.Color("#fff1d6") }, uStrength: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(geo, mat);
    cone.name = `platform-headlight-cone-${i}`;
    cone.frustumCulled = false;
    cone.renderOrder = 5;
    const glowMat = new THREE.SpriteMaterial({ map: tex, color: "#fff4dc", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const glow = new THREE.Sprite(glowMat);
    glow.name = `platform-headlight-glow-${i}`;
    glow.renderOrder = 6;
    group.add(cone, glow);
    beams.push({ cone, mat, glow, glowMat });
  }
  group.traverse((o) => o.layers.set(VEHICLE_LAYER));
  const dir = new THREE.Vector3();

  return {
    group,
    update(engine, spots, level, turbidity) {
      const lamps = engine.platform.lamps;
      const on = lamps.count > 0 && level > 0.01;
      group.visible = on;
      if (!on) return;
      // a vehicle's lamps sit close together; a station's ride wide on its arm
      const len = BEAM_LENGTH_M * (0.55 + 0.45 * level) * (engine.vehicle ? 1 : 0.8);
      const half = Math.min(MAX_CORE_HALF_ANGLE, ((lamps.beamDeg || 90) * Math.PI) / 1080);
      const r = Math.tan(half) * len;
      // murky water scatters more of the beam back, so it shows more
      const strength = 0.3 * level * (0.6 + 0.8 * turbidity);
      beams.forEach((b, i) => {
        const s = spots[i];
        if (!s) {
          b.cone.visible = b.glow.visible = false;
          return;
        }
        b.cone.visible = b.glow.visible = true;
        b.cone.position.copy(s.position);
        dir.subVectors(s.target.position, s.position);
        if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0);
        b.cone.lookAt(dir.add(s.position));
        b.cone.scale.set(r, r, len);
        b.mat.uniforms.uStrength.value = strength;
        b.glow.position.copy(s.position);
        const g = (engine.vehicle ? 0.32 : 0.4) * (0.5 + 0.5 * level);
        b.glow.scale.set(g, g, g);
        b.glowMat.opacity = 0.35 + 0.65 * level;
      });
    },
    dispose() {
      geo.dispose();
      tex.dispose();
      for (const b of beams) {
        b.mat.dispose();
        b.glowMat.dispose();
      }
    },
  };
}
