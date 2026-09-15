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
lib/sim/rng.ts          mulberry32 seeded PRNG, hash01 stateless jitter
lib/sim/gantry.ts       trapezoidal per-axis motion, PARK = (50, 20) idle pose
lib/sim/detection.ts    pinhole projection, confidence model, hysteresis, in-frame count
lib/sim/policy.ts       greedy step controller with decaying epsilon, reward, ON_TARGET_CM
lib/sim/engine.ts       SimEngine: tick(dt), modes, test runner (HOMING -> SCANNING -> DETECTING -> TRACKING -> COMPLETE), events, telemetry
lib/sim/demo.ts         DEMO_PHASES and stepDemo, phases gated on engine state
lib/sim/store.ts        zustand store: engine + 20 Hz snapshot + UI state (scene, cameraPreset, highlight, selectedObjectId, demo, showVision) + actions
lib/sim/selfcheck.ts    `npm run sim:check` headless assertions
components/lab/         Three.js scene (Scene, CameraRig, Aquarium, Gantry, Electronics, TestObjects, Overlays, FeedRenderer, SimDriver, util)
components/ui/          DOM overlay (LabUI, CameraFeed, Telemetry, scenes, overlays, shared)
docs/BLUEPRINT.md       specification: dimensions, coordinate mapping, formulas, scene plan, design language, hardware mapping
docs/HANDOFF.md         this file
README.md               product-facing description, run instructions, hardware path
```

## 3. Architecture decisions and why

- **Engine outside React.** `lib/sim/` is pure TypeScript, fixed 1/120 s substeps, seeded. It is tested headlessly and the browser result is bit-identical to the Node result.
- **One loop.** `components/lab/SimDriver.tsx` inside the R3F canvas ticks the engine and runs the demo director. It publishes a snapshot to zustand at 20 Hz; 3D components read `useSimStore.getState().engine` directly in `useFrame` for hot values.
- **Feed = second render pass.** `FeedRenderer.tsx` takes over the render loop (`useFrame(..., 1)`), renders the main camera, then scissors the DOM rect of `#gantry-camera-feed` (constant `FEED_ELEMENT_ID`) and renders the scene again from a PerspectiveCamera at the carriage lens with `up = (0, 0, -1)` looking straight down, with denser fog. The feed element must stay transparent. `detection.ts` `projectToFeed` uses the same convention (feed right = +world X, feed down = +world Z); the two must never diverge.
- **Layers.** Layer 1 = mast and housing (hidden from the feed camera). Layer 2 = HUD overlays (footprint, frustum, rings, grid, callouts), enabled on the main camera only.
- **Fog.** Main pass uses `FogExp2` with density from turbidity; above-water materials set `fog: false`, underwater materials keep it, so silt dissolves far objects without touching the gantry.
- **Replay = deterministic re-run.** `REPLAY TEST` calls `runTest()` again with the same seed. Tests always begin by driving home physically (HOMING); the clock, seed and log restart on arrival so a test is a pure function of scenario + seed no matter where the carriage was. `resetRun()` keeps the user's scenario; `reset()` restores defaults and is the only instant repositioning.
- **GSAP only for camera tweens**, framer-motion for DOM. `gsap.ticker.lagSmoothing(0)` is set so preset moves are wall-clock accurate.
- **Design tokens:** ground #0b1219, panel #101922, teal #3db9b0 = machine state, amber #f2a93b = targets and detections, no neon, no glassmorphism, no em dashes anywhere (project rule).

## 4. Simulation calibration (default scenario: turbidity 0.15, lighting 0.8, threshold 0.6, speed 0.65, seed 1337)

- `confidence = detectability * (1 - 0.30 r^2 - 0.15 burial) * exp(-1.1 turbidity^2 d/0.42) * lighting^0.3 +- 0.01 seeded jitter`
- Visibility is judged on the projected box (30 percent inside the frame). Hysteresis 0.05 below threshold once detected.
- Class is the true class at >= 0.65, else UNKNOWN, except `confusableAs` objects (the pipe reports as MINE). That is the deterministic false positive.
- Numbers: wreck centred 85.6 percent, wreck from waypoint (50, 30) 81.0, mine from (15, 10) 74.9, pipe 62.4 as MINE, rocks missed. Lighting 0 detects nothing at any threshold; turbidity 1 detects nothing at the default threshold (about 31 percent UNKNOWN at the 0.3 floor); turbidity 0.6 leaves a centred wreck at ~61 percent UNKNOWN.
- Default full test: 5 detected, 3 correct, 1 false positive, ~71 percent average, 90 percent coverage, +15.6 reward, 43.4 s, target wreck-01.
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

Browser verification lives in `e2e/` (`playwright.config.ts`): boot, navigation, gantry, detection, rl, test-run, camera, scenario, demo, responsive, visual, redteam.
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
- 3D craft: double-sided mirrored water surface with meniscus, real-scale caustics, soft shadows, main-pass silt fog, rebuilt hull-section wreck, open-link cable chains, recomposed presets.
- Engineering coherence: monotonic in every scenario parameter, all episode targets converge, corner placements finish.
- Adversarial QA: 40 random rapid clicks, demo interrupts, input abuse, resizes, soak, reload all hold; the nine defects found were fixed (layout band 1000-1259 px, NaN inputs, result lost on aborted homing, "murkier water" runs a test, closing moment exits the demo, label collisions, reset during demo, view-result link, paused telemetry).

### Hardening pass (2026-09-15, second session)

Fresh forensic agents (UI/UX, 3D scene and camera, gantry and simulation) plus a final reviewer went over the running app; every finding was reproduced in the browser or headlessly before it was fixed, and each became a Playwright test or a `sim:check` assertion.

- Simulation: idle controller state now mirrors the gantry (single source of truth), non-finite move targets are dropped instead of sent to a rail end, `tick(NaN)` and negative dt are ignored, `previousResult` rotates only when a scan actually begins, unknown object ids no longer abort a running mode, detection rotation uses the same handedness as the meshes, and every demo phase has a wall-clock exit so the demo always reaches RESULT (bound 264 s).
- Camera: presets are fitted from a view direction plus subject points instead of hand-tuned poses: the subject is centred on the frame horizontally and sits in the band between the header and the bottom card (measured from the overlay elements tagged `data-lab`, refreshed by ResizeObserver), so every viewport frames the whole model and the card never covers it; the detection view stands on the +Z side so screen right = +X like the feed; follow presets stay attached to the carriage through tweens and resets.
- Labels: scene 02 callouts are placed per frame from mesh anchors with collision rejection; axis labels hide when off the useful viewport.
- UI: intentional compact layout below 1000 px (tab strip above a stacked card, feed top right, 176 px feed and a 42 vh card below 760 px so the 3D band survives on phones), brand always visible, reduced-motion respected, visible focus rings, `--color-dim` raised to 4.6:1, Scenario scene uses the top-down preset.

## 7. Known limitations and open items

- Preset E is a below-waterline housing shot (art audit); the original "engineering close-up of the carriage" is reachable by orbiting from E, not a preset.
- Diagonal moves are dog-legs (independent axes), not a planned straight line.
- Only one X-axis cable chain is modelled; the -Z side carries just the idle belt.
- The extruded hull has vertical sides; a bevelled bilge would round it.
- Demo RESULT card covers the lower third of the tank at 1280 x 720; accepted.
- R3F 9.6.1 logs a `THREE.Clock` deprecation warning with three 0.184; not ours.
- The feed bounding box is the projection of the declared `halfExtents`; the mine's horns and the wreck's scattered fragments extend a few cm beyond that box (up to about 13 px and 40 px in a 438 px feed). Enlarging the extents would shift the calibrated numbers, so it is left as is.
- Under software GL the first seconds render below 1 fps while shaders compile; a real GPU takes well under a second.
- Preset D is near top-down by necessity: any lower angle from the +Z side puts the X cable chain across the housing.
- The Y cable chain covers the mine's +X edge in scene 3 at the park pose; it is the physical chain beside the beam.
- Nothing has been committed; the working tree holds the full change set plus `e2e/` and `playwright.config.ts`.

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
