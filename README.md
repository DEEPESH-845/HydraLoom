# GANTRYLAB

**An interactive prototype of a physical underwater robotics testbed.**

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

Open http://localhost:3000.
The scene index on the left walks through seven scenes; `RUN DEMO` plays an autonomous narrated sequence of about 75 seconds.

Other scripts:

| Command | What it does |
|---|---|
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

## How the simulation works

The engine is pure TypeScript in `lib/sim/`, deterministic and fixed-timestep, with no React dependency.
`docs/BLUEPRINT.md` is the specification: physical dimensions, the coordinate mapping, the detection and control formulas, and the scene plan.

- **Gantry** (`gantry.ts`): each axis follows a trapezoidal velocity profile toward its target, 15 cm/s max, 30 cm/s^2, clamped to 100 x 40 cm of travel. The carriage never teleports and never leaves the rails.
- **Detection** (`detection.ts`): the camera is a pinhole 42 cm above the sand with a 75 degree horizontal field of view. Objects are projected into the frame; confidence is `detectability * geometry * water * light`, where geometry falls off with distance from the optical axis and burial in sand, water is `exp(-1.1 * turbidity^2 * distance / 0.42)`, and light is `lighting^0.3`, so no light sees nothing and heavy silt sees nothing at the default threshold. Bounding boxes are real projections of the object bounds. Objects below the threshold are missed; low-confidence detections degrade to `UNKNOWN`, and one debris object is deliberately confusable with the training target, which gives a deterministic false positive.
- **Control** (`policy.ts`): a greedy controller over five actions (`MOVE_X+`, `MOVE_X-`, `MOVE_Y+`, `MOVE_Y-`, `HOLD`) with epsilon exploration that decays with episode number, seeded so replays are identical. Reward is distance closed per step, plus a confidence bonus, minus a step cost, plus a bonus for holding on target. The reward is logged, not learned from; the interface says so. A trained policy would consume the same observation.
- **Test runner** (`engine.ts`): drive home, scan six waypoints, record detections, pick the best correct detection as the target, run one control episode, report. `REPLAY TEST` re-runs with the same seed and produces the same numbers.
- **Feed** (`components/lab/FeedRenderer.tsx`): the camera feed panel is the same Three.js scene rendered a second time from the carriage camera with underwater fog, so what you see in the feed is what the gantry camera would see.

## Project structure

```
app/                    Next.js App Router shell and design tokens
components/lab/         Three.js scene: aquarium, gantry, electronics, test objects, overlays, feed renderer, camera rig
components/ui/          DOM overlay: top bar, scene rail, camera feed frame, telemetry, scene cards, demo controller, closing moment
lib/sim/                Simulation engine (constants, types, scenario, gantry, detection, policy, engine, demo, store, selfcheck)
docs/BLUEPRINT.md       System specification
backend/                FastAPI service with YOLOv8, MJPEG streaming and a UART serial bridge (hardware path, not used by the browser prototype)
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
