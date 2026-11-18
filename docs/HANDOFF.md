# GANTRYLAB Session Handoff

Consolidated state of the project as of 2026-09-15, written so a new session can continue without re-deriving anything.
Read this first, then `docs/BLUEPRINT.md` for the specification.

## 1. What happened

The repo (HydraLoom) was an ROV mission-control dashboard: thrusters, IMU, depth tape, sonar, cyberpunk theme.
On 2026-09-15 it was pivoted, per Deepesh's brief, into GANTRYLAB: a browser prototype of a physical underwater robotics testbed.
The old ROV frontend has been deleted (confirmed by Deepesh).
The Python `backend/` (FastAPI, YOLOv8, MJPEG, UART serial bridge) is untouched and is the documented hardware integration path.

The physical system represented: a 120 x 60 x 60 cm glass aquarium with sand and printed test objects, an XY gantry above it carrying a downward camera in an acrylic housing 8 cm under the water, a Raspberry Pi running detection, a controller choosing gantry moves, an Arduino driving the motors.
Everything in the browser is simulated and the UI says so wherever a number appears.

## 2. Repository map

```
app/layout.tsx          fonts (Inter, IBM Plex Mono via next/font, variables on <html>), metadata
app/globals.css         design tokens (@theme) and utility classes: panel, label, value, btn, btn-primary, btn-active, sim-tag
app/page.tsx            <LabScene /> full-bleed + <LabUI /> overlay
lib/sim/constants.ts    TANK, GANTRY, CAMERA, DETECTION, RL, TEST, gantryToWorld/worldToGantry, NaN-safe clamp
lib/sim/types.ts        every shared type (TestObject, Detection, RLState, Scenario, TestResult, Telemetry, RunPhase)
lib/sim/scenario.ts     six default objects and default scenario
lib/sim/environments.ts test environments (tank, harbor, river, deepsea): water, light source, column, seabed, defaults, lightPaths
lib/sim/rng.ts          mulberry32 seeded PRNG, hash01 stateless jitter
lib/sim/gantry.ts       trapezoidal per-axis motion, PARK = (50, 20) idle pose
lib/sim/detection.ts    pinhole projection, confidence model, hysteresis, in-frame count
lib/sim/policy.ts       greedy step controller with decaying epsilon, reward, ON_TARGET_CM
lib/sim/engine.ts       SimEngine: tick(dt), modes, test runner (HOMING -> SCANNING -> DETECTING -> TRACKING -> COMPLETE), events, telemetry
lib/sim/demo.ts         DEMO_PHASES and stepDemo, phases gated on engine state
lib/sim/store.ts        zustand store: engine + 20 Hz snapshot + UI state (scene, cameraPreset, highlight, selectedObjectId, demo, showVision) + actions
lib/sim/selfcheck.ts    `npm run sim:check` headless assertions
components/lab/         Three.js scene (Scene, CameraRig, Aquarium, Gantry, Electronics, TestObjects, Overlays, FeedRenderer, SimDriver, util, water, weathering, TankDressing, Particles)
components/lab/TankDressing.tsx  per-environment dressing inside the tank: substrate scatter, scale props in the margins (harbor pilings, tyre, chain; river pier, branch; deep-sea outcrops), rig lamps, overview fill, shader warm-up
components/lab/Particles.tsx  suspended particles that read the water optics and drift with the current
lib/optics/water.ts     water optics: per-channel IOPs from turbidity, contrast ratio and water detectability
components/ui/          DOM overlay (LabUI, CameraFeed, Telemetry, scenes, overlays, shared)
docs/BLUEPRINT.md       specification: dimensions, coordinate mapping, formulas, scene plan, design language, hardware mapping
docs/HANDOFF.md         this file
README.md               product-facing description, run instructions, hardware path
```

## 3. Architecture decisions and why

- **Engine outside React.** `lib/sim/` is pure TypeScript, fixed 1/120 s substeps, seeded. It is tested headlessly and the browser result is bit-identical to the Node result.
- **One loop.** `components/lab/SimDriver.tsx` inside the R3F canvas ticks the engine and runs the demo director. It publishes a snapshot to zustand at 20 Hz; 3D components read `useSimStore.getState().engine` directly in `useFrame` for hot values.
- **Smooth motion.** Anything that draws the carriage (beam, carriage, feed camera, lamps, footprint, follow presets, callout) reads `engine.renderPose()`, interpolated between substeps; logic still reads `engine.gantry`. Moves are coordinated straight lines with full-strength braking (`lib/sim/gantry.ts`). Orbit damping is rescaled by frame time in `CameraRig.tsx`, so coasting feels the same at 60 and 144 Hz.
- **Feed = second render pass.** `FeedRenderer.tsx` takes over the render loop (`useFrame(..., 1)`), renders the main camera, then scissors the DOM rect of `#gantry-camera-feed` (constant `FEED_ELEMENT_ID`) and renders the scene again from a PerspectiveCamera at the carriage lens with `up = (0, 0, -1)` looking straight down, through the same water model. The feed element must stay transparent. `detection.ts` `projectToFeed` uses the same convention (feed right = +world X, feed down = +world Z); the two must never diverge.
- **Layers.** Layer 1 = mast and housing (hidden from the feed camera). Layer 2 = HUD overlays (footprint, frustum, rings, grid, callouts), enabled on the main camera only.
- **Water optics.** `lib/optics/water.ts` turns turbidity into per-channel absorption, scattering, beam attenuation `c`, diffuse attenuation `Kd` and deep-water reflectance from published data (Pope and Fry 1997 absorption, Morel 1974 scattering, Kirk `Kd`, `f = 0.33` reflectance); sources in `docs/RESOURCES.md` section 2.
  The scenario's 0..1 turbidity maps to `NTU = 20 t^2` (default 0.45 NTU); particle `c` per NTU is 1.0 m^-1, an assumption until the tank calibration replaces it.
- **Water rendering.** `components/lab/water.ts` patches every scene material (HUD layer 2 excepted) once per material: light below the surface is attenuated by `exp(-Kd depth)`, then the view ray's path inside the water box is found analytically and `I = J exp(-c d) + Binf (1 - exp(-c d))` is applied in linear light before tone mapping.
  The same model serves the main pass (camera in air, path through the glass) and the feed pass (camera under water); scene fog is not used.
  The water body has no mesh. Particles and caustics read the same optics; caustics are an animated Voronoi edge network whose contrast falls as `exp(-b depth)`.
  Detection reads the same optics (section 4).
  Caustics live in the water patch, so every up-facing submerged surface (sand, objects, mound) shares one pattern; contrast falls as `exp(-b depth)`.
- **Test object surfaces.** `components/lab/weathering.ts` adds band-limited 3D gradient noise in object space to a standard material: paint loss to rust with streaks, silt drifts on faces that look up in the world, a growth film, and relief as a bump.
  Octaves fade as their cells approach a pixel, so nothing sparkles at distance. It chains any existing `onBeforeCompile`; the tank sand uses it for grain.
- **Test object geometry** (`TestObjects.tsx`): wreck with frames, rudder, three-bladed propeller, portholes, funnel stump, fallen mast and a sand mound; mine with bolted flange, horn bosses and lead caps, lifting eye and a TRAINING TARGET / INERT plate; pipe with wall thickness, dents and a holed, bolted flange; bracket bent open from an L profile with a real bend radius; displaced, flat-bottomed stones; a grid-holed plastic crate.
  Every model's origin is the object centre used by detection (`halfExtents`); the crate and bracket used to sit 1 to 1.5 cm above the sand because theirs was at the base.
- **Replay = deterministic re-run.** `REPLAY TEST` calls `runTest()` again with the same seed. Tests always begin by driving home physically (HOMING); the clock, seed and log restart on arrival so a test is a pure function of scenario + seed no matter where the carriage was. `resetRun()` keeps the user's scenario; `reset()` restores defaults and is the only instant repositioning.
- **Test environments.** `lib/sim/environments.ts` describes each environment as data: water column, light source (`surface` or `lamp`), NTU range, particle and CDOM properties, seabed reflectance and default turbidity and lighting.
  `Scenario.environment` defaults to `tank`; `setScenario({ environment })` applies the new environment's defaults unless the patch sets them, ignores invalid ids, and the result records the environment.
  Detection uses that environment's water, its seabed as the contrast background, and `lightPaths`: surface light reaches the object through the column above it and lights the veil at the midpoint depth of the lens-to-object path; lamp light starts at the lens, so both scale with the viewing distance.
  The tank environment is exactly `tankWater`, so the tank golden run is unchanged.
- **Environments live inside the tank.** The lab, tank, gantry and objects never change; an environment changes only what is inside the tank: water, floor substrate (`FLOOR` in `Aquarium.tsx`), dressing (`TankDressing.tsx`, group `tank-dressing-<id>`), light and current. See `docs/BLUEPRINT.md` section 4.5.
  Emulated depth light is a brightness-normalised spectral filter on the lab light (`uWaterDepthTint`); the deep sea switches the lab lights off and uses the rig lamps. The tank is never thinned in the main view.
- **Seamless environment switch.** Selecting an environment sets `store.siteReady` false; `components/ui/LabUI.tsx` `SiteVeil` fades the 3D view (and the feed under its transparent frame) to the ground colour in 220 ms.
  `Site` in `components/lab/Scene.tsx` then mounts the new site, patches its materials with the water model and compiles them with `renderer.compileAsync` before lifting the veil, so neither the swap nor a shader compile is seen.
  Switching away and straight back inside the fade lifts the veil without a swap; a rapid chain of switches ends on the last one.
- **Constant light set.** The deep sea's two rig lamps and its overview fill light are mounted in every environment and dark outside the deep, because three.js builds every shader for the scene's light count; adding lights on a switch recompiled every material and stalled the view for about 20 s.
  `DressingWarmup` in `Scene.tsx` precompiles the dressings' shader variants once while the browser is idle (`buildDressingWarmup`), so the first switch is as fast as later ones.
- **Overview aid, labelled.** For the deep sea the main view adds a dim fill light (`overviewFill`), switched off for the feed pass; the site tag says so. The camera feed and detection always use the true water and only the rig's own light.
- **Feed auto-exposure.** The feed pass multiplies exposure by `1 / mean`, where mean is the expected frame level (seabed through the water plus veil, same light paths as detection), clamped to 1..4, as a real camera's auto-exposure does. Exposure scales the whole frame, so contrast and detection are unchanged.
- **RESET keeps the environment.** It restores the engine defaults and then that environment's default water and light; the environment is context, like the scene.
- **GSAP only for camera tweens**, framer-motion for DOM. `gsap.ticker.lagSmoothing(0)` is set so preset moves are wall-clock accurate.
- **Design tokens:** ground #0b1219, panel #101922, teal #3db9b0 = machine state, amber #f2a93b = targets and detections, no neon, no glassmorphism, no em dashes anywhere (project rule).

## 4. Simulation calibration (default scenario: turbidity 0.15, lighting 0.8, threshold 0.6, speed 0.65, seed 1337)

- `confidence = detectability * (1 - 0.30 r^2 - 0.15 burial) * waterDetectability(contrastRatio(optics, d, depth)) * light +- 0.01 seeded jitter`, with `light = lighting^0.3`, or in the lamp-lit deep sea `sqrt(lighting * exp(-Kd d) * (0.42 / d)^2)` (`lampLight`); the water term is the renderer's optics (`lib/optics/water.ts`), so what the feed shows and what the detector reports agree.
- The estimated position is clamped to gantry travel: the sand runs about 9 cm past the rails, and an object in a 3 cm corner can project there.
- Visibility is judged on the projected box (30 percent inside the frame). Hysteresis 0.05 below threshold once detected.
- Class is the true class at >= 0.65, else UNKNOWN, except `confusableAs` objects (the pipe reports as MINE). That is the deterministic false positive.
- Numbers: wreck centred 86.7 percent, wreck from waypoint (50, 30) 82.1, mine from (15, 10) 78.1, mine at park 68.0, pipe 63.2 as MINE, rocks 52.3 and missed. Turbidity 0.6 (7.2 NTU) leaves a centred wreck at 44.7 percent UNKNOWN; from 0.8 (12.8 NTU) nothing is detected at any threshold; lighting 0 detects nothing.
- Environments, centred wreck at (60, 26), lighting 0.8: harbor 2.6 NTU (t 0.2) 75.9 percent, gone by about 11.1 NTU; river 3.5 NTU (t 0.1) 72.5 percent, gone by about 11.3 NTU; deep sea 0.2 NTU (t 0.3) 89.4 percent at lamp power 0.8, 54.7 at 0.3, 31.5 at 0.1, nothing with the lamps off; the water barely matters there, lamp power and distance do.
- Default full test: 5 detected, 4 correct, 1 false positive, ~72.5 percent average, 90 percent coverage, +15.70 reward, 43.4 s, target wreck-01.
- Controller: 5 cm steps clipped to residual error, `ON_TARGET_CM = 1`, episodes end after 3 holds on target or 40 steps, every default target converges under 0.6 cm.
- Demo: about 64 s at default speed (headless), bounded at 264 s by per-phase wall-clock fallbacks, phases OVERVIEW 10 s -> SCAN -> DETECT -> COORDINATES -> POLICY -> MOVE -> TRACKED -> RESULT (12 s, then the closing moment opens itself).

## 5. Verification commands

```bash
npm run typecheck        # tsc, clean
npm run lint             # eslint, clean (ignores .remember/ and backend/)
npm run sim:check        # 148 headless assertions: golden numbers, per-substep invariants, edge-case matrix, store reset, demo bounds
npm run build            # production build, clean
npm run e2e              # Playwright against next dev (reuses a running :3000), about 8 minutes under software GL
npm run e2e:update       # refresh the screenshot baselines in e2e/__screenshots__ after an intended visual change
```

Browser verification lives in `e2e/` (`playwright.config.ts`): boot, navigation, gantry, detection, rl, test-run, camera, scenario, demo, responsive, visual, redteam, explore, environments.
`sim:check` has an environments section: tank water identity, NTU monotonic and NaN-safe, defaults on switch, invalid ids ignored, deterministic field runs, confidence never rising with turbidity, deep sea dark with lamps off, the wreck found at every default, and the exact golden run after switching back.
`e2e/lab.ts` holds the fixture: a console/page-error/failed-request audit that fails any test with an error (only the upstream `THREE.Clock` deprecation and the swiftshader ReadPixels warnings are allowed), a `Lab` helper that reads canonical state through the dev-only `window.__labStore` hook, waits on state predicates (never fixed seconds) and fast-forwards the engine with `engine.tick`.
Other dev-only hooks: `window.__labStats` (draw calls), `window.__labCamera` (camera, controls, tweening()), `window.__labScene`, `window.__labFeedCam`.
Chromium runs with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`; under software GL the first 3 s render below 1 fps (shader warm-up) and the sim then runs at 0.25 to 0.5x wall time, so the wall-clock demo test uses a 1024x640 viewport and a 10 minute budget.
Buttons are CSS-uppercased: locate them with `getByRole("button", { name: /run test/i })`.
Draw calls are 92 to 160 depending on preset.

## 6. Audits performed and their outcome

Five audits plus adversarial QA were run by fresh-context review agents; every finding was fixed unless listed in section 7.

- Security / robustness / performance: no secrets, no external fetches, inputs clamped at the engine (NaN-safe), state machine consistent, dev hooks gated on `NODE_ENV`, narrow zustand selectors, feed pass restores all GL state.
- Robotics realism: stack heights, belt runs, pulley signs, cross shaft, limit switches, cable chains, footprint (64.5 x 48.3 cm), feed orientation, object scale all verified against the code.
- Product / demo: carriage parks mid-tank so the camera reads on landing, callouts have leader lines, demo phases are gated on engine state, result shows numbers and a previous-run delta, plain-language controller card, honest "not a trained network, reward logged not learned from" copy.
- 3D craft: double-sided mirrored water surface with meniscus, real-scale caustics, soft shadows, physically based water, weathered and rebuilt test objects, open-link cable chains, recomposed presets.
- Engineering coherence: monotonic in every scenario parameter, all episode targets converge, corner placements finish.
- Adversarial QA: 40 random rapid clicks, demo interrupts, input abuse, resizes, soak, reload all hold; the nine defects found were fixed (layout band 1000-1259 px, NaN inputs, result lost on aborted homing, "murkier water" runs a test, closing moment exits the demo, label collisions, reset during demo, view-result link, paused telemetry).

### Hardening pass (2026-09-15, second session)

Fresh forensic agents (UI/UX, 3D scene and camera, gantry and simulation) plus a final reviewer went over the running app; every finding was reproduced in the browser or headlessly before it was fixed, and each became a Playwright test or a `sim:check` assertion.

- Simulation: idle controller state now mirrors the gantry (single source of truth), non-finite move targets are dropped instead of sent to a rail end, `tick(NaN)` and negative dt are ignored, `previousResult` rotates only when a scan actually begins, unknown object ids no longer abort a running mode, detection rotation uses the same handedness as the meshes, and every demo phase has a wall-clock exit so the demo always reaches RESULT (bound 264 s).
- Camera: presets are fitted from a view direction plus subject points instead of hand-tuned poses: the subject is centred on the frame horizontally and sits in the band between the header and the bottom card (measured from the overlay elements tagged `data-lab`, refreshed by ResizeObserver), so every viewport frames the whole model and the card never covers it; the detection view stands on the +Z side so screen right = +X like the feed; follow presets stay attached to the carriage through tweens and resets.
- Labels: scene 02 callouts are placed per frame from mesh anchors with collision rejection; axis labels hide when off the useful viewport.
- UI: intentional compact layout below 1000 px (tab strip above a stacked card, feed top right, 176 px feed and a 42 vh card below 760 px so the 3D band survives on phones), brand always visible, reduced-motion respected, visible focus rings, `--color-dim` raised to 4.6:1, Scenario scene uses the top-down preset.

### UI/UX and exploration pass (2026-11-18)

Every defect below was reproduced in a real-GPU Chromium before it was fixed, and each one now has a `sim:check` assertion or a Playwright test (`e2e/explore.spec.ts`, plus a brand-clipping check in `e2e/responsive.spec.ts`).

- Camera feed: commit d59308e wrapped the feed in an opaque `.panel`, which painted over the WebGL render; the feed measured luma 23 of 255 and objects were barely visible. The bezel is now the feed's own box-shadow and the rect stays transparent (luma about 105).
- Detection label flicker: the mine at the park pose reads about 65.5 percent, inside the jitter band of the 0.65 classify threshold, and flipped MINE / UNKNOWN 107 times per 100 s. A confirmed class now holds until 0.03 below the threshold (`CLASS_HYSTERESIS`); golden numbers unchanged.
- Overhead ground-truth rig: preset A cut the mast and arm off at the header; it now frames them. In the top-down preset the arm hid half the tank; the rig is on `OVERHEAD_LAYER` (3), which that preset disables.
- Readability: the scene rail has a backing and the header is 85 percent opaque, so neither reads over bright geometry.
- Free exploration: `EXPLORE` / `E` hides every panel (visibility only, so the framing does not jump) and stops the feed pass; `RECENTER` / `C` refits the current preset even after the user orbited; double-click focuses any part, looking through glass and water; zoom goes toward the cursor; orbit damping is flushed before every programmatic move, which made recenter land 7 cm off.
- XY pad: drag steers the carriage live, arrow keys jog 5 cm (Shift 1 cm), and it is focusable.
- System card rows are keyboard operable (Tab, Enter, Space) and highlight on focus.
- Explore glide: the first orbit, pan, scroll or pinch enters explore; the pivot and distance ease each frame toward the whole-machine fit for the live view direction in the uncovered window, so the gantry lands mid-screen and unclipped. A scroll or pinch hands the distance to the user and the glide only centres. Zoom is no longer toward the cursor, so the machine stays the pivot; double-click covers precise focus.
- Framing determinism: refits fired part way through panel animations, and card swaps that arrived in steps under the 80 px threshold left the old framing (the tank slid under the 768 px card). A scene change or refit now arms a 1.5 s window in which every quiet moment corrects leftovers (`armOverlaySettle` in `components/lab/util.ts`).
- Tests: `Lab.settleCamera()` polls from Node (a `waitForFunction` predicate returning a Promise is truthy at once and never waited); screenshot and detection specs wait on it; the responsive spec waits for the swapped card. Full suite 42 passed, screenshots 21 of 21 over three repeats, `npm run build` clean.
- Header: new buttons collapse to icons at narrow widths so the brand is never clipped (it was clipped at 1024 and 390 px); the 176 px feed header drops its title so the position readout no longer overflows.

## 7. Known limitations and open items

- Preset E is a below-waterline housing shot (art audit); the original "engineering close-up of the carriage" is reachable by orbiting from E, not a preset.
- Only one X-axis cable chain is modelled; the -Z side carries just the idle belt.
- The extruded hull has vertical sides; a bevelled bilge would round it.
- Demo RESULT card covers the lower third of the tank at 1280 x 720; accepted.
- R3F 9.6.1 logs a `THREE.Clock` deprecation warning with three 0.184; not ours.
- The feed bounding box is the projection of the declared `halfExtents`; the mine's horns and the wreck's scattered fragments extend a few cm beyond that box (up to about 13 px and 40 px in a 438 px feed). Enlarging the extents would shift the calibrated numbers, so it is left as is.
- Under software GL the first seconds render below 1 fps while shaders compile; a real GPU takes well under a second.
- Preset D is near top-down by necessity: any lower angle from the +Z side puts the X cable chain across the housing.
- The Y cable chain covers the mine's +X edge in scene 3 at the park pose; it is the physical chain beside the beam.
- Particle attenuation is assumed at 1.0 m^-1 per NTU in every environment; it is not calibrated against measured water yet (the tank capture in `docs/RESOURCES.md` section 8.3 is the plan).
- The deep-sea veil uses an exponential lamp path (object lit over the viewing distance, veil at half of it), not a full beam model with lamp offset, beam pattern and inverse-square falloff.
- Forward-scatter blur is not modelled: turbid water lowers contrast but does not soften edges.
- The 2026-11-18 pass is uncommitted in the working tree; commit only on the owner's instruction.

## 8. Hardware integration path

Arduino: GRBL or a step/dir sketch on the Uno + CNC shield; the Pi sends moves over USB serial (`backend/serial_bridge.py` speaks JSON lines over UART).
Camera: `backend/vision_pipeline.py` runs YOLOv8 and streams MJPEG; remap classes to SHIPWRECK, MINE, DEBRIS.
Telemetry: `backend/main.py` pushes state over `/ws/telemetry`; replace `SimEngine.tick()` with packets from that socket and keep the store shape.
Controller: port `policy.ts` to the Pi, or drop in a trained policy on the same observation.
Ground truth: the overhead camera on the centre arm scores detections against reality.

## 9. Working agreements from this session

- Dimensions live only in `lib/sim/constants.ts`; nothing else hard codes them.
- If code and `docs/BLUEPRINT.md` disagree, fix one in the same change.
- Every sentence on its own line in long Markdown; plain dashes only.
- Sub-agents own directories: 3D agent `components/lab/**`, UI agent `components/ui/**`; store and engine changes go through the orchestrator.
- Evidence before acceptance: every agent report follows WHAT CHANGED / WHY / HOW / TESTED / FAILED / FIXED / REMAINS with screenshot paths.
