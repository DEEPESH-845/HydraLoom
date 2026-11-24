# GANTRYLAB model-evaluation backend

FastAPI service in `backend/gantrylab/` that evaluates uploaded object detectors (Ultralytics `.pt`, ONNX) against synthetic ground truth rendered by the GANTRYLAB digital twin.
The HTTP contract is `docs/API_V1.md`.
The legacy ROV dashboard files in `backend/` (`main.py`, `vision_pipeline.py`, `hal/`, `simulation/`, `serial_bridge.py`) are unrelated and untouched.

## Install

Python 3.12 in an isolated virtual environment (the global Anaconda interpreter is not used).

```bash
cd backend
uv venv .venv --python 3.12
# NVIDIA GPU (Blackwell needs CUDA 12.8 wheels):
uv pip install --python .venv/Scripts/python.exe torch==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cu128
# CPU-only machines: use --index-url https://download.pytorch.org/whl/cpu instead.
uv pip install --python .venv/Scripts/python.exe ultralytics==8.4.215 onnx==1.23.2 onnxruntime==1.32.0 \
  fastapi==0.165.0 "uvicorn[standard]==0.54.0" python-multipart==0.0.34 pydantic==2.14.4 numpy==2.5.4 \
  pillow==13.0.0 psutil==7.2.2 pyyaml==6.0.3 httpx==0.28.1 pytest==9.2.0 httpx2==2.16.2
```

Exact pins live in `backend/pyproject.toml`.
On Linux and macOS the interpreter path is `.venv/bin/python`; on macOS install torch from PyPI (no `--index-url`).
On macOS the sandbox memory limit is the RSS watchdog alone: the system refuses to lower `RLIMIT_AS`.

## Run

```bash
cd backend
.venv/Scripts/python -m uvicorn gantrylab.app:app --port 8000
```

Interactive docs: `http://127.0.0.1:8000/docs`.
Data lives under `backend/data/` (ignored by git); override with `GANTRYLAB_DATA_DIR`.
All environment variables are listed at the end of `docs/API_V1.md`.

## Test

```bash
cd backend
.venv/Scripts/python -m pytest tests_gantrylab -q            # everything, including real inference
.venv/Scripts/python -m pytest tests_gantrylab -q -m "not real"  # fast suite for CI (mock adapter only)
.venv/Scripts/python -m pytest tests_gantrylab -m real -s      # real inference with timings printed
```

The `real` tests use `backend/yolov8n.pt` and export it once to `backend/data/fixtures/yolov8n.onnx`.

## Architecture

```
gantrylab/
  app.py                FastAPI factory, CORS, lifespan (restart recovery)
  config.py             environment settings
  schemas.py            Pydantic v2 request / response models
  storage.py            atomic JSON writes, read-only originals, ids, hashes
  api/routes.py         every /api/v1 route
  api/multipart.py      streaming multipart parser with mid-stream size caps
  services/models.py    upload validation, content-addressed storage, sandboxed inspection
  services/datasets.py  manifest validation, image checks, YOLO / COCO export
  services/runs.py      background runs, progress events, metrics assembly
  services/compare.py   run-to-run deltas
  sandbox/runner.py     launches the worker: scrubbed env, empty cwd, timeout, memory and process limits
  sandbox/worker.py     isolated process: inspect / infer, JSON-lines protocol on stdout
  sandbox/restricted_pickle.py  allowlisting unpickler used for every torch.load in the worker
  sandbox/Dockerfile.worker     hardened container for production
  adapters/             InferenceAdapter, UltralyticsPtAdapter, OnnxAdapter (numpy decode + NMS), MockAdapter
  metrics/              pure-numpy metrics engine (source of truth), buckets, latency statistics
  hardware.py           measured host profiles, estimated Raspberry Pi profiles
  llm/providers.py      Anthropic, OpenAI, Ollama, deterministic
  reports/              evidence, rules-based suggestions, narrative verification, patches, HTML export, Q&A
```

Storage is a filesystem JSON registry (no database, no queue).
Runs execute in a `ThreadPoolExecutor` (`GANTRYLAB_MAX_CONCURRENT_RUNS`, default 1); each real run starts one sandbox worker process.

## Security model for uploaded models

A `.pt` file is a pickle and loading it can execute arbitrary code.
The design assumes every upload is hostile.

What the API process does:

- Streams the upload to a temporary file with a byte cap and rejects it mid-stream when the cap is exceeded.
- Checks the extension, the zip magic and the `<dir>/data.pkl` entry (or the ONNX protobuf tag) without unpickling anything.
- Stores the file by SHA-256 and clears its write bits; it is never rewritten.
- Never imports the checkpoint, never calls `torch.load` or `YOLO()` on it.

What the sandbox worker does:

- Runs as `python -I` (isolated mode: no `PYTHON*` variables, no user site, no cwd on `sys.path`).
- Gets a scrubbed environment: only `PATH`, `SYSTEMROOT`, `WINDIR`, CPU descriptors and `CUDA_VISIBLE_DEVICES` pass through; anything matching `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `AUTH` is dropped; `HOME`, `TEMP`, `APPDATA` and the Ultralytics config dir point into a private temp dir; `YOLO_OFFLINE` and `YOLO_AUTOINSTALL=False` are set.
- Starts in an empty temporary working directory.
- Has a wall-clock timeout (`GANTRYLAB_WORKER_TIMEOUT_S`, `GANTRYLAB_INSPECT_TIMEOUT_S`) and a memory limit (`GANTRYLAB_WORKER_MEM_MB`).
  On Windows the process is created suspended and assigned to a Job Object with a per-process committed-memory limit, kill-on-close and an active-process limit of 2 (venv launcher plus interpreter), so it cannot spawn children.
  On POSIX it gets `RLIMIT_CORE=0`, a new session and, for CPU jobs, `RLIMIT_AS`; CUDA jobs rely on the RSS watchdog because CUDA reserves large virtual ranges.
  A psutil watchdog in the parent kills the process tree on RSS overflow or timeout.
- Loads checkpoints only through `torch.load(..., weights_only=False, pickle_module=restricted_pickle_module)`.
  `torch.load` is patched inside the worker so Ultralytics' own loading path also uses the restricted module.
- Installs a Python audit hook after trusted imports that blocks process creation, sockets, DNS lookups and file writes outside the private temp dir.

The restricted unpickler:

- `find_class` resolves only an allowlist: safe builtins (`set`, `frozenset`, `slice`, `dict`, `list`, `tuple`, `int`, `float`, `bool`, `str`, `bytes`, `bytearray`, `complex`, `range`), `collections` containers, `copyreg` reconstructors, `_codecs.encode`, `argparse.Namespace`, `types.SimpleNamespace`, pure `pathlib` classes, numpy array reconstruction, torch dtypes / `Size` / `device` / tensor rebuild helpers, `torch.nn` module classes, `ultralytics.nn` module classes, `ultralytics.utils.IterableSimpleNamespace` and classes from `ultralytics.utils.loss` / `ultralytics.utils.tal`.
  `getattr`, `eval`, `exec`, `os.*`, `subprocess.*`, `importlib.*`, `torch.save`, `torch.load` and everything else raise `DisallowedGlobal` before the module is imported.
  `ultralytics.nn.autobackend` and `ultralytics.nn.text_model` are denied because their constructors load or download weights.
- `REDUCE`, `INST` and `OBJ` (the opcodes that call objects) may only call a smaller allowlist of side-effect-free callables.
  Allowlisted `nn.Module` classes can therefore only be created through `NEWOBJ` (`cls.__new__`), so their `__init__` never runs with attacker-chosen arguments.
- `torch._tensor._rebuild_from_type_v2` and `copyreg._reconstructor` are wrapped so the function they call must itself be allowlisted.

Tests (`tests_gantrylab/test_sandbox_security.py`) build malicious checkpoints that reference `os.system`, `nt.system`, `posix.system`, `builtins.eval`, `builtins.exec`, `subprocess.Popen`, `builtins.getattr`, `importlib.import_module`, `torch.save`, a payload nested inside an `OrderedDict`, a `REDUCE` on an allowlisted model class, and a `_rebuild_from_type_v2` that smuggles a constructor.
Every one is rejected and the marker file its payload would create never appears, both in-process and through the HTTP API with the real sandbox.
Further tests prove the environment is scrubbed, the cwd is empty, the timeout and the memory limit kill the worker, and child processes are refused (by the audit hook and, on Windows, by the Job Object alone).

### Residual risk

This is defence in depth, not a proof of safety.
Known gaps:

- Allowlisted classes still run their `__new__` and `__setstate__` (pickle `BUILD`) with attacker-controlled state; a gadget in torch, numpy or Ultralytics code reachable that way would execute inside the worker.
- The worker can still read any file the service account can read and could exfiltrate data through its stdout protocol to the parent (the parent only parses expected message types).
- Python audit hooks are not a security boundary; native code (torch kernels, onnxruntime, image decoders) can bypass them.
- The local subprocess has network access at the OS level; only the audit hook blocks sockets.
- ONNX graphs are parsed by `onnx` and `onnxruntime` native code in the worker; parser bugs are possible.
- On Windows the Job Object is applied after `CreateProcess` returns but before the process is resumed, so there is no unconfined window; on POSIX `RLIMIT_AS` is skipped for CUDA jobs.

For production, run the worker inside the container in `gantrylab/sandbox/Dockerfile.worker` with `--network none --read-only`, a tmpfs for `/tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit` and `--memory`, mounting models and datasets read-only.
A gVisor or Firecracker runtime adds kernel isolation on top.

## Metrics, mock runs and reports

- The metrics engine (`metrics/engine.py`) is pure numpy and is validated against hand-computed cases (perfect predictions, a 101-point AP worked by hand, IoU edges, greedy matching order, confusion and background counts, empty frames, COCO size ranges).
- The mock adapter derives detections from ground truth with seeded noise for CI and UI work.
  Its runs, metrics, reports and answers all carry `mock: true` and "MOCK ADAPTER - not a real model evaluation"; it reports no latency.
- Reports are built from an evidence payload with a SHA-256 `evidence_hash`.
  Structured numbers are copied from the metrics engine.
  LLM narrative is schema-validated with one repair retry; any field containing a number absent from the evidence is replaced by deterministic text, and invalid evidence references are dropped.
  Provider errors, timeouts or invalid output fall back to the deterministic provider and set `fallback: true`.
- Providers receive aggregated evidence only, never images, weights or file paths of uploads; keys are read from the environment at call time and never logged or returned.
- Config suggestions come from a deterministic rules engine; patch endpoints return a patched copy plus a unified diff and never touch the stored original.

## Compute profiles

`host-cpu` and `host-gpu` are measured on the machine that ran inference.
`rpi4` and `rpi5` are estimates from `latency_ms = GFLOPs(imgsz) / effective_GFLOPs * 1000 + overhead_ms`, with assumption constants (3.0 and 10.0 GFLOP/s, 25 and 12 ms) that are labelled in every response and must be replaced by a measurement on the real device.
