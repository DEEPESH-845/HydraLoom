---
name: threejs-r3f-engineering
description: Conventions for the GANTRYLAB Three.js / React Three Fiber scenes (Gantry Lab and field worlds). Use before editing anything under components/lab or components/field, adding meshes, materials, render passes, cameras or particles.
---

# Three.js and React Three Fiber in GANTRYLAB

Versions are pinned: three 0.184, @react-three/fiber 9.6, drei 10.7, React 19.2, Next 16.
Do not upgrade majors without a measured need.
Docs: https://threejs.org/docs/ and https://r3f.docs.pmnd.rs/.

## Rules that are easy to break

- Physics and simulation state never live in React components.
  Engines are in `lib/` (pure TS, fixed 120 Hz step); one driver per canvas ticks the engine in `useFrame` and publishes a snapshot to zustand at 15 to 20 Hz.
  Hot per-frame values are read with `store.getState().engine` inside `useFrame`, never through React state.
- Draw moving bodies at `engine.renderPose()` (interpolated between substeps), never at the raw substep pose.
- Every lit material goes through the water model: `patchSceneWater(scene, OVERLAY_LAYER)` in `components/lab/water.ts`.
  Do not use scene fog.
  Self-shaded materials include `WATER_GLSL` and call `waterApply`.
  HUD objects live on the overlay layer (2) and are skipped by the patch.
- The camera feed is a second render pass into a DOM rect (`FeedRenderer`), restoring viewport, scissor, autoClear, background and every uniform it changes.
  The feed always uses true water (`uWaterViewScale = 1`) and never sees overview aids (fill lights, thinning).
- The feed camera convention must match the analytic projection in `lib/sim/detection.ts` (lab) or `lib/field/camera.ts` (field).
  If you change one, change the other and the test that ties them.
- The light count must stay constant across environment switches (three.js compiles a program per light count); add lights once and dim them.
- Switch worlds behind a veil: mount, patch, `renderer.compileAsync`, then reveal.
- Repeated geometry uses `InstancedMesh`; dispose geometries, materials and textures you create in `useMemo` when the component unmounts.
- Dev-only hooks (`window.__labStore`, `window.__fieldStore`, ...) are gated on `process.env.NODE_ENV !== "production"`.

## Design language

Marine lab, not startup: ground `#0b1219`, teal = machine state, amber = targets and detections, Inter and IBM Plex Mono, 1 px borders, no neon, no glassmorphism, no em dashes in any text.
Every number shown is labelled SIMULATED, MEASURED or ESTIMATED.
