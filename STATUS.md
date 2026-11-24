# STATUS: contract (integ/contract)

## Done
- Pydantic models in `backend/gantrylab/rig/models.py` are the source of truth.
- `contracts/rig/v1/*.schema.json` are generated from them (`cd backend && python -m gantrylab.rig.models`); a test fails if they go stale.
- TS types and guards in `lib/rig/types.ts` validate against the same schemas.
- Shared valid and invalid fixtures, run by both languages.

## Tests run
- `pytest tests_gantrylab/test_rig_contract.py`: 34 passed.
- `tsx --test lib/rig/contract.test.ts`: 31 passed.
- `tsc --noEmit` and `eslint lib/rig`: exit 0.

## Not done
- Schemas for results.json, experiments.csv and calib.json: the originals on D:\ are absent, so they are open objects (`OpenObject`, `RigOpenObject`).
- Full repo gates (full pytest, all unit tests, Playwright, sim:check) were not run.

## Known issues / decisions to confirm
- TS types are handwritten, not generated; fixtures guard validation but not type drift.
- The brief does not name the command field; `cmd` was chosen.
- The health field layout is a choice: the brief lists only versions, model, camera, serial, throttled. `v`, `source`, `rig` and `dry_run` were added.
- Every command carries `id`, including heartbeat.
- `move` checks shape only; safe-box rejection belongs to the bridge.

## Next steps
- Merge first; confirm `cmd` and health layout with the lead.
- Tighten run and calib shapes once real samples are available.
