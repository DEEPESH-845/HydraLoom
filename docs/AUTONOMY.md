# Autonomy, benchmark and hardware bench

This document covers the three workbench routes added on 2026-11-25: `/benchmark`, `/autonomy` and `/hardware`.
Every number on them says whether it is measured or simulated.

## 1. Model benchmark (`/benchmark`, `lib/bench`)

A `ModelProfile` is a model's behaviour across test conditions, from one of two sources.

- Measured: a completed, non-mock backend run. The latest run of each model on each dataset is used, and only runs on the same dataset are compared.
- Simulated: four seeded archetypes (`SIMULATED_ROSTER`), so the page works with no models. They are not real models and are labelled on every view.

To measure your own models: capture with the Condition grid preset (Gantry Lab or 05 Analysis), upload the models in the Model Lab, then evaluate them together on `/benchmark`.
Use different layouts and seeds for training and for the benchmark.

The backend reports joint turbidity x lighting cells (`condition_cells`), because marginal slices cannot say which model wins in water that is both dark and silty.

Advice carries one of two effects, never a predicted gain.

- Exact: a threshold change (recomputed from the stored sweep) or routing (recomputed from stored counts). Routing is in-sample: the same frames chose the winners.
- Upper bound: what closing a recall gap completely would give, false positives unchanged.

## 2. Learned gantry navigation (`lib/autonomy/nav.ts`)

Model-based reinforcement learning over viewpoints, behind the `ScanPlanner` interface as the strategy `learned`.

- Reward: 0.5 per new object, 1 per object first classified correctly, -0.5 per wrong label (returned when corrected), -0.03 per second of travel and dwell.
- Learned: the discovery reward of a viewpoint, linear in six features (bias, newly readable floor for typical, distinct and faint objects, confirming an uncertain label, re-checking a sure one), by stochastic regression on explored episodes over random layouts and waters.
- Policy: beam search (depth 5, width 8) with the learned reward, the known travel time and the known optics. One viewpoint is executed, then it replans. It stops when no plan is worth its time.
- The planner's time cost (0.015 per second) is below the reward's and was chosen on validation layouts.
- It sees only what the rig could know: position, reported detections with estimated positions, visited viewpoints, and the sensed water.

`npm run rl:train` retrains and writes `lib/autonomy/nav-weights.ts` with the held-out scores.
Seeds for training, validation (5,000,000 up) and test (9,000,000 up) never overlap.

Held-out result, 120 layouts in the full engine: the learned planner ties the best hand-written planner overall (2.88 against 2.88 for detection-driven) with scans 6 percent shorter.
It is better in river (1.58 against 1.42) and harbor (2.26 against 2.20), and worse in the tank (4.65 against 4.75) and the deep sea (3.52 against 3.74).

Rejected on the way: plain Q-learning with a linear Q, cross-entropy policy search, and one-step greedy selection all scored below the hand-written planner, because greedy viewpoints tile the tank badly.

## 3. Learned model switching (`lib/autonomy/switching.ts`)

- State: sensed turbidity bucket (4) x lighting bucket (3) x the model loaded.
- Action: the model for the next frame.
- Reward: (true positives - 0.5 false positives) / objects, minus a latency cost, minus the switch cost.
- Learner: tabular Q-learning on after-states. The switch cost is known, so only the value of having a model running in a context is learned. It sees sampled rewards, never the benchmark table.
- The water drifts and the sensor misreads a bucket 5 percent of the time. A change must be read twice (`Debounce`) before the policy acts on it; without this it switched 13 times per survey instead of 4.
- Thin cells are pulled toward the model's overall counts, so a few lucky frames do not decide a policy.

Judged on 60 held-out surveys against every fixed model, random switching, and an oracle that knows the table and reads the water perfectly.
On the simulated roster: learned 0.735, best fixed 0.698, oracle 0.738.
On three real YOLOv8n models fine-tuned on twin captures (clear water only, murky only, all waters) and tested on an unseen layout, the all-water model is best almost everywhere, so there is nothing to gain by switching and the learner stays on it; the clear-water model drops from F1 0.97 in clear water to 0.25 in heavy silt.

`Export policy` writes `gantrylab.switch-policy/1`: bucket edges and `policy[turbidity][lighting][loaded] = model`. A policy trained on the simulated roster says so and must not be deployed.

## 4. Joint mission (`lib/autonomy/mission.ts`)

One survey of the tank through four waters with both policies.
Geometry comes from the lab detector; water and light from the selected model's benchmark cell.
Each object's difficulty is one draw per leg, so looking again only helps through a better view or a better model.

## 5. Hardware bench (`/hardware`, `lib/hardware`)

- Link: GRBL 1.1 over Web Serial at 115200 baud (Chrome or Edge, https or localhost). No settings are written: the work origin uses `G92`, which is volatile.
- Safety: every motion goes through `SafeGantryLink`. Arming needs the phrase, a live heartbeat and a released E-stop. A scan plan is submitted as a controller command and needs operator approval. Stop is a feed hold, then a soft reset once at rest, so nothing held can resume by itself. GRBL does not answer while homing, so silence is accepted then and only then.
- GRBL is open loop: it reports the commanded position. Tests about the true position need a gauge and otherwise read NOT MEASURED; they never pass by default.
- Acceptance: link latency, move time against the twin, stop distance, repeatability and backlash, travel scale, endurance drift. Limits are in `LIMITS` in `lib/hardware/acceptance.ts`.
- Suggestions name the setting and value, for example `$100` from commanded over measured travel.
- The emulated rig is the same driver and safety layer with a simulated machine. Its reports are marked SIMULATED.
- Reports are kept in the browser (30 newest) and export as JSON, CSV or print.
- `backend/pi_bench.py` logs vision latency, temperature and throttling on the Pi for the same page.

## 6. What is still missing for an end-to-end underwater testing solution

| Gap | Consequence | What closes it |
|---|---|---|
| No calibration against real water | Turbidity is a model (1.0 per metre per NTU assumed); field and lab detectability are uncalibrated | The capture plan in `docs/RESOURCES.md` section 8.3 with a turbidity meter |
| No sim-to-real measurement | A model that wins on twin frames may not win on the real camera | Record the same layout in the tank, label it, upload as a dataset, compare the rankings on `/benchmark` |
| The physical camera is not in the loop | The bench drives the motors; frames from the Pi do not reach the planner | Stream Pi detections (class, box, confidence) to the page and feed them to `NavState` as `seen` |
| No true position sensor | Backlash and lost steps need a hand gauge | Overhead camera with a fiducial on the carriage, or encoders |
| Lamp backscatter is not a beam model | Lamp-lit confidence is optimistic in turbid water | A lamp beam and phase function in `lib/optics` |
| No forward-scatter blur or marine fouling on targets | Twin frames are sharper than real ones | Point-spread blur by range in the feed pass |
| Reports live in one browser | No shared history | Store hardware reports in the backend |
| Switching policy runs in the browser | The Pi has no runner for the exported policy | A loader on the Pi that reads `gantrylab.switch-policy/1` |
