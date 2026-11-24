---
name: underwater-simulation-physics
description: Physical models, units and conventions of the GANTRYLAB simulation (water optics, currents, vehicle dynamics, environments, analytical detector). Use before changing lib/physics, lib/world, lib/field, lib/optics or lib/sim, or when adding an environment or vehicle.
---

# Underwater simulation physics

Read `docs/PHYSICS.md` first; it is the reference and must be updated in the same change as the code.

## Conventions

- SI units in all physics; world +X east, +Y up, +Z south; body +X forward, +Y up, +Z starboard; quaternions `[x, y, z, w]` body to world.
- Compass heading clockwise from north; currents are given as the direction they flow TOWARD.
- Water current velocity is never vehicle velocity: hydrodynamic forces use the relative velocity `v - v_c`.
- Field sites put the sea surface at y = 0.

## Process

- Keep models deterministic and seeded (`lib/sim/rng.ts`); no `Math.random` in `lib/`.
- Every representative value goes into the environment's `assumptions` list and `docs/PHYSICS.md` section 8, with its source.
- Never claim real-world accuracy; say "representative" or "assumed" unless calibrated.
- Add or update an invariant test in `lib/**/*.test.ts` for every model change: monotonic in turbidity, drag opposes relative motion, divergence-free turbulence, determinism, and so on.
- The lab golden run (5 detected, 4 correct, 1 false positive, 90 percent coverage, +15.70 reward, 43.4 s) must not change unless the change is intended and `docs/BLUEPRINT.md` is updated.

## Checks

```bash
npm run test:unit     # node:test suites under lib/
npm run sim:check     # lab golden numbers and invariants
npm run typecheck
```
