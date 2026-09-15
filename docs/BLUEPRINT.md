# GANTRYLAB System Blueprint

This is the single source of truth for the GANTRYLAB prototype.
Every component, agent, and reviewer works against this document.
If code and this document disagree, fix one of them in the same change.

## 1. What this is

A browser-based digital representation of a physical underwater robotics testbed.
An aquarium holds 3D printed test objects on a sand floor.
A motorized XY gantry above the tank carries a downward-facing camera.
A Raspberry Pi runs object detection on the camera feed.
A control policy decides how to move the camera.
An Arduino drives the gantry stepper motors.
The loop repeats.

Everything in the browser is simulated.
The UI must say so wherever a number is shown.

## 2. Physical system specification

All dimensions are for a plausible bench-top build, not a fantasy machine.

### 2.1 Aquarium

- Glass tank, 120 cm (X) x 60 cm (Y) x 60 cm (H) internal, 10 mm glass, black silicone seams. The bottom pane adds 4 cm under the sand datum, so the outside height is 64 cm.
- Water fill 50 cm. Approximately 360 L.
- Floor: 3 cm of fine sand with two shallow ripples, a few small stones.
- Tank sits on a steel frame table. The table is not modeled in detail.

### 2.2 Gantry frame and axes

- Frame: 2020 aluminium extrusion rectangle sitting on the tank rim, 10 cm above the rim on corner posts.
- X axis: two MGN12 linear rails along the long sides. A 2040 extrusion beam (the Y beam) spans across the tank and rides on both rails.
- X drive: one NEMA17 stepper at the electronics end, GT2 belt on both sides linked by a cross shaft, so the beam cannot rack.
- Y axis: one MGN12 rail along the Y beam. The carriage rides on it.
- Y drive: NEMA17 at one end of the beam, GT2 belt, idler at the other end.
- Home switches: mechanical limit switches at X = 0 and Y = 0.
- Cable chain from the carriage to the frame corner (camera ribbon, Y motor wires).
- Usable travel: X 0 to 100 cm, Y 0 to 40 cm. The gantry coordinate origin is the home corner.

### 2.3 Carriage and camera

- Carriage: 6 mm aluminium plate on the Y rail block.
- Drop mast: 2020 extrusion, 25 cm, bolted vertically to the carriage.
- Camera housing: 60 mm clear acrylic tube with an end cap, mounted at the bottom of the mast.
- Camera: Raspberry Pi Camera Module 3 Wide inside the housing, facing straight down.
- The housing bottom sits 8 cm below the water surface, so the camera is 42 cm above the sand.
- Effective underwater horizontal field of view is about 75 degrees (air FOV narrows through the flat port by roughly 25 percent).
- Floor footprint at 42 cm height is roughly 64 cm x 48 cm.

### 2.4 Overhead ground-truth camera

- A fixed wide camera on a short arm at the top of the frame sees the whole tank.
- It exists for ground-truth positioning of the gantry and objects in a real build.
- In the prototype it is a labeled static component only.

### 2.5 Electronics

- Arduino Uno with CNC shield and two A4988 drivers, 12 V supply, mounted on a plate at the electronics end of the frame.
- Raspberry Pi 4 (4 GB) in a case beside the Arduino, connected to the Arduino over USB serial and to the camera over a 1 m ribbon.
- Motion resolution: GT2 belt, 20 tooth pulley, 1/16 microstepping, 80 steps per mm.
- Motion limits used by the simulation: max speed 15 cm/s, acceleration 30 cm/s^2.

### 2.6 Test objects

All objects are 3D printed or scrap, weighted to sit on the sand.
Positions are gantry coordinates in cm on the floor.

| id | type | position | notes |
|---|---|---|---|
| wreck-01 | SHIPWRECK | (60, 26) | 22 cm hull section, broken open, listing 18 degrees, 30 percent buried |
| mine-01 | MINE | (32, 8) | 8 cm inert training sphere with 6 stub horns, orange and black bands, marked TRAINING TARGET |
| debris-pipe | DEBRIS | (45, 33) | 12 cm pipe section, confusable with MINE at low confidence |
| debris-bracket | DEBRIS | (85, 8) | bent steel bracket |
| debris-rocks | DEBRIS | (15, 31) | small rock cluster |
| debris-crate | DEBRIS | (93, 35) | small plastic crate, 40 percent buried |

The MINE is a training obstacle.
It is never described as a weapon anywhere in the UI.

## 3. Coordinate systems

Gantry space is (x, y) in cm, origin at the home corner, x along the long side of the tank.
World space is Three.js metres, Y up, tank centred on the origin, sand surface at world Y = 0.

```
world.x = (x_cm - 50) / 100
world.z = (y_cm - 20) / 100
water surface   world.y = 0.50
camera lens     world.y = 0.42
tank rim        world.y = 0.60
frame rails     world.y = 0.70
```

The mapping lives in one place, `lib/sim/constants.ts`.
Nothing else may hard code it.

## 4. Simulation architecture

Pure TypeScript, no React, deterministic, fixed-timestep.

```
lib/sim/
  constants.ts   tank, gantry, camera, motion limits, world mapping
  types.ts       every shared type
  scenario.ts    default object layout and scenario parameters
  rng.ts         seeded PRNG (mulberry32) so every run is repeatable
  gantry.ts      per-axis trapezoidal motion toward a target
  detection.ts   camera pose + objects + scenario -> detections
  policy.ts      RL-inspired controller: state -> action, reward
  engine.ts      tick(dt): gantry, detection, RL, test runner, telemetry
  store.ts       zustand store: engine state + UI state + actions
```

### 4.1 Gantry motion

Each axis has position, velocity, target.
Each tick accelerates toward the target with a trapezoidal profile and clamps to travel limits.
The carriage never leaves the rails and never teleports; a full reset is the only instant repositioning.
At rest the carriage parks at (50, 20), over the middle of the tank, so the camera and its footprint read at a glance.
Belt and pulley rotation is derived from axis position for the 3D view.

### 4.2 Detection

Input: camera pose (from gantry position), objects, turbidity, lighting, threshold.
For each object:

- Project the object's 3D bounds into the camera. The object is visible when at least 30 percent of its projected box lies inside the frame.
- `geometry = 1 - 0.30 * r^2 - 0.15 * burial` where r is the normalised radius of the box centre from the optical axis.
- `water = exp(-1.1 * turbidity^2 * distance / 0.42)`: light haze barely matters, heavy silt saturates.
- `light = lighting^0.3`: no light sees nothing.
- `confidence = detectability * geometry * water * light + seededJitter(+-0.01)`.
- Calibration at the default scenario (turbidity 0.15, lighting 0.8): wreck centred 85.6 percent, wreck from waypoint (50, 30) 81.0 percent, mine from waypoint (15, 10) 74.9 percent, pipe from (50, 30) 62.4 percent (reported as MINE), rocks below threshold. At turbidity 0.6 the centred wreck drops to 61 percent and UNKNOWN; lighting 0 detects nothing at any threshold; turbidity 1 detects nothing at the default threshold 0.6, though at the 0.3 floor a centred wreck still reads about 31 percent and reports UNKNOWN.
- Detected when confidence >= threshold; once detected, an object stays detected until it drops 0.05 below the threshold (hysteresis against flicker).
- Class: true class when confidence >= 0.65.
  Otherwise UNKNOWN, except objects with `confusableAs`, which report the confusable class.
  That is the deterministic false-positive path.

The bounding box is the projection of the object's 3D bounds into the camera, in normalised feed coordinates.

### 4.3 Control policy

State: gantry x, y, target x, y, detection confidence, previous action.
Actions: MOVE_X+, MOVE_X-, MOVE_Y+, MOVE_Y-, HOLD. One step is 5 cm.
Policy: a hand-written greedy step controller on axis error, with epsilon exploration that decays with episode number, seeded.
Reward: distance reduction per step, plus confidence bonus, minus a step cost, plus a bonus for holding on target.
The reward is computed and logged for the demo; nothing is updated from it.
Episode ends after 40 steps or after 3 consecutive HOLD on target.
Policy confidence is a softmax over action scores and is shown in the UI.
The UI says exactly this: greedy on axis error, reward logged, not learned from. A trained policy would consume the same observation.

### 4.4 Test runner

0. HOME: the carriage drives to (0, 0) physically. The clock, seed and log restart on arrival, so a test is always the same pure function of scenario + seed no matter where the carriage was.
1. SCAN: serpentine waypoints (x in 15, 50, 85, y in 10, 30).
2. At each waypoint run detection and record results.
3. Pick the highest-confidence detection as the target.
4. TRACK: run one RL episode toward the target.
5. RESULT: objects detected, successful (correct class), false positives, average confidence, coverage (visited grid cells over 12 x 5 floor grid), episode reward, duration.
6. The full event log is kept for REPLAY.

## 5. Experience architecture

One full-screen 3D scene is always the hero.
UI panels never cover the tank.

```
scene 01 OVERVIEW    what is this            camera A
scene 02 SYSTEM      component index 01-06   camera A, hover highlights
scene 03 VISION      camera feed + detection camera D
scene 04 GANTRY      target -> path -> move  camera B
scene 05 CONTROL     RL step visualisation   camera B
scene 06 SCENARIO    parameter form, RUN     camera A
scene 07 RESULT      metrics, REPLAY         camera A
```

Camera presets:

- A overview three-quarter
- B top-down
- C underwater side
- D detection camera (the gantry camera, shown in the feed inset)
- E engineering close-up of the carriage

Demo mode runs a scripted sequence of about 75 seconds through scenes 01 to 07 with PAUSE, REPLAY, EXIT. Phases advance on engine state (first detection, target chosen, controller steps, hold, completion) with minimum durations, so the narration always matches what the machine is doing.

Layout:

- Top bar: wordmark, one line description, system status chips, DEMO and RESET.
- Left rail: scene index 01 to 07.
- Right column: camera feed inset, telemetry.
- Bottom centre: the context card for the current scene.

## 6. Design language

Marine lab, not startup.
Neutral dark panels, 1 px borders, one amber accent for targets and detections, one teal accent for machine state.
Inter for UI, IBM Plex Mono for telemetry.
No neon glow, no CRT scanlines, no glassmorphism blur stacks, no giant headlines over the tank.

## 7. Real-world mapping

| Simulation | Physical |
|---|---|
| Three.js aquarium | 120 x 60 x 60 glass tank |
| Virtual gantry | Arduino + CNC shield XY gantry |
| Virtual camera | Raspberry Pi Camera Module 3 in acrylic housing |
| Detection engine | YOLO model on the Raspberry Pi (`backend/vision_pipeline.py`) |
| RL controller | Control policy on the Raspberry Pi |
| Test objects | 3D printed obstacles on sand |

The existing `backend/` FastAPI service already streams telemetry over WebSocket and talks to an MCU over serial.
That is the integration path when hardware exists: replace the browser engine's tick with packets from `/ws/telemetry`.
