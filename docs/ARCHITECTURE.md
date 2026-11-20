# GANTRYLAB Platform Architecture

GANTRYLAB is a browser-based underwater robotics digital twin and model-evaluation platform.
The physical Gantry Lab testbed is one of its testing modes.
This document records the verified starting point, the architecture that replaced it, the decisions behind it and the validation matrix.
Physical models are in `docs/PHYSICS.md`; the backend contract is in `docs/API_V1.md`.

## 1. Starting point (verified 2026-11-20, commit c531632)

### 1.1 What existed

- A single Next.js 16 page (`app/page.tsx`) rendering the Gantry Lab: a 120 x 60 x 60 cm aquarium, an XY gantry with a downward camera, six test objects.
- `lib/sim/`: a pure, deterministic, fixed-step (120 Hz) engine (`SimEngine`) with gantry motion, an analytical detector, a greedy step controller, a test runner and a zustand store publishing at 20 Hz.
- `lib/optics/water.ts`: physically based per-channel water optics (Pope and Fry absorption, Morel scattering, Kirk Kd, deep-water reflectance) shared by the renderer and the detector.
- `components/lab/`: the R3F scene, a water patch applied to every material, a second render pass for the camera feed, seamless environment switching and four in-tank environment emulations (tank, harbor, river, deep sea).
- `components/ui/`: seven scene cards, telemetry, demo mode.
- `e2e/`: 43 Playwright tests with a strict console audit and 21 screenshot baselines; `npm run sim:check` with 148 headless assertions.
- `backend/`: a legacy FastAPI service from the earlier ROV dashboard (thruster physics, MJPEG, serial bridge, COCO YOLOv8n on a looping MP4), not connected to the frontend, loading `.pt` files with `weights_only=False` monkeypatched into `torch.load`.

Baseline at the start: typecheck, lint, `sim:check`, build clean; E2E 43 of 43 passed in 18.9 minutes.

### 1.2 Limitations that drove the redesign

1. Every environment lived inside the gantry's tank: environment, platform and test were one thing.
2. No vehicle other than the gantry, no water current model beyond a uniform particle drift, no vehicle dynamics.
3. The detector was analytical only; there was no way to evaluate a real trained model.
4. No ground-truth image generation, no metrics engine, no reporting.
5. The legacy backend executed arbitrary pickles in-process.
6. One fixed scan plan; no controller comparison; no hardware safety boundary.

### 1.3 Preserved without behaviour change

- The Gantry Lab experience, its engine, golden numbers and screenshot baselines (now at `/lab`).
- The water optics model, reused by the field worlds and the field detector.
- The lab's in-tank environment emulation (a test tank recreating field water), which remains a lab feature.

## 2. Separation of concerns

The central decision: environments, platforms, missions and the test run are independent axes.

| Concept | Module | Owns | Never owns |
|---|---|---|---|
| Environment | `lib/world/` | water (optics, temperature, salinity, stratification), light source, terrain, seabed, current regime, scenery, ground-truth targets, assumptions | any platform or rig |
| Platform | `lib/platforms/` | vehicle parameters, camera mount, lamps, sensors, compute profile | any place |
| Mission | `lib/missions/` | objective, route generator, metrics | geometry or vehicle physics |
| Physics | `lib/physics/` | current field, water properties, 6-DOF dynamics, autopilots | rendering, React |
| Field engine | `lib/field/` | composition of the above, fixed-step loop, analytical detector, mission statistics | rendering, React |
| Gantry Lab | `lib/sim/`, `lib/gantry/`, `lib/hardware/` | the bench-top rig, its strategies and the hardware safety boundary | field environments |

The Gantry Lab appears in the environment selector as a preset that routes to `/lab`; its gantry is not part of any environment definition.
A field environment cannot create a gantry: `validateEnvironment` rejects `gantry` in a field environment's platforms, `compatibility()` refuses it, and the field E2E suite asserts no gantry, rail or beam exists in any field scene.

## 3. Environment definitions

Versioned data (`schemaVersion: 1`, semver `version`) in `lib/world/environments.ts`, typed by `lib/world/schema.ts` and validated by `validateEnvironment` (physical ranges with units, consistency rules such as fresh water below 0.5 PSU, unique target ids, targets inside the site).
Terrain is a pure function (`lib/world/terrain.ts`) shared by the renderer, the collision model, the current's boundary layer and target placement, so what is drawn is what is simulated.

## 4. Field simulation

`FieldEngine` composes one environment, one platform and one mission:

1. fixed 1/120 s substeps (`tick(dt)` with an accumulator, `advance(seconds)` for headless use, a pause flag and a time scale);
2. the water current is sampled at the vehicle and passed to the dynamics as a world vector; free-floating targets relax toward the local water velocity;
3. the platform's autopilot (ROV station keeping and waypoints, AUV line-of-sight survey, manual control) produces actuator commands, `stepVehicle` integrates them with collisions against terrain and structures;
4. at 10 Hz the analytical detector runs from the platform camera's pose;
5. mission statistics: distance, thruster energy, cross-track RMS, seabed coverage, targets found, classes, false positives, first-detection range, contacts.

The engine is deterministic: the same environment, platform, mission, conditions and seed give bit-identical telemetry, detections and events (tested).
The 3D world (`components/field/`) reads the engine; it never writes physics.

## 5. Model evaluation pipeline

```
3D twin (browser)                     backend (FastAPI, /api/v1)                     reports
-----------------                     --------------------------                     -------
platform camera pass --PNG-->  datasets: validate, store, YOLO + COCO export
instance-ID pass ----GT----->           |
                                         v
user best.pt / .onnx ------->  models: size/magic checks, SHA-256, read-only original
                                         |  inspection in sandbox worker (restricted unpickler)
                                         v
                               runs: background thread -> sandbox worker -> adapter (Ultralytics, ONNX, mock)
                                         |  predictions, latency, memory, CPU/GPU
                                         v
                               metrics engine (numpy): P/R/F1, AP50, AP50:95, confusion, slices
                                         |
                                         v
                               evidence payload --> LLM provider (Anthropic / OpenAI / Ollama) or deterministic
                                         |  schema validation, numbers overwritten from evidence
                                         v
                               report JSON / HTML, config patch copies, follow-up Q&A
```

Separations that are enforced:

- Analytical detector (simulation) versus neural inference (backend adapters): different code paths, different labels.
- Mock adapter (CI) versus real adapters: `mock: true` on every artefact.
- Measured (the host that ran inference) versus estimated (other compute profiles, with stated assumptions) versus simulated.
- Inference versus reporting: separate services; the LLM receives aggregated evidence only, never weights or images.

Both test modes produce datasets: the field worlds (`components/field/capture.ts`) and the Gantry Lab (`components/lab/capture.ts`, Vision card), on a shared engine-independent core (`components/capture/core.ts`).
The lab capture uses the same water functions as the live feed (`labWater`, `labFeedPass` in `components/lab/FeedRenderer.tsx`) and never moves the engine.
With device `auto`, a CUDA context failure falls back to the CPU and the run records the device that actually executed, so latency is never labelled GPU when the CPU ran it.

Ground truth comes from geometry: the same camera renders an instance-ID pass in which each target is a flat unique colour and everything else is a black occluder, giving tight boxes, visible pixel area, truncation and occlusion.

## 6. Gantry autonomy

Inspection strategies (`lib/gantry/strategies.ts`) implement one interface, `ScanPlanner.next(observation)`, called by the lab's test runner each time the carriage has arrived and dwelt:

| Strategy | Kind | Behaviour |
|---|---|---|
| Serpentine | fixed | the original six-waypoint plan; reproduces the golden run exactly |
| Coverage | fixed | boustrophedon spaced from the detection-grade footprint; images every floor cell |
| Detection-driven | reactive | serpentine plus a re-centring visit to each detection below the classify threshold |
| Uncertainty-driven | active perception | greedy next-best-view over unimaged cells and low-confidence detections, traded against travel time |
| User waypoints | fixed | a user list, clamped to travel |

All are heuristics and the UI says so; a trained policy would implement the same interface on the same observation.
`lib/gantry/evaluate.ts` runs every strategy on an identical copy of the scenario and seed and reports coverage, duration, travel, acquisition rate, misses, false positives and the confidence gained by re-centring; the Result card shows the comparison.

## 7. Hardware safety boundary

`lib/hardware/safety.ts` is the only path from a command to a hardware adapter (`SafeGantryLink`):
explicit ARM with a confirmation phrase and a live link, HOME before any MOVE, soft limits (rejected, never clamped), speed limit, limit-switch direction checks, heartbeat watchdog that faults and sends STOP, latched E-stop and fault states that reset only to DISARMED, operator approval for any controller or AI command, and a dry-run mode that never transmits to a serial adapter.
Simulated motion never goes through a physical adapter.

## 8. Frontend structure

| Route | Workspace |
|---|---|
| `/` | Platform shell: 01 Environment Explorer, 02 Platform, 03 Simulation Control, 05 live Analysis, over the field 3D world |
| `/lab` | Gantry Lab (unchanged experience, plus inspection strategies and dataset capture) |
| `/field` | redirects to `/`, keeping `?ws=` |
| `/models` | 04 Model Laboratory |
| `/reports`, `/reports/[runId]` | 05 evaluation analysis and 06 AI engineering reports |

Context between workspaces: the selected environment and platform persist in local storage; models, datasets, runs and reports persist on the backend.

## 9. Validation matrix

| Requirement | Verified by |
|---|---|
| Environment schema validation | `lib/field/field.test.ts` environment library suite |
| Environments physically distinct | `lib/field/field.test.ts` |
| No gantry in field environments | `lib/field/field.test.ts`, `e2e/field.spec.ts` |
| Current convention, profiles, potential flow, divergence-free turbulence | `lib/physics/physics.test.ts` |
| Drag opposes relative motion, drift to water velocity, thrust-drag balance | `lib/physics/physics.test.ts` |
| Fresh-water buoyancy and re-ballasting | `lib/physics/physics.test.ts` |
| Collisions with seabed and structures | `lib/physics/physics.test.ts` |
| ROV station keeping and loss of station, AUV survey | `lib/physics/physics.test.ts` |
| Determinism (physics, field engine, lab strategies) | unit tests |
| Turbidity never improves visibility, contrast or confidence | `lib/field/field.test.ts`, `npm run sim:check` |
| Camera projection convention | `lib/field/field.test.ts`, `e2e/field.spec.ts` |
| Floating objects drift with the current | `lib/field/field.test.ts` |
| Lab golden run unchanged | `npm run sim:check`, `lib/gantry/gantry.test.ts` |
| Strategies terminate, cover, improve confidence | `lib/gantry/gantry.test.ts` |
| Hardware safety rules | `lib/gantry/gantry.test.ts` safety suite |
| Upload validation, sandboxing, malicious pickle rejection | `backend/tests_gantrylab` |
| Metrics against hand-computed references | `backend/tests_gantrylab` |
| Report schema, LLM fallback, patch copies | `backend/tests_gantrylab` |
| Synthetic annotations match geometry | `e2e/field.spec.ts`, `e2e/lab-capture.spec.ts` |
| Model Lab and Reports flows, MOCK labelling, backend-down state | `e2e/evaluation.spec.ts` |
| Physical gantry safety on the backend | `backend/tests_gantrylab/test_gantry_safety.py` |
| UI, responsive layouts, console errors, visual regressions | `e2e/` |

## 10. Development tooling

- Official Anthropic plugins enabled at project scope in `.claude/settings.json`: `feature-dev`, `frontend-design`, `claude-code-setup`.
  The Playwright MCP plugin was not added: the repository's Playwright suite already drives the browser with stricter console auditing.
- Project skills in `.claude/skills/`: `threejs-r3f-engineering`, `underwater-simulation-physics`, `computer-vision-evaluation`, `simulation-quality-assurance`.
