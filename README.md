# GANTRYLAB

**A browser-based underwater robotics digital twin and model-evaluation platform, with the physical Gantry Lab testbed as one of its modes.**

- Six field environments (harbor, river, deep sea, coral reef, lake, open ocean) with their own water, terrain, current and targets; an ROV, an AUV or a seabed camera station flies in them under six-degree-of-freedom dynamics and a configurable water current.
- The Gantry Lab (`/lab`): the bench-top aquarium and XY gantry described below.
- Synthetic, ground-truth-labelled datasets from either mode; upload a YOLO `best.pt` or ONNX model, evaluate it on the backend, and get an evidence-grounded engineering report.

Architecture: `docs/ARCHITECTURE.md`. Physics and assumptions: `docs/PHYSICS.md`. Backend API: `docs/API_V1.md` and `backend/README_GANTRYLAB.md`.

Testing underwater drones and their perception systems in rivers, lakes and reservoirs is expensive, slow, risky and hard to repeat.
GANTRYLAB is a controlled alternative: an aquarium with printed test objects on a sand floor, a motorized XY gantry above it carrying a downward-facing camera, a Raspberry Pi running object detection, a control policy that decides where to move the camera, and an Arduino driving the motors.
The same scenario can be run again and again with identical inputs.

This repository contains a browser simulation of that machine.
Everything in the browser is simulated and the interface says so wherever a number is shown.
The Python backend in `backend/` is the path to real hardware.

```
PHYSICAL ENVIRONMENT -> CAMERA -> RASPBERRY PI -> OBJECT DETECTION
        ^                                              |
        |                                       POSITION / CONFIDENCE
        |                                              |
   X-Y GANTRY <- ARDUINO <- CONTROL POLICY <-----------+
```

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000 for the platform (environments, platforms, simulation, live analysis), http://localhost:3000/lab for the Gantry Lab, `/models` for the Model Lab and `/reports` for analysis and reports.
In the Gantry Lab the scene index on the left walks through seven scenes; `RUN DEMO` plays an autonomous narrated sequence of about 75 seconds.

The Model Lab and Reports need the evaluation backend:

```bash
cd backend
# one-time install: the exact commands are in backend/README_GANTRYLAB.md (CUDA 12.8 or CPU torch wheels)
.venv/Scripts/python -m uvicorn gantrylab.app:app --port 8000
```

Other scripts:

| Command | What it does |
|---|---|
| `npm run test:unit` | Unit tests of the physics, field engine, environments, gantry strategies and hardware safety (`lib/**/*.test.ts`) |
| `npm run e2e` | Playwright suite (lab, field, capture, evaluation UI) |
| `npm run sim:check` | Headless check of the simulation engine: determinism, rail limits, a full test run, a hard scenario, motion settling |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build` | Production build |

Continuing development in a new session: read `docs/HANDOFF.md` first, then `docs/BLUEPRINT.md`.

## What you see

| Scene | Camera | Content |
|---|---|---|
| 01 Overview | three-quarter | The whole testbed. `RUN SIMULATION` starts a full test |
| 02 System | three-quarter | Numbered callouts for gantry, camera, aquarium, Raspberry Pi, Arduino, test objects, plus the simulation to hardware mapping |
| 03 Vision | detection viewpoint | The gantry camera feed rendered from the carriage, bounding boxes, confidence, estimated floor coordinates |
| 04 Gantry | top-down | Target, coordinate, path, carriage motion; an XY pad to move the gantry by hand |
| 05 Control | top-down | The control loop: state, action, reward, next state, exploration |
| 06 Scenario | three-quarter | Turbidity, lighting, detection threshold, gantry speed, object positions; `RUN TEST` |
| 07 Result | three-quarter | Objects detected, correct classifications, false positives, confidence, coverage, reward, duration; `REPLAY TEST`; the closing "simulation to field" moment |

## Exploring the model

- Drag to orbit, right-drag to pan, scroll or pinch to zoom; the camera can go all the way around, including underneath.
- The first orbit, pan or zoom enters explore mode: the panels step aside and the machine glides to the middle of the window, re-framed for the live view direction until it settles.
- Double-click any part to make it the orbit centre; glass and water are looked through, so a click on an object in the tank lands on the object.
- `EXPLORE` (or `E`) hides every panel so the whole window is the machine; `Esc` or `DONE` brings them back.
- `RECENTER` (or `C`) returns to the current scene's framed view.
- Scene 04's XY pad moves the carriage on click, steers it live while dragged, and jogs it 5 cm with the arrow keys (1 cm with Shift).
- `1` to `7` and the arrow keys switch scenes.

## How the simulation works

The engine is pure TypeScript in `lib/sim/`, deterministic and fixed-timestep, with no React dependency.
`docs/BLUEPRINT.md` is the specification: physical dimensions, the coordinate mapping, the detection and control formulas, and the scene plan.

- **Gantry** (`gantry.ts`): each axis follows a trapezoidal velocity profile toward its target, 15 cm/s max, 30 cm/s^2, clamped to 100 x 40 cm of travel. The axes are coordinated so every move is a straight line, and the 3D view interpolates between simulation steps so motion is smooth at any display rate. The carriage never teleports and never leaves the rails.
- **Detection** (`detection.ts`): the camera is a pinhole 42 cm above the sand with a 75 degree horizontal field of view. Objects are projected into the frame; confidence is `detectability * geometry * water * light`, where geometry falls off with distance from the optical axis and burial in sand, water is the fraction of the object's contrast against the sand that survives the water path, from the same optics the renderer draws (zero at the 2 percent contrast threshold), and light is `lighting^0.3` (in the lamp-lit deep sea, the square root of the lamp's irradiance on the object, falling off with the square of distance), so no light sees nothing and heavy silt sees nothing at the default threshold. Bounding boxes are real projections of the object bounds. Objects below the threshold are missed; low-confidence detections degrade to `UNKNOWN`, and one debris object is deliberately confusable with the training target, which gives a deterministic false positive.
- **Control** (`policy.ts`): a greedy controller over five actions (`MOVE_X+`, `MOVE_X-`, `MOVE_Y+`, `MOVE_Y-`, `HOLD`) with epsilon exploration that decays with episode number, seeded so replays are identical. Reward is distance closed per step, plus a confidence bonus, minus a step cost, plus a bonus for holding on target. The reward is logged, not learned from; the interface says so. A trained policy would consume the same observation.
- **Test runner** (`engine.ts`): drive home, scan six waypoints, record detections, pick the best correct detection as the target, run one control episode, report. `REPLAY TEST` re-runs with the same seed and produces the same numbers.
- **Feed** (`components/lab/FeedRenderer.tsx`): the camera feed panel is the same Three.js scene rendered a second time from the carriage camera, so what you see in the feed is what the gantry camera would see.
- **Water** (`lib/optics/water.ts`, `components/lab/water.ts`): turbidity is shown in NTU with the range at which contrast falls to 2 percent. Per-channel absorption and scattering come from published pure-water data plus a clay suspension; every submerged surface is attenuated along its true path through the water and veiled by the scattered light, in both views.

## Environments

The same rig, objects and test run in four waters, chosen with `setScenario({ environment })` (`lib/sim/environments.ts`).

- **Lab tank**: the controlled baseline and calibration anchor, 0.45 NTU by default.
- **Harbor**: pier and hull inspection in grey-green coastal water over mud, 6 m deep, 2.6 NTU by default.
- **River**: bridge pier inspection in grey-brown, silt-laden water in a 1.2 m reach, 3.5 NTU by default, up to 150 NTU in a spate.
- **Deep sea**: no daylight at 1500 m; only the rig's lamps light the scene, so lamp power is the limit.

Each environment sets its own water (particles, dissolved organic matter, turbidity range), light source and seabed, and switching applies its default turbidity and lighting.
Detection reads the same water and light paths the renderer draws, and every result records the environment.
Every environment is recreated inside the gantry's own tank, as a test tank emulates field conditions: the water, the floor substrate, small scale props in the margins, the light at depth and, for the river, a slow flume current. The rig and the test objects never change, so results are comparable across environments.
`docs/BLUEPRINT.md` section 4.5 has the parameters and calibration.

## Project structure

```
app/                    Next.js App Router shell and design tokens
components/lab/         Three.js scene: aquarium, gantry, electronics, test objects, overlays, feed renderer, camera rig
components/ui/          DOM overlay: top bar, scene rail, camera feed frame, telemetry, scene cards, demo controller, closing moment
lib/sim/                Simulation engine (constants, types, scenario, gantry, detection, policy, engine, demo, store, selfcheck)
docs/BLUEPRINT.md       System specification
backend/gantrylab/       evaluation service: model registry, sandboxed inference, metrics, reports, gantry safety
backend/                legacy FastAPI service with YOLOv8, MJPEG streaming and a UART serial bridge (hardware path)
```

## From simulation to hardware

The browser engine's `tick()` produces the same telemetry shape a real rig would report: gantry position and velocity, camera frame counter, detections with bounding boxes and confidence, controller state.
To connect hardware:

1. **Arduino**: flash GRBL or a small step/dir sketch on the Uno + CNC shield; the Raspberry Pi sends `G0 X.. Y..` or a JSON move over USB serial (`backend/serial_bridge.py` already implements a JSON line protocol over UART).
2. **Raspberry Pi camera**: `backend/vision_pipeline.py` already captures frames, runs YOLOv8 and streams MJPEG; retrain or remap classes to `SHIPWRECK`, `MINE`, `DEBRIS`.
3. **Telemetry**: `backend/main.py` pushes state over `/ws/telemetry`; replace `SimEngine.tick()` with packets from that socket and keep the store shape.
4. **Controller**: move `policy.ts` logic to the Pi, or swap in a trained policy that consumes the same observation.
5. **Ground truth**: the fixed overhead camera on the frame gives object and carriage positions for scoring detections against reality.

## License

Private and proprietary.
