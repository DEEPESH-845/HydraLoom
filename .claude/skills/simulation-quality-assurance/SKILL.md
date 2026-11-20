---
name: simulation-quality-assurance
description: Verification workflow for GANTRYLAB changes - which checks to run, how the Playwright fixture works, screenshot baselines and what counts as done. Use before declaring any GANTRYLAB change complete.
---

# Simulation quality assurance

## Gates (all must pass)

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run sim:check
npm run build
npm run e2e            # about 20 min under software GL; reuses a dev server on :3000
cd backend && .venv/Scripts/python -m pytest tests_gantrylab -q
```

## Browser tests

- `e2e/lab.ts` (Gantry Lab at `/lab`) and the field fixture fail any test on a console error, page error or failed request; only the known upstream `THREE.Clock` deprecation and swiftshader warnings are allowed.
- Wait on state predicates through the dev hooks, never on fixed sleeps.
- Screenshot baselines live in `e2e/__screenshots__`; update them with `npm run e2e:update` only for intended visual changes, and look at every changed image.
- Reproduce a bug end to end before fixing it, and leave a test that fails without the fix.

## Done means

- Every displayed control works.
- Nothing claims more than was measured; SIMULATED / MEASURED / ESTIMATED labels are correct.
- Docs (`docs/ARCHITECTURE.md`, `docs/PHYSICS.md`, `docs/API_V1.md`, validation matrix) match the code.
