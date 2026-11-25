# Deploying GANTRYLAB

Two parts, deployed separately.
The frontend is complete without the backend: every simulation, the autonomy training and the hardware bench run in the browser, and the benchmark shows its simulated roster.
The backend adds real model evaluation.

## Frontend (Vercel)

1. Import the repository in Vercel. `vercel.json` sets the framework, region and a build that type-checks, lints and runs the unit tests first.
2. Set `NEXT_PUBLIC_GANTRYLAB_API` to the backend's https origin, or leave it unset for the standalone site. It is read at build time: redeploy after changing it. Unset, a deployed site never contacts localhost.
3. Deploy: `vercel` for a preview, `vercel --prod` for production.

Any Node 22 or newer host works too: `npm ci && npm run build && npm start`.
Security headers are in `next.config.ts`, so they are the same everywhere.
Web Serial (the hardware bench) needs https and Chrome or Edge.

## Backend (container)

```bash
export GANTRYLAB_API_TOKEN=$(openssl rand -hex 32)
export GANTRYLAB_CORS_ORIGINS=https://your-app.example
docker compose up -d backend
curl -s localhost:8000/api/v1/health
```

- It listens on localhost only. Put a TLS reverse proxy in front (the WebSocket `/api/v1/runs/*/events` must be upgraded, and the body limit raised to 2 GB for datasets).
- With `GANTRYLAB_API_TOKEN` set, every write needs it; reading results does not. Users paste the token once into the Model Lab status bar.
- Set the token on anything reachable from a network. The service accepts model files and executes them in a sandbox; the sandbox is a second line of defence, not a reason to leave it open.
- For hostile uploads, run the worker in the hardened container described in `backend/gantrylab/sandbox/Dockerfile.worker`.
- One process only. Run state and progress live in memory; a second worker would not see them. Runs interrupted by a restart are marked failed on startup.
- Back up the `gantrylab-data` volume: models, datasets, runs and reports. There is no delete endpoint yet, so watch its size.
- LLM narratives are optional; the compose file uses the deterministic provider.

Without Docker: `scripts/backend.sh` (macOS, Linux) or `npm run backend:windows`.

## Before each release

| Check | Command |
|---|---|
| Types, lint, unit tests, simulation, build | `npm run check` |
| Browser suite on a real GPU | `E2E_GPU=metal npm run e2e` (macOS), `E2E_GPU=gl` elsewhere |
| Backend | `cd backend && .venv/bin/python -m pytest tests_gantrylab -q` |

CI (`.github/workflows/ci.yml`) runs the first and the last on every push, the browser tests of the pages without 3D, and builds and starts the backend image.
The 3D suites need a GPU: software rendering reaches 3 to 6 frames per second.
