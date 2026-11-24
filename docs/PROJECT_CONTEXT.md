# GANTRYLAB (repo: HydraLoom) - Full Project Context

This document gives a language model, or a new teammate, complete context on the project from zero.
It is also structured so a presentation (PPT / slide deck) can be generated directly from it.
Part A is the project context.
Part B is a ready slide plan with content, visuals and speaker notes.
Part C lists rules and facts that must not be misstated.

Snapshot date: 2026-11-20.
Branch: `feat/test-environments`.
Sources of truth inside the repo: `docs/BLUEPRINT.md` (specification), `docs/HANDOFF.md` (state and decisions), `docs/RESOURCES.md` (data sources and licences), `README.md`.

---

# PART A - PROJECT CONTEXT

## A1. One-line summary

GANTRYLAB is an interactive, browser-based digital twin of a physical underwater robotics testbed: an aquarium with test objects on a sand floor, a motorized XY gantry carrying a downward camera, object detection, and a control policy that decides where to move the camera.

## A2. The problem

Testing underwater drones and their perception systems in real rivers, lakes, harbours and the sea is expensive, slow, risky and hard to repeat.
Conditions change between runs: turbidity, light, currents and object positions are never the same twice.
That makes it hard to compare one detector, camera or lamp choice against another.
Field trials also need boats, divers, permits and weather windows.

## A3. The solution

A controlled, repeatable, bench-top alternative.
A glass aquarium holds 3D printed test objects on sand.
A motorized XY gantry above the tank carries a waterproof camera that looks straight down through the water.
A Raspberry Pi runs object detection on the feed.
A control policy decides how to move the camera toward a target.
An Arduino drives the stepper motors.
The same scenario can be run again and again with identical inputs and identical results.

This repository is the browser simulation of that machine.
It lets anyone see, explore and run the testbed before the hardware is built, and it defines the exact data shapes the real hardware will produce.
Everything in the browser is simulated, and the interface says so wherever a number is shown.

## A4. The closed loop

```
PHYSICAL ENVIRONMENT -> CAMERA -> RASPBERRY PI -> OBJECT DETECTION
        ^                                              |
        |                                       POSITION / CONFIDENCE
        |                                              |
   X-Y GANTRY <- ARDUINO <- CONTROL POLICY <-----------+
```

1. The camera sees the tank floor through the water.
2. Detection finds objects, their class, confidence and floor position.
3. The control policy picks a move (step in X or Y, or hold).
4. The Arduino drives the steppers, the gantry moves the camera.
5. The loop repeats.

## A5. Project history

- 2026-05-25: Repo started as "HydraLoom", an ROV (remotely operated vehicle) mission-control dashboard with thrusters, IMU, depth tape, sonar and a cyberpunk theme, plus a Python FastAPI backend.
- 2026-09-15: Pivoted into GANTRYLAB, a browser prototype of a physical underwater testbed. The old ROV frontend was deleted. The Python backend was kept as the hardware integration path. Simulation engine, 3D scene, UI, Playwright test suite and Vercel deployment were built in this phase, followed by a hardening pass.
- 2026-11-18: Physically based water optics, four in-tank test environments (lab tank, harbor, river, deep sea), smooth coordinated gantry motion, UI/UX and free-exploration pass, environment resource and licence register, refreshed screenshot baselines.
- About 35 commits in total.

## A6. The physical system being simulated

All dimensions describe a plausible bench-top build, not a fantasy machine.

### Aquarium

- Glass tank, 120 cm (X) x 60 cm (Y) x 60 cm (H) internal, 10 mm glass, black silicone seams.
- Water fill 50 cm, about 360 L.
- Floor: 3 cm of fine sand with two shallow ripples and a few small stones.
- Sits on a steel frame table.

### Gantry

- Frame: 2020 aluminium extrusion rectangle on corner posts, 10 cm above the tank rim.
- X axis: two MGN12 linear rails along the long sides; a 2040 extrusion beam spans the tank and rides on both.
- X drive: one NEMA17 stepper, GT2 belts on both sides linked by a cross shaft so the beam cannot rack.
- Y axis: one MGN12 rail on the beam; the carriage rides on it, driven by a second NEMA17 and GT2 belt.
- Mechanical home switches at X = 0 and Y = 0; cable chains for camera ribbon and motor wires.
- Usable travel: X 0 to 100 cm, Y 0 to 40 cm.
- Motion: 80 steps per mm (GT2, 20 tooth pulley, 1/16 microstepping); max 15 cm/s, acceleration 30 cm/s^2.

### Carriage and camera

- 6 mm aluminium carriage plate, 25 cm 2020 drop mast.
- 60 mm clear acrylic tube housing with end cap at the bottom of the mast, 8 cm below the water surface.
- Raspberry Pi Camera Module 3 Wide, facing straight down, 42 cm above the sand.
- Underwater horizontal field of view about 75 degrees; floor footprint about 64 x 48 cm.

### Overhead ground-truth camera

- A fixed wide camera on an arm at the top of the frame sees the whole tank.
- In a real build it scores detections against true object and carriage positions.

### Electronics

- Arduino Uno + CNC shield + two A4988 drivers, 12 V supply.
- Raspberry Pi 4 (4 GB), linked to the Arduino over USB serial and to the camera over a 1 m ribbon.

### Test objects (gantry coordinates in cm)

| id | type | position | notes |
|---|---|---|---|
| wreck-01 | SHIPWRECK | (60, 26) | 22 cm hull section, broken open, listing 18 degrees, 30 percent buried |
| mine-01 | MINE | (32, 8) | 8 cm inert training sphere with 6 stub horns, marked TRAINING TARGET |
| debris-pipe | DEBRIS | (45, 33) | 12 cm pipe section, confusable with MINE at low confidence |
| debris-bracket | DEBRIS | (85, 8) | bent steel bracket |
| debris-rocks | DEBRIS | (15, 31) | small rock cluster |
| debris-crate | DEBRIS | (93, 35) | small plastic crate, 40 percent buried |

The MINE is an inert training obstacle and is never described as a weapon.

### Simulation to hardware mapping

| Simulation | Physical |
|---|---|
| Three.js aquarium | 120 x 60 x 60 cm glass tank |
| Virtual gantry | Arduino + CNC shield XY gantry |
| Virtual camera | Raspberry Pi Camera Module 3 in acrylic housing |
| Detection engine | YOLO model on the Raspberry Pi |
| Control policy | Control policy on the Raspberry Pi |
| Test objects | 3D printed obstacles on sand |

## A7. Tech stack

Frontend (the product today):

- Next.js 16 (App Router), React 19.2, TypeScript 5.
- Three.js 0.184 via React Three Fiber 9 and drei 10 for the 3D scene.
- Zustand 5 for state, GSAP for camera tweens, framer-motion for DOM animation.
- Tailwind CSS 4, lucide-react icons, Inter and IBM Plex Mono fonts.
- Playwright for end-to-end and visual tests; ESLint; `tsx` for headless simulation checks.
- Deployed on Vercel (region `bom1`, Mumbai), build gate: typecheck, lint, build; security headers set.

Backend (hardware path, not used by the browser prototype):

- Python FastAPI + Uvicorn, Ultralytics YOLOv8n, OpenCV, pyserial, NumPy; Dockerfile and docker-compose for an edge device.
- `/video_feed` MJPEG stream, `/ws/telemetry` WebSocket at about 50 Hz, `/ws/command` WebSocket.
- `serial_bridge.py`: JSON-lines protocol over UART at 115200 baud.
- `hal/broker.py`: hardware abstraction layer that switches between real hardware and a simulation.
- Honest note: the backend still carries its ROV-era shape (thruster physics, IMU, depth, fault injection, an FRDM MCU on the serial port).
  It is the integration skeleton, and needs remapping to gantry telemetry and the SHIPWRECK / MINE / DEBRIS classes before real use.

## A8. Repository structure

```
app/                    Next.js shell, layout, design tokens (globals.css)
components/lab/         Three.js scene: aquarium, gantry, electronics, test objects, overlays,
                        camera feed renderer, camera rig, water shader, weathering, tank dressing, particles
components/ui/          DOM overlay: top bar, scene rail, camera feed frame, telemetry, scene cards, demo, closing moment
lib/sim/                Simulation engine: constants, types, scenario, environments, rng, gantry,
                        detection, policy, engine, demo, store, selfcheck
lib/optics/water.ts     Physically based water optics
e2e/                    Playwright specs (14) and screenshot baselines
backend/                FastAPI + YOLOv8 + serial bridge (hardware path)
docs/                   BLUEPRINT (spec), HANDOFF (state), RESOURCES (data and licences), this file
```

Size: about 10,300 lines across simulation, 3D, UI, backend and tests.

## A9. How the simulation works

The engine in `lib/sim/` is pure TypeScript, has no React dependency, runs at a fixed 1/120 s timestep and is seeded.
The Node (headless) result and the browser result are bit-identical.

### Gantry motion (`gantry.ts`)

- Each axis follows a trapezoidal velocity profile toward its target, clamped to travel limits.
- Axes are coordinated, so every diagonal move is a straight line (within 0.04 cm), never a dog-leg.
- The 3D view interpolates between substeps, so motion is smooth at any display refresh rate (frame-to-frame speed variation fell from 32.5 to 3.4 percent at 60 Hz).
- The carriage never teleports and never leaves the rails; it parks at (50, 20) mid-tank when idle.

### Detection (`detection.ts`)

- The camera is modelled as a pinhole 42 cm above the sand with a 75 degree field of view.
- Each object's 3D bounds are projected into the frame; it is visible when at least 30 percent of its box is in frame.
- `confidence = detectability * geometry * water * light + seeded jitter (+-0.01)`.
- `geometry = 1 - 0.30 r^2 - 0.15 burial` (r = distance from optical axis, normalised).
- `water` = how much of the object's contrast against the seabed survives the water path, from the same optics the renderer draws; 0 at the 2 percent contrast threshold (Koschmieder).
- `light = lighting^0.3`; in the lamp-lit deep sea it is lamp irradiance with inverse-square falloff.
- Detected when confidence >= threshold (default 0.6), with hysteresis against flicker.
- True class reported at >= 0.65, otherwise UNKNOWN.
- The debris pipe is deliberately confusable and reports as MINE: a deterministic false positive for testing.

### Control policy (`policy.ts`)

- Actions: `MOVE_X+`, `MOVE_X-`, `MOVE_Y+`, `MOVE_Y-`, `HOLD`; one step is 5 cm.
- Greedy step controller on axis error, with seeded epsilon exploration that decays with episode number.
- Reward = distance closed per step + confidence bonus - step cost + bonus for holding on target.
- The reward is logged, not learned from. It is RL-inspired, not a trained network. The UI says so.
- A trained policy can drop in later and consume the same observation.
- Episode ends after 3 consecutive HOLDs on target or 40 steps.

### Test runner (`engine.ts`)

1. HOME: drive physically to (0, 0); clock, seed and log restart on arrival.
2. SCAN: serpentine over six waypoints (x 15, 50, 85; y 10, 30).
3. DETECT: record detections at each waypoint.
4. TARGET: pick the highest-confidence correct detection.
5. TRACK: run one control episode toward it.
6. RESULT: objects detected, correct classifications, false positives, average confidence, coverage, reward, duration.
7. REPLAY: re-run with the same seed gives identical numbers.

### Camera feed (`FeedRenderer.tsx`)

The camera feed panel is the same 3D scene rendered a second time from the carriage lens, through the same water model.
What the feed shows is what the simulated gantry camera sees, and what the detector reasons about.

### Water optics (`lib/optics/water.ts`, `components/lab/water.ts`)

- Turbidity is shown in NTU, with the range at which contrast falls to 2 percent.
- Per-channel absorption and scattering come from published data: Pope and Fry 1997 (pure water absorption), Morel 1974 (scattering), Kirk (diffuse attenuation), plus a clay suspension model.
- Every submerged surface is attenuated along its true path through the water and veiled by scattered light: `I = J exp(-c d) + Binf (1 - exp(-c d))`.
- Caustics, particles and the feed camera's auto-exposure read the same optics.
- Detection and rendering share one physics model, so what you see and what the detector reports agree.

## A10. Test environments

The same rig, objects and test can be run in four waters, each recreated inside the tank the way a test tank emulates field conditions.
The rig and objects never change, so results are comparable across environments.

| Environment | Real testing problem | Light | NTU range | Default |
|---|---|---|---|---|
| Lab tank | Controlled baseline, calibration anchor | daylight / lab | 0 to 20 | 0.45 NTU |
| Harbor | Pier, piling and hull inspection, grey-green water over mud, 6 m deep | surface | 1 to 40 | 2.6 NTU |
| River | Bridge pier inspection, grey-brown silty water, 1.2 m reach, slow current | surface | 2 to 150 | 3.5 NTU |
| Deep sea | Abyssal survey at 1500 m, no daylight | rig lamps only | 0.02 to 2 | 0.2 NTU |

Each environment changes the water (particles, dissolved organic matter), the floor substrate (sand, harbour mud, river gravel, abyssal ooze), the dressing in the tank margins (fouled pilings, tyre and chain; bridge pier and branch; rock outcrops and manganese nodules), the light colour at depth, and for the river a flume current.
Switching is seamless: a 220 ms fade hides the swap while shaders precompile.

Calibration, centred shipwreck at default lighting:

| Environment | Confidence | Note |
|---|---|---|
| Lab tank, 0.45 NTU | 86.7 percent | golden reference run |
| Harbor, 2.6 NTU | 75.9 percent | gone by about 11.1 NTU |
| River, 3.5 NTU | 72.5 percent | gone by about 11.3 NTU |
| Deep sea, lamps 0.8 | 89.4 percent | 54.7 at lamp 0.3, 31.5 at 0.1, nothing with lamps off |

Insight: in the deep sea, the water barely matters; lamp power and distance decide detection.

## A11. Key numbers (default run)

Default scenario: turbidity 0.15 (0.45 NTU), lighting 0.8, threshold 0.6, speed 0.65, seed 1337.

- Objects detected: 5 of 6.
- Correct classifications: 4.
- False positives: 1 (the pipe reported as MINE, by design).
- Average confidence: about 72.5 percent.
- Floor coverage: 90 percent.
- Episode reward: +15.70.
- Duration: 43.4 s simulated.
- Target chosen: wreck-01.
- Controller converges under 0.6 cm on every default target.

Turbidity sensitivity (centred wreck, lab tank): 86.7 percent at 0.45 NTU, 82.2 at 1.8, 69.6 at 4, 44.7 (UNKNOWN) at 7.2, nothing from 12.8 NTU up.
Lighting 0 detects nothing.

## A12. The user experience

One full-screen 3D scene is always the hero; panels never cover the tank.
Layout: top bar (brand, status chips, DEMO, RESET), left scene rail, right column (live camera feed and telemetry), bottom context card.

Seven scenes:

| Scene | View | Content |
|---|---|---|
| 01 Overview | three-quarter | Whole testbed; RUN SIMULATION |
| 02 System | three-quarter | Numbered callouts: gantry, camera, aquarium, Raspberry Pi, Arduino, test objects; simulation to hardware mapping |
| 03 Vision | detection camera | Live feed, bounding boxes, confidence, estimated floor coordinates |
| 04 Gantry | top-down | Target, path, carriage motion; XY pad to drive the gantry by hand |
| 05 Control | top-down | Control loop: state, action, reward, next state, exploration |
| 06 Scenario | top-down | Environment, turbidity, lighting, threshold, speed, object positions; RUN TEST |
| 07 Result | three-quarter | Metrics, previous-run delta, REPLAY TEST, closing "simulation to field" moment |

Other interaction:

- RUN DEMO: an autonomous narrated tour of about 64 to 75 seconds; phases advance on real engine events (first detection, target chosen, hold, completion).
- Free exploration: orbit, pan, zoom, even underneath the tank; double-click any part to focus; EXPLORE (E) hides all panels; RECENTER (C).
- Keyboard: 1 to 7 and arrow keys switch scenes; arrows jog the gantry 5 cm (Shift 1 cm) on the XY pad.
- Responsive down to phones, reduced-motion respected, visible focus rings, accessible contrast.

Design language: marine lab, not startup.
Dark neutral panels (#0b1219 ground, #101922 panel), 1 px borders, teal #3db9b0 for machine state, amber #f2a93b for targets and detections.
Inter for UI, IBM Plex Mono for telemetry.
No neon, no CRT scanlines, no glassmorphism, no giant headlines over the tank.

## A13. Quality and verification

- `npm run sim:check`: 148 headless assertions (golden numbers, determinism, rail limits, edge cases, environments, demo bounds).
- `npm run e2e`: 14 Playwright specs: boot, navigation, gantry, detection, control, test run, camera, scenario, demo, responsive, visual, red-team, explore, environments.
- Screenshot baselines are stable (21 of 21 over three repeats); any console error fails a test.
- Typecheck, lint and production build are clean and gate every Vercel deploy.
- Multiple independent audits: security and robustness, robotics realism, product and demo, 3D craft, engineering coherence, adversarial QA (40 random rapid clicks, input abuse, resizes, soak, reload).
- Every bug was reproduced in a real browser before it was fixed and then locked in by a test.

## A14. Path to real hardware

1. Arduino: flash GRBL or a step/dir sketch; the Pi sends `G0 X.. Y..` or JSON moves over USB serial (`backend/serial_bridge.py`).
2. Camera: `backend/vision_pipeline.py` captures frames, runs YOLOv8, streams MJPEG; retrain or remap classes to SHIPWRECK, MINE, DEBRIS.
3. Telemetry: `backend/main.py` pushes state on `/ws/telemetry`; replace the browser engine's `tick()` with those packets and keep the store shape.
4. Controller: port `policy.ts` to the Pi, or drop in a trained policy on the same observation.
5. Ground truth: the overhead camera scores detections against reality.
6. Calibration: capture real tank water to replace the assumed 1.0 m^-1 per NTU particle attenuation.

## A15. Known limitations (honest list)

- Particle attenuation per NTU is assumed, not yet calibrated against measured water.
- Forward-scatter blur is not modelled: turbid water lowers contrast but does not soften edges.
- Deep-sea lamp model is simplified (no beam pattern or lamp offset).
- The control policy is a greedy controller with logged reward, not a trained RL agent.
- Bounding boxes come from declared object extents; mine horns and wreck fragments extend a few pixels past them.
- The Python backend still reflects the earlier ROV design and needs remapping for the gantry.
- No physical hardware has been built yet; all numbers are simulated.

## A16. Roadmap / next steps

- Build the bench-top rig from the specification above.
- Capture real tank imagery to calibrate water optics and train the detector (plan in `docs/RESOURCES.md` section 8.3).
- Train a YOLO model on SHIPWRECK / MINE / DEBRIS and run it on the Pi.
- Replace the greedy controller with a trained policy on the same observation.
- Connect the browser UI to live hardware telemetry over WebSocket.
- Model forward-scatter blur and a full lamp beam.

## A17. How to run

```bash
npm install
npm run dev          # http://localhost:3000
npm run sim:check    # headless engine checks
npm run typecheck
npm run lint
npm run build
npm run e2e          # Playwright suite
```

---

# PART B - PRESENTATION PLAN

Use this part to generate a slide deck.
Target: 14 slides, about 10 to 12 minutes.
Audience: mixed technical and non-technical (reviewers, faculty, investors, robotics engineers).
Tone: calm, precise, engineering-led; marine lab, not startup hype.

## B1. Visual style for the deck

- Background: deep navy #0b1219; panels #101922; text near-white; muted text grey.
- Accent 1, teal #3db9b0: machine state, system, process.
- Accent 2, amber #f2a93b: targets, detections, key numbers.
- Fonts: Inter (headings, body), IBM Plex Mono (numbers, code, telemetry).
- Thin 1 px borders, generous spacing, no glow, no gradients-heavy effects, no stock photos of divers.
- Imagery: screenshots of the running app (overview, camera feed with boxes, top-down gantry, result card, four environments).
- Never use em dashes in slide text.

## B2. Slide-by-slide content

### Slide 1 - Title

- Title: GANTRYLAB
- Subtitle: A repeatable underwater robotics testbed, simulated in the browser
- Visual: three-quarter overview screenshot of the tank and gantry.
- Speaker notes: Introduce the project as a digital twin of a bench-top rig for testing underwater perception and control.

### Slide 2 - The problem

- Field testing underwater robots is expensive, slow, risky.
- Conditions never repeat: turbidity, light, currents, object positions.
- Hard to compare one detector, camera or lamp against another.
- Visual: icons for cost, time, risk, variability.
- Speaker notes: The core issue is repeatability; without it you cannot compare designs fairly.

### Slide 3 - The idea

- Bring the field into a tank.
- Aquarium + test objects + XY gantry camera + detection + control.
- Same scenario, same seed, same result, every time.
- Visual: simple illustration or app screenshot with labels.

### Slide 4 - The closed loop

- Camera -> Raspberry Pi detection -> position and confidence -> control policy -> Arduino -> XY gantry -> camera.
- Visual: circular loop diagram (use the ASCII loop in section A4 as the source).
- Speaker notes: Each block maps to real hardware; the browser simulates every block.

### Slide 5 - The physical system

- 120 x 60 x 60 cm glass tank, 50 cm water, sand floor.
- XY gantry on MGN12 rails, two NEMA17 steppers, 100 x 40 cm travel, 15 cm/s.
- Pi Camera Module 3 Wide in acrylic housing, 42 cm above sand, 75 degree FOV.
- Raspberry Pi 4 + Arduino Uno with CNC shield.
- Visual: scene 02 System screenshot with numbered callouts.

### Slide 6 - Test objects

- Shipwreck hull section, inert training mine, four debris items.
- One debris pipe is deliberately confusable with the mine: a designed false positive.
- Visual: the object table from A6 or a top-down screenshot with object labels.

### Slide 7 - Tech stack and architecture

- Frontend: Next.js 16, React 19, TypeScript, Three.js via React Three Fiber, Zustand.
- Simulation engine: pure TypeScript, 120 Hz fixed step, seeded, no UI dependency.
- Backend path: FastAPI, YOLOv8, WebSocket telemetry, UART serial bridge.
- Testing: 148 headless checks, 14 Playwright specs, visual baselines; Vercel deploy.
- Visual: three-layer diagram: Simulation engine -> State store -> 3D scene + UI; side box: Python backend for hardware.

### Slide 8 - How detection works

- Pinhole camera projection of each object into the frame.
- Confidence = detectability x geometry x water x light.
- Water term uses the same physics the renderer draws: what you see is what the detector gets.
- Below threshold: missed; low confidence: UNKNOWN.
- Visual: camera feed screenshot with amber bounding boxes and confidence labels.

### Slide 9 - Physically based water

- Turbidity in NTU, per-colour absorption and scattering from published data (Pope and Fry, Morel, Kirk).
- Contrast fades with distance through the water and a light veil builds up.
- Detection drops to zero at the 2 percent contrast threshold.
- Chart: wreck confidence vs turbidity: 86.7 percent at 0.45 NTU, 82.2 at 1.8, 69.6 at 4, 44.7 at 7.2, 0 at 12.8.
- Speaker notes: This is why realism matters; the detector fails exactly where a real camera would.

### Slide 10 - Four test environments

- Lab tank, Harbor, River, Deep sea, all recreated inside the same tank.
- Same rig, same objects, comparable results.
- Chart: bar chart of centred wreck confidence: tank 86.7, harbor 75.9, river 72.5, deep sea 89.4 percent.
- Callout: in the deep sea, lamp power decides everything: 89.4 percent at 0.8, 54.7 at 0.3, 31.5 at 0.1, 0 with lamps off.
- Visual: four screenshots in a 2 x 2 grid.

### Slide 11 - Control policy

- State: gantry position, target, confidence, last action.
- Actions: move X+/X-/Y+/Y-, hold; 5 cm steps.
- Greedy controller with decaying, seeded exploration; reward logged, not learned from.
- Converges under 0.6 cm on every target; a trained policy can drop in on the same interface.
- Visual: scene 05 Control screenshot or state -> action -> reward -> next state diagram.

### Slide 12 - A full test run (results)

- Home -> scan 6 waypoints -> detect -> pick target -> track -> report.
- KPI tiles: 5 detected, 4 correct, 1 false positive, 72.5 percent avg confidence, 90 percent coverage, +15.70 reward, 43.4 s.
- REPLAY gives identical numbers.
- Visual: scene 07 Result screenshot.

### Slide 13 - From simulation to hardware

- Arduino: GRBL or step/dir over USB serial.
- Pi camera: YOLOv8 retrained on SHIPWRECK, MINE, DEBRIS.
- Telemetry: WebSocket replaces the simulated tick, same data shape.
- Overhead camera provides ground truth.
- Visual: two-column table, Simulation vs Physical (from A6).

### Slide 14 - Limitations and next steps

- Honest limits: assumed water calibration, no forward-scatter blur, greedy (not trained) policy, backend still ROV-shaped, no hardware yet.
- Next: build rig, capture real tank data, train detector, trained policy, live telemetry.
- Closing line: Test in the tank, trust it in the field.

## B3. Optional extra slides

- Live demo slide: "RUN DEMO" narrated 75 s tour (show as video or live).
- Quality slide: audits performed, adversarial QA, every bug reproduced then locked by a test.
- Project timeline: May 2026 ROV dashboard, Sept 2026 pivot to GANTRYLAB, Nov 2026 water physics and environments.
- User experience slide: seven scenes, explore mode, keyboard control, responsive to phones.

## B4. Charts the deck can draw from data in this file

| Chart | Type | Data |
|---|---|---|
| Confidence vs turbidity (lab tank) | line | NTU 0.45, 1.8, 4, 7.2, 12.8 -> 86.7, 82.2, 69.6, 44.7, 0 |
| Confidence by environment | bar | tank 86.7, harbor 75.9, river 72.5, deep sea 89.4 |
| Deep sea confidence vs lamp power | line | lamp 0, 0.1, 0.3, 0.5, 0.8 -> 0, 31.5, 54.7, 70.6, 89.4 |
| Default run KPIs | stat tiles | 5 detected, 4 correct, 1 FP, 72.5 percent, 90 percent coverage, +15.70, 43.4 s |

---

# PART C - RULES FOR ANY MODEL USING THIS FILE

- Product name is GANTRYLAB; the repository name is HydraLoom.
- Everything in the browser is simulated; never claim real-world measured results or that the hardware exists.
- The MINE is an inert training object; never describe it as a weapon or the project as military targeting.
- The controller is RL-inspired with logged reward; never call it a trained reinforcement learning model.
- The detection in the browser is a physics-based confidence model, not a neural network; YOLOv8 is the hardware path.
- Water parameters are representative per water class, not measurements of a specific site.
- Quote numbers exactly as given here; they are calibrated outputs of the deterministic engine.
- Do not use the em dash character; use a plain dash.
