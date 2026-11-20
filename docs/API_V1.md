# GANTRYLAB backend API v1

Contract for the model-evaluation backend in `backend/gantrylab/`.
All routes live under `/api/v1`.
Every request and response body is a Pydantic v2 model defined in `backend/gantrylab/schemas.py`.
The live OpenAPI schema is served at `/openapi.json` and the interactive docs at `/docs`.

Run the service:

```bash
cd backend
.venv/Scripts/python -m uvicorn gantrylab.app:app --port 8000
```

## Conventions

- Bodies are JSON unless the endpoint says multipart.
- Errors use FastAPI's shape: `{"detail": "<message>"}` or `{"detail": {"message": ..., "errors": [...]}}`.
- `400` means a request that can never succeed as sent (bad extension, bad magic, files not matching the manifest).
- `404` means an unknown id, `409` means a valid request in the wrong state (model still pending, run not complete).
- `413` means a size or count cap was exceeded, `415` a non-multipart upload, `422` a schema validation failure.
- Timestamps are UTC ISO 8601 with a `Z` suffix.
- Ids: models use their SHA-256 (64 hex chars), datasets `ds_<12 hex>`, runs `run_<12 hex>`, reports `rep_<12 hex>`.
- CORS allows `http://localhost:3000` and `http://127.0.0.1:3000` by default (`GANTRYLAB_CORS_ORIGINS`, comma separated).
- `null` always means "not available" and is never a stand-in for zero.

## Value provenance

Three kinds of numbers exist and are never mixed in one field.

| Kind | Meaning | Where |
|---|---|---|
| `measured` | Observed on this host by the sandbox worker. | `metrics.latency`, `metrics.resources`, `hardware` blocks for `host-cpu` / `host-gpu` |
| `estimated` | Computed from a labelled throughput model with stated assumptions; never measured. | `hardware` blocks for `rpi4` / `rpi5` |
| `simulated` | Produced by the mock adapter; no inference ran. | `hardware` host blocks of mock runs, `metrics.simulated` |

Mock-adapter artefacts carry `mock: true` and the banner `MOCK ADAPTER - not a real model evaluation`.

## Endpoint list

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Versions, adapters, devices, configured LLM providers |
| GET | `/api/v1/compute-profiles` | Measured host profiles and estimated embedded profiles |
| POST | `/api/v1/models` | Upload a `.pt` or `.onnx` model (multipart) |
| GET | `/api/v1/models` | List models |
| GET | `/api/v1/models/{id}` | One model with inspection results and versions |
| POST | `/api/v1/datasets` | Upload a synthetic dataset (multipart manifest + frames) |
| GET | `/api/v1/datasets` | List datasets |
| GET | `/api/v1/datasets/{id}` | Dataset record plus per-frame summary |
| GET | `/api/v1/datasets/{id}/manifest` | Validated manifest including annotations |
| GET | `/api/v1/datasets/{id}/frames/{file}` | One frame image |
| GET | `/api/v1/datasets/{id}/export/yolo.zip` | YOLO export (images, labels, data.yaml) |
| GET | `/api/v1/datasets/{id}/export/coco.json` | COCO detection export |
| POST | `/api/v1/runs` | Start an evaluation run (returns immediately) |
| GET | `/api/v1/runs` | List runs |
| GET | `/api/v1/runs/{id}` | Run status, progress, config, versions |
| WS | `/api/v1/runs/{id}/events` | Progress event stream |
| GET | `/api/v1/runs/{id}/metrics` | Full metrics (after completion) |
| GET | `/api/v1/runs/{id}/predictions` | Raw per-frame predictions (after completion) |
| POST | `/api/v1/runs/{id}/report` | Generate an engineering report |
| GET | `/api/v1/reports` | List reports (optional `?run_id=`) |
| GET | `/api/v1/reports/{id}` | One report |
| GET | `/api/v1/reports/{id}/export.json` | Report plus its evidence payload, as a download |
| GET | `/api/v1/reports/{id}/export.html` | Self-contained, print-friendly HTML |
| GET | `/api/v1/reports/{id}/patches/{file}` | Patched copy and unified diff of `data.yaml`, `hyp.yaml` or `inference.yaml` |
| POST | `/api/v1/reports/{id}/ask` | Follow-up question answered from the stored evidence |
| GET | `/api/v1/compare?runs=a,b` | Side-by-side metrics and per-slice deltas |

## Health and compute profiles

### `GET /api/v1/health` -> `HealthResponse`

```json
{
  "status": "ok",
  "service": "gantrylab-backend",
  "version": "0.1.0",
  "versions": {"python": "3.12.13", "torch": "2.11.0+cu128", "ultralytics": "8.4.215", "onnxruntime": "1.32.0"},
  "adapters": {"ultralytics": true, "onnx": true, "mock": true},
  "devices": {"cpu": "<cpu name>", "cuda": ["NVIDIA GeForce RTX 5070 Laptop GPU"], "torch_cuda_build": "cu128"},
  "llm_providers": {"anthropic": false, "openai": false, "ollama": false, "deterministic": true},
  "llm_default": "auto",
  "data_dir_writable": true,
  "limits": {"max_model_mb": 512, "max_dataset_frames": 5000, "max_frame_mb": 20, "max_dataset_mb": 2048,
             "worker_timeout_s": 1800.0, "worker_mem_mb": 8192}
}
```

`llm_providers` only reports booleans; keys are never returned.
The health check does not import torch; GPU names come from `nvidia-smi`.

### `GET /api/v1/compute-profiles` -> `ComputeProfileList`

```json
{"profiles": [
  {"id": "host-cpu", "name": "This host - CPU (...)", "kind": "measured", "hardware_name": "...", "available": true,
   "device": "cpu", "method": "measured by executing the run on this host's CPU", "effective_gflops": null,
   "overhead_ms": null, "assumptions": ["..."]},
  {"id": "host-gpu", "kind": "measured", "device": "cuda", "available": true, "...": "..."},
  {"id": "rpi4", "kind": "estimated", "device": null, "effective_gflops": 3.0, "overhead_ms": 25.0,
   "method": "GFLOPs throughput model (estimate, never measured)", "assumptions": ["ASSUMPTION: ...", "ESTIMATE ONLY - ..."]},
  {"id": "rpi5", "kind": "estimated", "effective_gflops": 10.0, "overhead_ms": 12.0, "...": "..."}
]}
```

Estimated latency: `latency_ms = gflops * (imgsz / gflops_imgsz)^2 / effective_gflops * 1000 + overhead_ms`.
`effective_gflops` and `overhead_ms` are assumption constants in `backend/gantrylab/hardware.py`.
They must be replaced by a measurement on the real device before any decision relies on them.
ONNX models have no GFLOPs figure, so their estimated blocks report `null` latency.

## Models

### `POST /api/v1/models` (multipart) -> `ModelRecord`

Parts:

| Part | Required | Notes |
|---|---|---|
| `file` | yes | Exactly one file, extension `.pt` or `.onnx` |
| `name` | no | Display name, 1-120 chars `[A-Za-z0-9 ._()+-]`; defaults to the file stem |

Validation in the API process (nothing is ever unpickled there):

- The body is streamed to disk with a byte counter; the upload is aborted with `413` as soon as it passes `GANTRYLAB_MAX_MODEL_MB` (default 512).
- File names with path separators, `..` or control characters are rejected with `400`.
- `.pt` must be a zip archive (`PK\x03\x04`) with exactly one `<dir>/data.pkl` entry; legacy non-zip pickles (`\x80` first byte) are rejected.
- `.onnx` must start with the protobuf tag of `ModelProto.ir_version` (`0x08`); full parsing happens in the sandbox.

Storage: `data/models/<sha256>/original.<ext>`, made read-only, never rewritten.

Responses:

- `201` with `status: "pending"` for a new file; inspection runs in the background in the sandbox worker.
- `200` with `deduplicated: true` when the same SHA-256 already exists; the existing record is returned unchanged.

Uploading a different file under an existing `name` creates the next `version`.

### `ModelRecord`

```json
{
  "id": "<sha256>",
  "sha256": "<sha256>",
  "name": "yolov8n",
  "version": 1,
  "versions": [{"version": 1, "id": "<sha256>", "sha256": "<sha256>", "uploaded_at": "2026-11-20T05:00:00Z", "status": "ready"}],
  "format": "pt",
  "size_bytes": 6534387,
  "original_filename": "yolov8n.pt",
  "uploaded_at": "2026-11-20T05:00:00Z",
  "status": "ready",
  "status_reason": null,
  "inspection": {
    "format": "pt", "task": "detect", "names": {"0": "person", "1": "bicycle"}, "nc": 80, "imgsz": 640,
    "parameters": 3157200, "gflops": 8.855, "gflops_imgsz": 640, "architecture": "DetectionModel",
    "checkpoint_ultralytics_version": "8.0.0.dev0", "checkpoint_date": "2022-12-30T00:12:08.084698",
    "checkpoint_torch_version": null, "checkpoint_epoch": -1,
    "train_args": {"epochs": 500, "imgsz": 640, "batch": 16, "data": "coco.yaml"},
    "forward_check": "ok",
    "worker_versions": {"python": "3.12.13", "torch": "2.11.0+cu128", "ultralytics": "8.4.215"}
  },
  "inspected_at": "2026-11-20T05:00:03Z",
  "storage_path": "models/<sha256>/original.pt",
  "deduplicated": false
}
```

`status` is `pending`, `ready` or `rejected`.
A rejected model has a human-readable `status_reason`, for example `rejected by sandbox inspection: DisallowedGlobal: Disallowed pickle global os.system: not in allowlist`.
Models whose task is not `detect`, `segment` or `pose`, or that have no class names, are rejected.
ONNX inspections add `onnx_producer`, `onnx_opset`, `inputs` and `outputs`; `gflops` is `null`.
PyTorch checkpoints do not store the torch version that wrote them, so `checkpoint_torch_version` is `null`.

### `GET /api/v1/models` -> `{"models": [ModelRecord]}` (newest first)

### `GET /api/v1/models/{id}` -> `ModelRecord`

## Datasets

### `POST /api/v1/datasets` (multipart) -> `DatasetRecord` (201)

Parts:

| Part | Required | Notes |
|---|---|---|
| `manifest` | yes | JSON text (a plain field or a Blob part) matching `gantrylab.dataset/1` |
| `files` | yes | One part per frame; the part's file name must equal `frames[].file` |

Manifest schema `gantrylab.dataset/1` (unknown keys are rejected):

```json
{
  "schema": "gantrylab.dataset/1",
  "name": "harbor sweep",
  "seed": 1337,
  "generator": {"app": "gantrylab-web", "version": "0.2.0", "renderer": "three r184"},
  "classes": ["SHIPWRECK", "MINE", "DEBRIS", "PILING", "TIRE"],
  "frames": [
    {
      "file": "000001.png", "width": 640, "height": 480,
      "camera": {"fx": 417.0, "fy": 417.0, "cx": 320, "cy": 240, "position": [0, 1, 2], "quaternion": [0, 0, 0, 1], "hfov_deg": 75},
      "conditions": {"environment": "harbor", "platform": "rov", "turbidity": 0.2, "ntu": 2.6, "lighting": 0.8,
                     "current_speed_mps": 0.4, "current_dir_deg": 90, "depth_m": 6.0, "vehicle_speed_mps": 0.3, "motion_blur_px": 1.2},
      "annotations": [
        {"object_id": "wreck-01", "class_name": "SHIPWRECK", "bbox_xywh": [100, 120, 80, 40], "visible_fraction": 0.92,
         "occluded_fraction": 0.05, "truncated": false, "distance_m": 1.4, "area_px": 2900}
      ]
    }
  ]
}
```

Rules:

- `bbox_xywh` is top-left x, y, width, height in pixels; width and height must be positive and the box must lie inside the image (1 px tolerance).
- `classes` are unique; every `class_name` must be listed; `object_id` is unique within a frame.
- `file` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, contains no `..`, ends in `.png`, `.jpg` or `.jpeg`, and file stems are unique.
- `conditions` keys match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; values are strings, numbers, booleans or null (64 keys at most).
- The uploaded file set must equal the manifest file set; missing and unexpected names are listed in the error.
- Every image must decode, its real format must match its extension, and its size must equal `width` x `height`.
- Caps: `GANTRYLAB_MAX_DATASET_FRAMES` (5000), `GANTRYLAB_MAX_FRAME_MB` (20), `GANTRYLAB_MAX_DATASET_MB` (2048), `GANTRYLAB_MAX_MANIFEST_MB` (32).

Storage under `data/datasets/<id>/`: `images/` (read-only), `labels/<stem>.txt`, `manifest.original.json` (as uploaded, read-only), `manifest.json` (validated), `coco.json`, `data.yaml`, `dataset.json`.

### `DatasetRecord`

```json
{
  "id": "ds_0123456789ab",
  "name": "harbor sweep",
  "schema": "gantrylab.dataset/1",
  "seed": 1337,
  "generator": {"app": "gantrylab-web", "version": "0.2.0", "renderer": "three r184"},
  "classes": ["SHIPWRECK", "MINE", "DEBRIS", "PILING", "TIRE"],
  "n_frames": 120,
  "n_annotations": 240,
  "class_counts": {"SHIPWRECK": 48, "MINE": 48, "DEBRIS": 48, "PILING": 48, "TIRE": 48},
  "conditions": {
    "turbidity": {"type": "numeric", "min": 0.05, "max": 0.8, "values": null, "n_frames": 120},
    "environment": {"type": "categorical", "min": null, "max": null, "values": ["harbor", "reef"], "n_frames": 120}
  },
  "manifest_sha256": "<sha256 of the canonical validated manifest>",
  "total_bytes": 10485760,
  "created_at": "2026-11-20T05:00:00Z"
}
```

`GET /api/v1/datasets/{id}` returns `DatasetDetail`: the record plus `frames: [{file, width, height, conditions, n_annotations}]`.

### Exports

- `GET .../export/yolo.zip`: `data.yaml` (`path: .`, `train: images`, `val: images`, `nc`, `names`), `images/*`, `labels/<stem>.txt`.
  Each label line is `class cx cy w h`, normalised to [0, 1] with 6 decimals, boxes clipped to the image.
- `GET .../export/coco.json`: COCO detection format.
  Category ids are 1-based in `classes` order, `bbox` is `[x, y, w, h]`, `area` is `w * h`, `iscrowd` is 0.
  Extra per-annotation fields live under `gantrylab` and per-image conditions under `gantrylab_conditions`.

## Runs

### `POST /api/v1/runs` -> `RunCreated` (202)

```json
{
  "model_id": "<sha256>",
  "dataset_id": "ds_0123456789ab",
  "adapter": "auto",
  "seed": 0,
  "config": {
    "conf": 0.25,
    "iou": 0.7,
    "imgsz": 640,
    "max_det": 300,
    "device": "auto",
    "class_map": {"boat": "SHIPWRECK", "person": null},
    "compute_profile": "auto",
    "budget_fps": 10.0,
    "warmup_frames": null
  }
}
```

- `adapter`: `auto` picks `ultralytics` for `.pt` and `onnx` for `.onnx` (both run in the sandbox worker); `mock` uses the deterministic mock adapter.
- `conf` is the operating threshold for precision, recall, F1, the confusion matrix and failure lists.
  Inference itself always runs with a confidence floor of 0.001 so that AP and the PR curve are complete.
- `iou` is the NMS IoU threshold.
  Matching for metrics uses IoU 0.5 (and 0.50:0.95 for COCO AP).
- `imgsz` must be a multiple of 32; `device` is `cpu`, `cuda` or `auto`.
- `class_map` maps model class names to dataset classes or `null` (ignored).
  Unmapped model classes default to the case-insensitive equal dataset class, otherwise they are ignored.
  Unknown keys or values return `400`.
- `compute_profile` is `auto`, `host-cpu`, `host-gpu`, `rpi4` or `rpi5`; it selects the `metrics.hardware` block.
- `budget_fps` is the frame-rate requirement used for `meets_budget`.
- `warmup_frames` defaults to `GANTRYLAB_WARMUP_FRAMES` (3); warm-up inferences run on the first frame and are excluded from latency statistics.

Real adapters require `status: "ready"`; the mock adapter accepts any non-rejected model.
The request returns immediately; a background thread launches the sandbox worker.

```json
{"id": "run_0123456789ab", "status": "queued", "events_url": "/api/v1/runs/run_0123456789ab/events",
 "status_url": "/api/v1/runs/run_0123456789ab"}
```

### `RunRecord` (`GET /api/v1/runs/{id}`, `GET /api/v1/runs` -> `{"runs": [...]}`)

```json
{
  "id": "run_0123456789ab",
  "status": "complete",
  "progress": 1.0,
  "message": "complete",
  "created_at": "...", "started_at": "...", "finished_at": "...",
  "model": {"id": "<sha256>", "sha256": "<sha256>", "name": "yolov8n", "version": 1, "format": "pt", "task": "detect",
            "gflops": 8.855, "gflops_imgsz": 640, "parameters": 3157200, "names_count": 80},
  "dataset": {"id": "ds_...", "name": "harbor sweep", "manifest_sha256": "...", "n_frames": 120, "classes": ["..."],
              "seed": 1337, "generator": {"app": "gantrylab-web", "version": "0.2.0", "renderer": "three r184"}},
  "adapter": "ultralytics",
  "mock": false,
  "seed": 0,
  "config": {"conf": 0.25, "iou": 0.7, "imgsz": 640, "max_det": 300, "device": "cpu", "class_map": {},
             "compute_profile": "auto", "budget_fps": 10.0, "warmup_frames": null},
  "resolved_class_map": {"person": null, "boat": "SHIPWRECK"},
  "unmapped_model_classes": ["person"],
  "versions": {"gantrylab": "0.1.0", "python_api": "3.12.13", "worker_torch": "2.11.0+cu128", "worker_ultralytics": "8.4.215"},
  "runtime": {"device": "cpu", "device_name": "cpu", "warnings": []},
  "warnings": ["Dataset classes with no mapped model class (recall will be 0): ['MINE']"],
  "error": null,
  "metrics_available": true
}
```

`status` is `queued`, `running`, `complete` or `failed`; `progress` is 0..1 (0.9 at the end of inference, 1.0 when metrics are written).
Runs left `queued` or `running` by a crash are marked `failed` with `error: "interrupted by service restart"` on the next start-up.
Reproducibility: `run.json` stores the config, model SHA-256, dataset manifest hash, adapter, seed and worker library versions.

### `WS /api/v1/runs/{id}/events`

Server-sent JSON frames (`RunEvent`):

```json
{"run_id": "run_...", "seq": 7, "type": "progress", "status": "running", "progress": 0.42,
 "message": "inference 56/120 frames", "ts": "2026-11-20T05:00:05Z"}
```

`type` is `status`, `progress`, `log`, `complete` or `failed`.
The socket closes after the terminal event.
For a run not tracked in memory (for example after a restart) one snapshot frame is sent and, if the run is finished, the socket closes.
Unknown runs receive `{"type": "error", "message": "run not found"}` and close code 4404.

### `GET /api/v1/runs/{id}/predictions` -> `RunPredictions`

```json
{"run_id": "run_...", "mock": false, "inference_conf_floor": 0.001,
 "frames": [{"file": "000001.png",
             "detections": [{"class_id": 8, "class_name": "boat", "bbox_xyxy": [10.0, 20.0, 90.0, 60.0], "conf": 0.81}],
             "timing": {"preprocess_ms": 0.4, "inference_ms": 15.1, "postprocess_ms": 0.5, "total_ms": 16.2}}]}
```

Class names are the model's own names; the class map is applied only when computing metrics.

### `GET /api/v1/runs/{id}/metrics` -> `RunMetrics`

Returns `409` until the run is complete.
Top-level fields:

| Field | Content |
|---|---|
| `run_id`, `mock`, `banner` | `banner` is the mock banner or `null` |
| `conf_threshold`, `iou_thresholds` | Operating threshold and the 10 COCO IoU thresholds |
| `n_frames`, `n_frames_empty_gt`, `n_predictions_total`, `classes` | Dataset-level counts |
| `overall` | `n_gt, tp, fp, fn, precision, recall, f1, map50, map50_95, n_classes_evaluated` |
| `per_class` | `{class: {support, n_pred, tp, fp, fn, precision, recall, f1, ap50, ap50_95}}` |
| `pr` | `per_class` 101-point interpolated curves, `conf_sweep` (thresholds 0.00..1.00 step 0.01 with micro P/R/F1), `best_f1` |
| `confusion_matrix` | `labels` (classes + `background`), `matrix[gt][pred]`, IoU and conf used |
| `false_positives`, `false_negatives` | Capped at `failure_cap` (200), with conditions |
| `fp_types`, `fn_types` | Counts by FP type and FN reason |
| `confused_pairs` | `[{gt_class, pred_class, count}]` sorted by count |
| `confidence_histogram` | 10 bins over [0, 1] for TP and FP predictions |
| `tp_below_conf_threshold` | Correct detections lost to the operating threshold |
| `slices`, `slice_ranking`, `sensitivity` | Breakdown by condition and object attribute |
| `latency`, `resources` | Measured timings and resource usage |
| `hardware`, `hardware_profiles` | Selected profile block and every profile block |
| `simulated` | Present only for mock runs |

Metric definitions:

- Matching is COCO style per frame and class: predictions in descending confidence take the unmatched ground truth with the highest IoU, which must be >= the threshold (inclusive).
- `precision = tp / (tp + fp)` and is `null` when there are no predictions; `recall = tp / n_gt` and is `null` without ground truth; `f1` is `null` when either is `null`.
- AP is COCO 101-point interpolation over the monotone precision envelope; AP is `null` for classes without ground truth, which are excluded from mAP.
- `map50_95` averages AP over IoU 0.50, 0.55, ..., 0.95.
- Confusion matrix: same-class matches at IoU >= 0.5 are on the diagonal; an unmatched prediction with IoU >= 0.45 to an unmatched ground truth of another class is a confusion (`[gt][pred]`); other unmatched predictions are `[background][pred]`; unmatched ground truth is `[gt][background]`.
- FP `type`: `duplicate` (a same-class ground truth with IoU >= 0.5 was already matched), `class_confusion`, `localization` (same-class IoU in [0.1, 0.5)), `background`.
- FN `reason`: `missed`, `misclassified`, `mislocalized`, `below_conf_threshold` (a same-class prediction at IoU >= 0.5 exists but below `conf`).

Slices (`SliceMetrics`): `{id, key, bucket, order, lo, hi, kind, scope, n_frames, n_gt, tp, fp, fn, recall, precision, f1, ap50, low_support}`.

| Key | Buckets |
|---|---|
| `turbidity` | clear [0, 0.1), light [0.1, 0.3), moderate [0.3, 0.6), heavy >= 0.6 |
| `ntu` | 0-1, 1-5, 5-20, >=20 |
| `lighting` | dark [0, 0.3), dim [0.3, 0.6), bright >= 0.6 |
| `current_speed_mps` | slack < 0.25, light < 0.5, moderate < 1, strong >= 1 |
| `current_dir_deg` | 8 compass sectors of 45 degrees (N, NE, ...) |
| `depth_m` | 0-5m, 5-10m, 10-20m, 20-50m, >=50m |
| `vehicle_speed_mps` | slow < 0.2, medium < 0.5, fast >= 0.5 |
| `motion_blur_px` | <1px, 1-3px, >=3px |
| other numeric keys | 4 equal-width bins over the observed range |
| string or boolean keys | one bucket per value |
| `object_size` (attribute) | COCO small < 32^2, medium < 96^2, large; area is `area_px` when given, else box area |
| `distance_m` (attribute) | <1m, 1-2m, 2-4m, 4-8m, >=8m |
| `occlusion` (attribute) | none < 0.1, partial < 0.5, heavy >= 0.5 of `occluded_fraction` (or `1 - visible_fraction`) |

- Condition slices (`kind: "condition"`, `scope: "full"`) contain whole frames, so every metric is defined.
- `object_size` uses COCO area-range semantics (ground truth outside the range and unmatched predictions outside the range are ignored), so precision and AP50 are meaningful.
- `distance_m` and `occlusion` have `scope: "recall_only"`: predictions carry no distance or occlusion, so `precision`, `f1`, `fp` and `ap50` are `null`.
- `low_support` is true when `n_gt < 5`.

`slice_ranking`: `{min_support: 5, n_eligible, n_excluded_low_support, best: [RankedSlice], worst: [RankedSlice]}`.
Only slices with `n_gt >= 5` from keys with at least two buckets are ranked, by F1 (recall for recall-only slices).
Every ranked slice reports its `n_gt` and `n_frames` so the UI never over-claims.

`sensitivity`: per ordinal numeric condition key with at least two supported buckets, the least-squares slope of recall against the bucket midpoint (`slope_per_unit`), `recall_range`, `delta_recall` and the bucket points.
This is an association in synthetic data, not a causal effect.

`latency` (`LatencyBlock`): `kind` (`measured` or `not_measured`), `n_frames`, `n_warmup_excluded`, `warmup_total_ms`, and `{n, mean, p50, p95, min, max}` for `preprocess_ms`, `inference_ms`, `postprocess_ms` and `total_ms`, plus `fps_from_mean_latency` and `wall_fps`.
Timings exclude decoding the image from disk.

`resources` (`ResourceBlock`): `peak_rss_mb` (worker process tree), `cpu_percent_mean` / `cpu_percent_max` (summed over cores), `gpu_max_memory_allocated_mb` (`torch.cuda.max_memory_allocated`), `gpu_util_mean` / `gpu_util_max` (device-wide from `nvidia-smi`), `device`, `device_name`, `notes`.

`hardware` (`HardwareBlock`): `{profile, name, kind, latency_ms_p50, fps, budget_fps_required, meets_budget, method, assumptions}`.

## Reports

### `POST /api/v1/runs/{id}/report` -> `EngineeringReport` (201)

```json
{
  "provider": "auto",
  "include_failure_examples": true,
  "user_files": {"data.yaml": "...", "hyp.yaml": "...", "inference.yaml": "..."}
}
```

- `provider`: `auto`, `anthropic`, `openai`, `ollama` or `deterministic`; defaults to `GANTRYLAB_LLM_PROVIDER` (`auto`).
  `auto` picks the first configured provider in the order Anthropic, OpenAI, Ollama, else the deterministic provider.
- `include_failure_examples` adds aggregated failure text (counts and up to 12 one-line examples); images and weights are never sent.
- `user_files` are optional YAML texts (256 KiB each) stored read-only under `data/reports/<id>/inputs/` and used as the originals for suggestions and patches.
- The run must be `complete` (`409` otherwise).

Workflow:

1. Build the evidence payload from metrics, dataset conditions, model metadata and hardware blocks; hash it (`evidence_hash`).
2. Deterministic analysis: most-missed classes, confused pairs, per-key recall spread, most-degrading condition and object attribute, threshold analysis, hardware suitability.
3. Deterministic rules engine produces `config_suggestions`.
4. The provider writes narrative JSON; it is validated against a schema with one repair retry, otherwise the deterministic narrative is used and `fallback: true` is recorded.
5. Every narrative field is checked: numbers that do not appear in the evidence cause that field to be replaced by the deterministic text, and evidence refs that do not exist are removed (`number_check.replaced` lists every replacement).
6. Structured numbers (`headline_metrics`, `best_conditions`, `worst_conditions`, section `data`) are copied from the metrics engine, never from LLM output.

### `EngineeringReport`

| Field | Content |
|---|---|
| `id`, `run_id`, `created_at`, `schema_version` | `schema_version` is `gantrylab.report/1` |
| `provider`, `provider_model` | Provider that actually wrote the narrative (`deterministic` after a fallback) |
| `fallback`, `fallback_reason` | Fallback flag and reason (never contains credentials) |
| `mock`, `banner` | Mock flag and banner |
| `evidence_hash` | SHA-256 of the canonical evidence payload |
| `number_check` | `{checked, replaced: [{field, unverified, missing_refs?}], attempts, note}` |
| `executive_summary` | `{what_was_tested, model, environments, overall, key_findings: [{text, evidence_refs}], headline_metrics}` |
| `performance_breakdown`, `environmental_sensitivity`, `failure_analysis`, `conditions_narrative`, `hardware_suitability` | `Section`: `{narrative, evidence_refs, data}` |
| `best_conditions`, `worst_conditions` | `[{slice_id, key, bucket, metric, value, n_gt, n_frames}]` |
| `recommendations` | `[{priority, action, rationale, evidence_refs}]` |
| `next_experiment` | `{environment, parameters, rationale, evidence_refs}` |
| `config_suggestions` | `[ConfigSuggestion]` |
| `disclaimers`, `user_files_provided` | Fixed caveats and the names of supplied files |

`ConfigSuggestion`:

```json
{"id": "sg-01", "file": "inference.yaml", "key": "conf", "original": 0.25, "original_source": "run_config",
 "suggested": 0.37, "reason": "The confidence sweep peaks at F1=0.351 at conf=0.37; ...", "evidence": ["pr:best_f1", "overall"],
 "expected_benefit": "...", "tradeoffs": "...", "confidence": "medium", "patchable": true, "rationale": null}
```

- `file` is `data.yaml`, `hyp.yaml` or `inference.yaml` (`patchable: true`) or an advisory target such as `camera`, `lighting`, `training_notes` or `data_collection` (`patchable: false`).
- `original_source` is `user_file`, `ultralytics_default`, `run_config` or `not_applicable`.
- `rationale` is optional LLM text; values never come from the LLM.
- Rules cover the F1-optimal confidence threshold, NMS IoU when duplicates dominate, input resolution when small-object recall lags, `hsv_v` for lighting, `hsv_s` and haze augmentation for turbidity, blur augmentation and speed for motion, `degrees` for strong current, `mixup` for occlusion, `cls` for class confusion, `data.yaml` names when dataset classes are unmapped, class balance and standoff distance.
- No suggestion claims improved weights.

Evidence ids used in `evidence_refs`: `overall`, `class:<C>`, `slice:<key>:<bucket>`, `sensitivity:<key>`, `confusion:<gt>-><pred>`, `ranking`, `fp_types`, `fn_types`, `pr:best_f1`, `threshold`, `latency`, `resources`, `hardware:<profile>`, `run:adapter`, `run:class_map`, `dataset`, `failures:false_positives`, `failures:false_negatives`, `analysis:<name>`.

### `GET /api/v1/reports/{id}` -> `EngineeringReport`

### `GET /api/v1/reports` -> `{"reports": [{id, run_id, created_at, provider, fallback, mock}]}`

### `GET /api/v1/reports/{id}/export.json`

`{"report": EngineeringReport, "evidence": <evidence payload>}` with `Content-Disposition: attachment`.

### `GET /api/v1/reports/{id}/export.html`

Self-contained HTML (inline CSS, no scripts, `@media print` rules) that can be saved as PDF from a browser.
Served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`.

### `GET /api/v1/reports/{id}/patches/{file}` -> `PatchResponse`

`file` is `data.yaml`, `hyp.yaml` or `inference.yaml`.

```json
{"report_id": "rep_...", "file": "hyp.yaml", "original_source": "user_file",
 "original": "lr0: 0.01\nhsv_v: 0.4  # brightness\n",
 "patched": "lr0: 0.01\nhsv_v: 0.6  # gantrylab sg-04\n",
 "diff": "--- a/hyp.yaml\n+++ b/hyp.yaml\n@@ ...",
 "applied_suggestions": ["sg-04"],
 "note": "Patched COPY generated from the stored original; the original upload is unchanged. ..."}
```

The stored original is read-only and never rewritten.
Top-level keys are replaced in place (comments and unrelated lines kept) or appended; the result is re-parsed to verify every suggested value.
Without a supplied original, `original_source` is `empty` and the copy contains only the suggested keys.

### `POST /api/v1/reports/{id}/ask` -> `AskResponse`

Request: `{"question": "Which condition degraded performance most?", "provider": null}` (question 1-2000 chars).

```json
{"report_id": "rep_...", "question": "...", "answer": "turbidity degraded detection the most: recall 0.912 in 'clear' (n_gt=60) versus 0.410 in 'heavy' (n_gt=58).",
 "evidence_refs": ["slice:turbidity:heavy", "slice:turbidity:clear", "sensitivity:turbidity"],
 "uncertainty": "Based on n_gt=58 ground-truth objects; slices below 5 objects are excluded. ...",
 "provider": "deterministic", "fallback": false, "fallback_reason": null, "mock": false}
```

Answers use only the stored evidence.
The deterministic provider answers which condition degraded performance most, which class failed, which classes were confused, the best condition, hardware suitability and which configuration to test next; other questions get a summary and the list of supported topics.
LLM answers must cite valid evidence ids, include an uncertainty statement and contain only evidence numbers, otherwise the deterministic answer is returned with `fallback: true`.

## Compare

### `GET /api/v1/compare?runs=a,b` -> `CompareResponse`

Both runs must be complete.

```json
{
  "runs": [{"run_id": "...", "model": {}, "dataset": {}, "adapter": "ultralytics", "mock": false, "overall": {},
            "latency_ms_p50": 16.2, "hardware": {}}],
  "comparison_type": "models",
  "overall_deltas": {"recall": {"a": 0.61, "b": 0.72, "delta": 0.11}},
  "per_class_deltas": {"MINE": {"recall": {"a": 0.5, "b": 0.6, "delta": 0.1}}},
  "slice_deltas": [{"id": "slice:turbidity:heavy", "key": "turbidity", "bucket": "heavy", "n_gt_a": 58, "n_gt_b": 58,
                    "recall": {"a": 0.41, "b": 0.55, "delta": 0.14}, "precision": {}, "f1": {}, "low_support": false}],
  "notes": ["delta = b - a. ..."]
}
```

`comparison_type` is `models` (same dataset), `environments` (same model), `models_and_environments` or `repeat`.
`delta` is `b - a` and `null` when either side is `null`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GANTRYLAB_DATA_DIR` | `backend/data` | Registry root |
| `GANTRYLAB_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Allowed browser origins |
| `GANTRYLAB_MAX_MODEL_MB` | 512 | Model upload cap |
| `GANTRYLAB_MAX_DATASET_FRAMES` / `_MAX_FRAME_MB` / `_MAX_DATASET_MB` / `_MAX_MANIFEST_MB` | 5000 / 20 / 2048 / 32 | Dataset caps |
| `GANTRYLAB_WORKER_TIMEOUT_S` | 1800 | Inference worker wall-clock limit |
| `GANTRYLAB_INSPECT_TIMEOUT_S` | 180 | Inspection worker wall-clock limit |
| `GANTRYLAB_WORKER_MEM_MB` | 8192 | Worker memory limit |
| `GANTRYLAB_MAX_CONCURRENT_RUNS` | 1 | Parallel runs |
| `GANTRYLAB_WARMUP_FRAMES` | 3 | Default warm-up inferences |
| `GANTRYLAB_LLM_PROVIDER` | `auto` | Default report provider |
| `GANTRYLAB_LLM_TIMEOUT_S` | 90 | Provider HTTP timeout |
| `ANTHROPIC_API_KEY`, `GANTRYLAB_ANTHROPIC_MODEL` | unset, `claude-sonnet-5-5` | Anthropic Messages API |
| `OPENAI_API_KEY`, `GANTRYLAB_OPENAI_MODEL` | unset, `gpt-4o-mini` | OpenAI chat completions |
| `GANTRYLAB_OLLAMA_URL`, `GANTRYLAB_OLLAMA_MODEL` | `http://127.0.0.1:11434`, `llama3.1` | Ollama (enabled when either is set) |
