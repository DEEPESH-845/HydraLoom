# QA report (2026-11-24)

These are the verification results for the bug audit in `docs/BUG_AUDIT.md`.
Every number here was measured in this session; nothing is estimated.
Machine: Windows 11, Intel integrated GPU.
Browser E2E runs used Playwright Chromium with software GL (swiftshader), as configured in `playwright.config.ts`.
Real-GPU probes used Chromium on ANGLE Direct3D 11.

## Initial health (before any change)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run test:unit` | 51 / 51 pass |
| `npm run sim:check` | pass, golden run 5 detected, 1 false positive, coverage 90%, reward +15.70, 43.4 s |
| `npm run build` | clean |
| backend `pytest tests_gantrylab` | 100 / 100 pass |
| `npm run e2e` (baseline) | stopped at test 55 of 73 so fixes could start; 54 passed, 1 failed |

The one baseline failure was `demo.spec.ts` "runs the complete presentation", which timed out at demo phase 7 of 8.
It ran while a parallel backend test session loaded the CPU.
Run alone, it passes; see "Demo timing" below.

## Final results (after all fixes)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run test:unit` | 51 / 51 pass |
| `npm run sim:check` | pass, golden run unchanged (same numbers as above) |
| `npm run build` | clean, 8 routes |
| backend `pytest tests_gantrylab` | 124 / 124 pass (100 existing + 24 new regression cases) |
| `e2e/field-explore.spec.ts` (new) | 3 / 3 pass |
| `e2e/explore.spec.ts` (1 new test) | 7 / 7 pass |
| `e2e/regressions.spec.ts` (new) | 5 / 5 pass |
| `e2e/environments.spec.ts` GPU memory test (new) | 1 / 1 pass |
| `e2e/demo.spec.ts`, run alone | 2 / 2 pass; demo phases 0>1>2>3>4>5>6>7, 289 s wall, 60 s sim |

Each new E2E regression was also run against the code before its fix, and every one failed:
- the lab pan test: 0.038 m against more than 0.05 m;
- the GPU memory test: 152 to 175 geometries;
- all five tests in `regressions.spec.ts`.

### Full `npm run e2e` after the fixes: incomplete

The full suite (83 tests) was stopped by the host at test 79, because the machine ran critically low on memory.
Of the 78 tests that finished, 71 passed and 7 failed.
The last four tests never ran: 3 in `test-run.spec.ts` and the visual regression in `visual.spec.ts`.

| Failed test | Error | Assessment |
|---|---|---|
| `environments.spec.ts` "each environment dresses the same tank..." | feed luma poll timed out after switching back to the tank | Not confirmed as a regression. It passed in the baseline. Its GPU-memory sibling passed in the same file. The failure happened during the same memory pressure. Needs a re-run. |
| `evaluation.spec.ts` mock run report, patch diff, follow-up assistant, generate report, responsive 390x844 and 1440x900 | HTTP 500 and `pageerror: Jest worker encountered 2 child process exceptions, exceeding retry limit` | The Next dev server's worker crashed. These pages (`/reports`, `/models`) were not changed in this session, and all six passed in the baseline. |

Open item: re-run `npm run e2e` on a machine with free memory.
Until then, the visual baselines (`visual.spec.ts`), `test-run.spec.ts`, and the two environment specs above are not verified after the fixes.
No screenshot baseline was regenerated in this session.

## Real-GPU probes (Chromium, ANGLE D3D11, 1440 x 900)

- **Field frame rate:** 60.4 fps, worst frame 17 ms, before and after the camera changes.
- **Lab frame rate:** 60.2 to 60.4 fps in tank, harbor, river and deep sea.
- **Field exploration after the fix:**
  - A right-drag pans the pivot (it moved about 17 m), and the view switches to `free`.
  - A scroll zooms toward the cursor.
  - Holding an arrow key glides the pivot about 30 m in 1.2 s.
  - Looking up from the harbour bed works: the hull, pilings and chain are visible from below.
  - Site switches took 2.9 s for the first river compile and 0.33 s for later ones.
  - No console errors or warnings, apart from the known `THREE.Clock` deprecation.
- **Lab GPU memory over environment cycles:**
  - Before the fix: 144 geometries after 1 cycle, 209 after 6.
  - After the fix: 140 after 1 cycle, 131 after 6.
  - An instrumented run found 0 orphaned geometries.
- **Lab explore pan:**
  - Before the fix, a pan made during the glide moved the pivot 3 mm.
  - After the fix, it follows the pointer, as the E2E test covers.

## Demo timing

The scripted demo runs on a wall clock, and the simulation step is capped at 0.1 s per frame.
At the 2 to 3 fps of software GL, the demo needs most of its 600 s test budget, so any extra CPU load can push it over.
This is a property of the CI set-up, not a product defect: on a real GPU the demo runs at 60 fps.

## Not verified

- Physical hardware: no Arduino, Raspberry Pi or UART was attached. The serial fixes are verified against an in-memory UART and a real uvicorn server.
- Real model inference in the evaluation backend: not exercised in this session beyond the existing pytest suite.
- Touch gestures: the two-finger pan path in the lab is covered by code review only, not by a touch-emulation test.
