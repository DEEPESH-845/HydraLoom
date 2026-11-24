# Bug audit (2026-11-24)

This audit covers the Gantry Lab (`/lab`), the field workspace (`/`), and the FastAPI backend.
Each confirmed defect was reproduced before it was fixed, either end to end in Chromium or against a real uvicorn server.
Each one has a regression test that fails on the code before the fix and passes after it.
Browser work used two Chromium set-ups: a real GPU (Intel, ANGLE Direct3D 11) and the Playwright software-GL configuration.

Severity scale: Critical (crash, data corruption or loss of control), High (a core journey is broken or misreported), Medium (a feature misbehaves or leaks resources), Low (a misleading or stale display).

## Summary

| ID | Severity | Area | Title | Status |
|---|---|---|---|---|
| BUG-01 | High | Field workspace camera | Sites cannot be freely explored: the pivot is locked at the site centre | Fixed, verified |
| BUG-02 | Medium | Lab camera | A pan during the explore glide is pulled back | Fixed, verified |
| BUG-03 | Medium | Lab 3D, environments | Every environment switch leaks GPU geometries and materials | Fixed, verified |
| BUG-04 | Low | Lab UI, scene 04 | Gantry card shows the last episode's target after a manual move | Fixed, verified |
| BUG-05 | Low | Lab UI, scene 07 | Result card says "No test has run yet." during a run and after a stopped run | Fixed, verified |
| BUG-06 | Low | Lab UI, scene 02 | Leaving a 3D callout clears the pinned highlight | Fixed, verified |
| BUG-07 | Low | Lab UI, scene 04 | XY pad always shows the serpentine waypoints | Fixed, verified |
| BUG-08 | Medium | Lab dataset capture | A turbidity or lighting sweep rewrites the live scenario | Fixed, verified |
| LEG-1 | High | Backend serial / HAL | A port that fails to open is reported as connected hardware | Fixed, verified |
| LEG-2 | High | Backend serial | A JSON line that is not an object kills every telemetry socket | Fixed, verified |
| LEG-3 | Medium | Backend serial | One invalid UTF-8 byte stalls the reader for 1 s | Fixed, verified |
| LEG-4 | High | Backend serial | `connect()` leaks port handles and reader threads | Fixed, verified |
| LEG-5 | High | Backend serial / HAL | An unplugged UART is never reopened; its last packet is served as live | Fixed, verified |
| LEG-6 | High | Backend `/ws/command` | One malformed command closes the command channel | Fixed, verified |
| LEG-7 | Medium | Backend HAL | `SET_MODE` accepts any value and reports success | Fixed, verified |
| LEG-8 | Critical | Backend HAL / physics | Non-numeric or non-finite PWM kills or poisons the physics thread | Fixed, verified |
| LEG-9 | Low | Backend fault injector | `SENSOR_LOSS` ignores depth and reverts to the wrong noise | Fixed, verified |

The LEG bugs are in the legacy ROV hardware path (`backend/main.py`, `serial_bridge.py`, `hal/`, `simulation/`).
The GANTRYLAB evaluation backend (`backend/gantrylab`) was audited and had no reproducible defect (see the end of this file).

## BUG-01 (High): field sites cannot be freely explored

- **Affected:** `components/field/FieldScene.tsx` (`createRig`, `CameraRig`), `components/platform/FieldWorkspace.tsx`, `lib/field/store.ts`, `components/field/common.ts`.
- **Reproduction:**
  1. Open `/` (harbor).
  2. Right-drag on the site: nothing moves.
  3. Scroll in: the camera can only close in on one fixed point at the site centre.
  4. Drag down: the view stops at the horizon, so you cannot get down to the bed or look up at the hull.
  5. On a real GPU, a 150 px right-drag moved the pivot by 0.00 m.
- **Expected:** you can move anywhere in the site, look around at seabed level, and the camera stays where you leave it.
- **Actual:** the camera only orbits the site centre, and the environment card covers about half the view.
- **Root cause:** the rig enabled pan only in the `free` view, which was hidden in a dropdown, and capped the polar angle at 0.49 pi. The overview also refitted itself whenever the panel layout changed, so a user who had moved the view was pulled back.
- **Fix:**
  - Pan and zoom toward the cursor are now on in both orbit views.
  - The first user gesture hands the camera to the free view, so a layout refit no longer applies, and any gesture cancels a running programmatic move.
  - Arrow keys glide the pivot (speed follows the view distance, with eased velocity), and PageUp/PageDown raise and lower it.
  - The camera may go below the horizon. `confine()` keeps the pivot within 1.15 half-extents and between the bed and the surface, and keeps the camera above the bed and, when under the surface, inside the site rather than in the terrain skirt.
  - An `EXPLORE` / `H` mode hides the panels and stops the feed pass. `Esc` or `Done` brings them back, and `RECENTER` / `C` returns to the overview.
  - The projection offset eases, so panels showing or hiding never jolt the picture.
  - Switching site from the free view reopens the new site's overview; the deep sea lies 1.5 km lower.
- **Regression tests:** `e2e/field-explore.spec.ts` (3 tests: pan, free hand-off and recenter; key glide and seabed confinement; explore mode, feed pass and site switch).
- **Verification:** 3/3 pass. A real-GPU probe showed pan, zoom-to-cursor, glide, an underwater look-around in the harbour and site switches at 60 fps with no console errors.

## BUG-02 (Medium): a lab pan during the explore glide is pulled back

- **Affected:** `components/lab/CameraRig.tsx`.
- **Reproduction:**
  1. Open `/lab`.
  2. Orbit once, which enters explore.
  3. Right-drag 150 px within the next second or two.
  4. On a real GPU the pivot moved 3 mm.
- **Expected:** the pivot follows the pan and stays there.
- **Actual:** the pivot slides back to the machine centre.
- **Root cause:** the explore glide re-fits the pivot to the whole machine every frame until it converges, and nothing stopped it when the user panned. A pan that opened explore started the glide too.
- **Fix:**
  - A pan (right button, Ctrl/Meta/Shift + left, or two fingers) ends the glide.
  - A pan that opens explore never starts one.
  - Orbit and scroll keep the documented glide behaviour: zoom is still not toward the cursor in the lab (docs/HANDOFF.md).
- **Regression test:** `e2e/explore.spec.ts` "a pan made while the explore glide runs, or one that opens explore, moves the pivot and stays". It fails on the old code (0.038 m against more than 0.05 m) and passes on the fix.
- **Verification:** `e2e/explore.spec.ts` 7/7.

## BUG-03 (Medium): every lab environment switch leaks GPU geometries

- **Affected:** `components/lab/TankDressing.tsx`, `components/lab/Particles.tsx`.
- **Reproduction:** cycle harbor, river, deep sea and tank, then read `gl.info.memory.geometries`. On a real GPU it went from 144 after one cycle to 209 after six, about 13 geometries per cycle. Textures stayed at 6.
- **Expected:** a flat count.
- **Actual:** the count grows on every visit to an environment.
- **Root cause:**
  - The substrate scatter, harbour, river and deep-sea props are built in `useMemo` and were never disposed when the dressing unmounted.
  - The particle cloud rebuilt its geometry and shader material whenever `drift` changed, which happens on every environment switch, and never disposed the old ones.
- **Fix:**
  - `useDisposeAll` frees each dressing's geometries and materials after unmount. It reuses the deferred, StrictMode-safe `useDeferredDispose` from the field code.
  - The particle drift is a live uniform, so the cloud is built once and disposed on unmount.
  - The intermediate chain-link geometries are disposed after the merge.
  - `window.__labStats` now reports `geometries`, `textures` and `programs`.
- **Regression test:** `e2e/environments.spec.ts` "cycling every environment releases the previous dressing's geometries". It fails on the old code (152 to 175) and passes on the fix.
- **Verification:** the real-GPU count is flat (140 then 131 after five more cycles). An instrumented run found 0 orphaned geometries.

## BUG-04 (Low): the Gantry card shows a stale target after a manual move

- **Affected:** `components/ui/scenes.tsx` (`GantryCard`).
- **Reproduction:**
  1. In scene 05, run an episode on the shipwreck until it is done.
  2. In scene 04, click the XY pad.
- **Expected:** Target reads `MANUAL`, and no Track chip is lit.
- **Actual:** Target reads "Shipwreck section", and its chip stays lit.
- **Root cause:** the target fell back to `rl.targetId`, which outlives the episode, in every mode except TRACK.
- **Fix:** in MANUAL mode there is no target.
- **Regression test:** `e2e/regressions.spec.ts` BUG-04.

## BUG-05 (Low): the Result card says "No test has run yet." after tests have run

- **Affected:** `components/ui/scenes.tsx` (`ResultCard`).
- **Reproduction:**
  1. Complete a test.
  2. Start another and open scene 07 mid-scan: "No test has run yet."
  3. Stop the scan: still "No test has run yet."
- **Expected:** during a run the card says a test is running. After a stopped scan it says the last test was stopped before it completed.
- **Actual:** it claims no test has ever run.
- **Root cause:** the engine clears `result` when a scan begins, and an aborted scan deliberately leaves it empty (asserted in `sim:check`). The card treated an empty result as "never ran".
- **Fix:** the card's empty state now distinguishes running, stopped (a previous result exists) and never-run. The engine behaviour is unchanged.
- **Regression test:** `e2e/regressions.spec.ts` BUG-05.

## BUG-06 (Low): leaving a 3D callout clears the pinned System highlight

- **Affected:** `components/lab/Overlays.tsx` (`Callout`), `components/ui/scenes.tsx` (`SystemCard`), `lib/sim/store.ts`.
- **Reproduction:**
  1. In scene 02, click the Gantry row, which pins its highlight.
  2. Hover the ARDUINO callout in the 3D view, then move away.
- **Expected:** the gantry highlight returns.
- **Actual:** nothing is highlighted, while the Gantry row still shows as pressed.
- **Root cause:** the pin lived in the card's local state, and the callout's leave handler set the highlight to `null`.
- **Fix:**
  - `pinnedHighlight`, `pinHighlight` and `releaseHighlight` now live in the store. Rows and callouts both return to the pin.
  - `setScene` and `reset` clear the pin.
- **Regression test:** `e2e/regressions.spec.ts` BUG-06.

## BUG-07 (Low): the XY pad ignores the selected inspection strategy

- **Affected:** `components/ui/scenes.tsx` (`XYPad`), `lib/gantry/strategies.ts`.
- **Reproduction:** select Coverage, Uncertainty-driven or User waypoints in scene 06. The pad in scene 04 still shows the six serpentine points.
- **Expected:** the pad shows the plan that will actually run.
- **Actual:** it shows the serpentine plan for every strategy.
- **Root cause:** the pad drew `TEST.scanWaypoints` unconditionally.
- **Fix:** `plannedViewpoints(strategy, waypoints)`:
  - The coverage plan for coverage.
  - The user's list, or the serpentine fallback, for waypoints.
  - Serpentine for serpentine and detection-driven, whose re-centring visits are only known live.
  - None for uncertainty-driven.
- **Regression test:** `e2e/regressions.spec.ts` BUG-07.

## BUG-08 (Medium): a capture sweep rewrites the live scenario

- **Affected:** `components/lab/capture.ts`, `components/lab/FeedRenderer.tsx`.
- **Reproduction:**
  1. In scene 03, start a "Turbidity sweep" capture.
  2. The store publishes turbidity 0, 0.25, 0.5, 0.75 and 1.
  3. The sliders jump, the live detector and any test started meanwhile run in the swept water, and a user change made during the sweep is overwritten when it finishes.
- **Expected:** the capture renders the swept conditions without touching the lab.
- **Actual:** the live scenario changes for the length of the sweep.
- **Root cause:** the capture called `engine.setScenario()` for every frame and restored the original values afterwards.
- **Fix:** `labWater` and `labFeedPass` take optional explicit conditions, the capture passes its sweep values to them, and the engine is never written.
- **Regression test:** `e2e/regressions.spec.ts` BUG-08, which records every published turbidity during the sweep.

## Legacy backend (LEG-1 to LEG-9)

The 24 regression cases are in `backend/tests_gantrylab/test_regression_legacy_serial.py` and `backend/tests_gantrylab/test_regression_legacy_ws.py`.
The WebSocket cases run against a real uvicorn server, because Starlette's TestClient hangs on these handlers.
A stub `serial` module and an in-memory UART stand in for pyserial, which is not installed in the venv.
All 24 failed before the fix, and all 124 backend tests pass after it.

- **LEG-1 (High), `serial_bridge.py`, `hal/broker.py`.**
  - Symptom: with no `/dev/ttyAMA0`, `set_mode("HARDWARE")` returned `success: True` with `hardware_connected=True`.
  - Root cause: `connect()` swallowed the exception, so the broker's `try` could never fail.
  - Fix: `connect()` returns a bool, and the broker uses it at startup and on a mode switch.
- **LEG-2 (High), `serial_bridge.py`.**
  - Symptom: a line such as `123`, `null` or `["depth", 5]` replaced the cache. `get_latest().copy()` or `.get` then raised and closed every telemetry socket.
  - Fix: non-object JSON lines are ignored.
- **LEG-3 (Medium), `serial_bridge.py`.**
  - Symptom: an invalid UTF-8 byte raised `UnicodeDecodeError`, which fell into the generic handler and its 1 s sleep.
  - Fix: decode with `errors="replace"`, so the line is dropped as malformed JSON.
- **LEG-4 (High), `serial_bridge.py`.**
  - Symptom: switching to HARDWARE after a successful startup opened a second handle and a second reader on the same UART. A fast reconnect revived the old reader.
  - Fix:
    - `connect()` first disconnects.
    - Each reader owns a stop `Event` and its own connection.
    - `disconnect()` joins the reader.
    - `set_mode` reuses a live link.
- **LEG-5 (High), `serial_bridge.py`.**
  - Symptom: after a read failure the reader logged once per second forever and never reopened the port, and `get_telemetry()` kept serving the last packet as armed and live.
  - Fix:
    - A read failure closes the port, drops the cache and reopens it with back-off from 0.2 s to 2 s.
    - Packets older than 1 s are not served, so the broker reports offline.
- **LEG-6 (High), `main.py`.**
  - Symptom: `not json`, `[1, 2]`, or `SET_PWM` with a missing, null or list payload dropped `/ws/command` with no close frame.
  - Fix: each message is validated inside the loop. Errors are answered with `{"type": "ERROR", "message": ...}`, and only `WebSocketDisconnect` ends the handler.
- **LEG-7 (Medium), `hal/broker.py`, `main.py`.**
  - Symptom: `SET_MODE` with `BANANA`, `simulation`, `null` or `42` returned success and put telemetry in an inconsistent mode.
  - Fix: only `SIMULATION` and `HARDWARE` are accepted, and the vision pipeline switches only on success.
- **LEG-8 (Critical), `hal/broker.py`, `simulation/physics_engine.py`.**
  - Symptom: a string PWM raised `TypeError` in the physics thread and froze the twin for good. `NaN`, `Infinity` and `1e400` made yaw `nan` permanently and emitted invalid JSON.
  - Fix:
    - PWM must be a finite number and is clamped to -100..100. Anything else raises `ValueError`, which the command channel reports.
    - The physics loop catches and logs a failed step instead of dying.
- **LEG-9 (Low), `simulation/sensor_sim.py`, `simulation/fault_injector.py`.**
  - Symptom: depth noise was hard-coded, so `SENSOR_LOSS` never affected it, and the revert set IMU noise to 0.1 against a 0.05 baseline.
  - Fix: depth reads `noise_std`, and the injector restores the noise it saved at construction.

## Investigated and not a defect

- **Replay determinism:** identical results from any start pose, at an odd frame rate (61.3 Hz ticks), after a mid-episode start, and on replay (headless probe).
- **Gantry overshoot:** at most 0.06 cm past an interior target, inside the 0.15 cm arrive tolerance. A move that ends on a rail end touches it at under 1.9 cm/s for about 60 ms, an integration artefact. Left alone so the calibrated golden run stays unchanged.
- **Aborted scan clears the result:** the engine behaviour is deliberate and asserted in `sim:check`; only the card copy was wrong (BUG-05).
- **Demo resets the environment to the lab tank:** deliberate, because the demo narrates the tank and the demo spec asserts the tank result.
- **Backend `gantrylab` package:** ids are regex-gated against traversal. Malformed multipart, corrupt zip, oversized bodies and bad compare arguments return clean 400, 404 or 413. Registration is locked against concurrent same-name uploads. Zero-annotation datasets complete.
- **`/video_feed` blocking the event loop:** the sync generator runs in Starlette's threadpool.
- **Lab frame rate:** 60 fps in every environment on the test GPU; field 60 fps.
