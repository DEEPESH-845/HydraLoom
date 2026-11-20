"""Evaluation runs: background execution, progress events, persisted results."""

from __future__ import annotations

import logging
import platform
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .. import __version__
from ..adapters import MOCK_BANNER, AdapterConfig, FrameInput, MockAdapter
from ..config import Settings
from ..hardware import hardware_blocks, profile_ids
from ..metrics.engine import evaluate, xywh_to_xyxy
from ..metrics.latency import latency_block
from ..sandbox.runner import SandboxLimits, run_sandboxed
from ..schemas import RunConfig, RunCreate, RunEvent, RunMetrics, RunRecord
from ..storage import is_safe_id, lock_for, new_id, read_json, utcnow, write_json_atomic
from .datasets import DatasetStore
from .models import ModelRegistry

log = logging.getLogger("gantrylab.runs")

INFERENCE_CONF_FLOOR = 0.001
TERMINAL = ("complete", "failed")


def resolve_class_map(model_names: list[str], dataset_classes: list[str],
                      user_map: dict[str, str | None]) -> tuple[dict[str, str | None], list[str], list[str]]:
    """Return (map, unmapped model classes, dataset classes without any model class)."""
    unknown = sorted(set(user_map) - set(model_names))
    if unknown:
        raise HTTPException(status_code=400, detail=f"class_map keys are not model classes: {unknown[:20]}")
    bad = sorted({v for v in user_map.values() if v is not None and v not in dataset_classes})
    if bad:
        raise HTTPException(status_code=400, detail=f"class_map values are not dataset classes: {bad[:20]}")
    lower = {c.lower(): c for c in dataset_classes}
    out: dict[str, str | None] = {}
    for n in model_names:
        out[n] = user_map[n] if n in user_map else lower.get(n.lower())
    unmapped = sorted(n for n, v in out.items() if v is None)
    covered = {v for v in out.values() if v is not None}
    uncovered = [c for c in dataset_classes if c not in covered]
    return out, unmapped, uncovered


class RunManager:
    def __init__(self, settings: Settings, models: ModelRegistry, datasets: DatasetStore) -> None:
        self.settings = settings
        self.models = models
        self.datasets = datasets
        self.pool = ThreadPoolExecutor(max_workers=settings.max_concurrent_runs, thread_name_prefix="gl-run")
        self.events: dict[str, list[dict]] = {}
        self.cond = threading.Condition()
        self.futures: dict[str, Any] = {}

    # -- storage -------------------------------------------------------------

    def _dir(self, run_id: str) -> Path:
        if not is_safe_id(run_id) or not run_id.startswith("run_"):
            raise HTTPException(status_code=404, detail="run not found")
        d = self.settings.runs_dir / run_id
        if not (d / "run.json").exists():
            raise HTTPException(status_code=404, detail="run not found")
        return d

    def get_raw(self, run_id: str) -> dict:
        return read_json(self._dir(run_id) / "run.json")

    def get(self, run_id: str) -> RunRecord:
        return RunRecord.model_validate(self.get_raw(run_id))

    def list(self) -> list[RunRecord]:
        out = []
        if self.settings.runs_dir.exists():
            for d in self.settings.runs_dir.iterdir():
                p = d / "run.json"
                if p.exists():
                    out.append(RunRecord.model_validate(read_json(p)))
        out.sort(key=lambda r: (r.created_at, r.id), reverse=True)
        return out

    def metrics(self, run_id: str) -> dict:
        p = self._dir(run_id) / "metrics.json"
        if not p.exists():
            raise HTTPException(status_code=409, detail="metrics not available (run not complete)")
        return read_json(p)

    def predictions(self, run_id: str) -> dict:
        p = self._dir(run_id) / "predictions.json"
        if not p.exists():
            raise HTTPException(status_code=409, detail="predictions not available (run not complete)")
        return read_json(p)

    def _update(self, run_id: str, event_type: str | None = None, **fields: Any) -> dict:
        with lock_for(f"run:{run_id}"):
            path = self.settings.runs_dir / run_id / "run.json"
            raw = read_json(path)
            raw.update(fields)
            write_json_atomic(path, raw)
        if event_type:
            self._emit(run_id, event_type, raw)
        return raw

    def _emit(self, run_id: str, etype: str, raw: dict) -> None:
        with self.cond:
            lst = self.events.setdefault(run_id, [])
            ev = RunEvent(run_id=run_id, seq=len(lst), type=etype, status=raw["status"],
                          progress=float(raw["progress"]), message=raw["message"], ts=utcnow())
            lst.append(ev.model_dump())
            self.cond.notify_all()

    def events_since(self, run_id: str, seq: int) -> list[dict]:
        with self.cond:
            return list(self.events.get(run_id, [])[seq:])

    # -- create --------------------------------------------------------------

    def create(self, body: RunCreate) -> RunRecord:
        model = self.models.get_raw(body.model_id)
        ds = self.datasets.get(body.dataset_id)
        mock = body.adapter == "mock"
        if model["status"] == "rejected":
            raise HTTPException(status_code=409, detail=f"model is rejected: {model.get('status_reason')}")
        if not mock and model["status"] != "ready":
            raise HTTPException(status_code=409, detail=f"model is {model['status']}; wait for inspection to finish")
        if body.config.compute_profile not in profile_ids():
            raise HTTPException(status_code=400, detail=f"unknown compute_profile; choose one of {sorted(profile_ids())}")
        if mock:
            model_names = list(ds.classes)
            adapter = "mock"
        else:
            names = (model.get("inspection") or {}).get("names") or {}
            model_names = [names[k] for k in sorted(names, key=lambda x: int(x))]
            adapter = "ultralytics" if model["format"] == "pt" else "onnx"
        cmap, unmapped, uncovered = resolve_class_map(model_names, ds.classes, body.config.class_map)
        warnings = []
        if mock:
            warnings.append(MOCK_BANNER)
        if not any(v is not None for v in cmap.values()):
            warnings.append("No model class maps to any dataset class; every ground truth object will be a miss. "
                            "Provide config.class_map.")
        if uncovered:
            warnings.append(f"Dataset classes with no mapped model class (recall will be 0): {uncovered}")
        run_id = new_id("run")
        insp = model.get("inspection") or {}
        raw = {
            "id": run_id,
            "status": "queued",
            "progress": 0.0,
            "message": "queued",
            "created_at": utcnow(),
            "started_at": None,
            "finished_at": None,
            "model": {"id": model["id"], "sha256": model["sha256"], "name": model["name"], "version": model["version"],
                      "format": model["format"], "task": insp.get("task"), "gflops": insp.get("gflops"),
                      "gflops_imgsz": insp.get("gflops_imgsz"), "parameters": insp.get("parameters"),
                      "names_count": len(model_names)},
            "dataset": {"id": ds.id, "name": ds.name, "manifest_sha256": ds.manifest_sha256, "n_frames": ds.n_frames,
                        "classes": ds.classes, "seed": ds.seed, "generator": ds.generator.model_dump()},
            "adapter": adapter,
            "mock": mock,
            "seed": body.seed,
            "config": body.config.model_dump(),
            "resolved_class_map": cmap,
            "unmapped_model_classes": unmapped,
            "versions": {"gantrylab": __version__, "python_api": platform.python_version()},
            "runtime": {},
            "warnings": warnings,
            "error": None,
            "metrics_available": False,
        }
        d = self.settings.runs_dir / run_id
        d.mkdir(parents=True)
        write_json_atomic(d / "run.json", raw)
        self._emit(run_id, "status", raw)
        self.futures[run_id] = self.pool.submit(self._execute, run_id)
        return RunRecord.model_validate(raw)

    # -- execute -------------------------------------------------------------

    def _execute(self, run_id: str) -> None:
        try:
            self._execute_inner(run_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("run %s failed", run_id)
            msg = f"{type(exc).__name__}: {exc}" if not isinstance(exc, HTTPException) else str(exc.detail)
            self._update(run_id, "failed", status="failed", message="failed", error=msg[:4000], finished_at=utcnow())

    def _execute_inner(self, run_id: str) -> None:
        raw = self._update(run_id, "status", status="running", message="starting", started_at=utcnow(), progress=0.0)
        cfg = RunConfig.model_validate(raw["config"])
        manifest = self.datasets.manifest(raw["dataset"]["id"])
        classes = manifest["classes"]
        frames = manifest["frames"]
        images_dir = self.settings.datasets_dir / raw["dataset"]["id"] / "images"
        warmup_n = cfg.warmup_frames if cfg.warmup_frames is not None else self.settings.warmup_frames
        frame_results: list[dict | None] = [None] * len(frames)
        warmups: list[dict] = []
        runtime: dict[str, Any] = {}
        versions = dict(raw["versions"])
        resources: dict[str, Any] = {"kind": "not_measured", "peak_rss_mb": None, "cpu_percent_mean": None,
                                     "cpu_percent_max": None, "gpu_max_memory_allocated_mb": None,
                                     "gpu_util_mean": None, "gpu_util_max": None, "device": None,
                                     "device_name": None, "notes": []}
        wall_s: float | None = None
        last_emit = [0.0]

        def progress(done: int) -> None:
            now = time.perf_counter()
            if now - last_emit[0] > 0.25 or done == len(frames):
                last_emit[0] = now
                self._update(run_id, "progress", progress=round(0.9 * done / max(1, len(frames)), 4),
                             message=f"inference {done}/{len(frames)} frames")

        if raw["mock"]:
            adapter = MockAdapter(classes, seed=raw["seed"])
            runtime = adapter.load(None, AdapterConfig(conf_floor=INFERENCE_CONF_FLOOR, iou=cfg.iou,
                                                       imgsz=cfg.imgsz, max_det=cfg.max_det, device="cpu"))
            for i, fr in enumerate(frames):
                fi = FrameInput(file=fr["file"], path=str(images_dir / fr["file"]), width=fr["width"],
                                height=fr["height"], annotations=fr.get("annotations", []),
                                conditions=fr.get("conditions", {}))
                pred = adapter.predict(fi)
                frame_results[i] = {"file": fr["file"], "detections": [d.to_dict() for d in pred.detections],
                                    "timing": pred.timing_ms}
                progress(i + 1)
            resources["notes"].append(MOCK_BANNER)
            resources["device"] = "none"
            resources["device_name"] = runtime.get("device_name")
        else:
            model_raw = self.models.get_raw(raw["model"]["id"])
            job = {
                "model_path": str(self.models.original_path(model_raw)),
                "adapter": raw["adapter"],
                "config": {"conf_floor": INFERENCE_CONF_FLOOR, "iou": cfg.iou, "imgsz": cfg.imgsz,
                           "max_det": cfg.max_det, "device": cfg.device},
                "frames": [{"file": f["file"], "path": str(images_dir / f["file"]), "width": f["width"],
                            "height": f["height"]} for f in frames],
                "warmup": warmup_n,
            }
            done = [0]

            def on_message(msg: dict) -> None:
                t = msg.get("type")
                if t == "frame":
                    i = int(msg["i"])
                    frame_results[i] = {"file": msg["file"], "detections": msg.get("detections", []),
                                        "timing": msg.get("timing", {})}
                    done[0] += 1
                    progress(done[0])
                elif t == "warmup":
                    warmups.append(msg.get("timing", {}))
                    self._update(run_id, "log", message=f"warm-up {len(warmups)}/{warmup_n}")
                elif t == "env":
                    runtime.update(msg.get("runtime", {}))
                    versions.update({f"worker_{k}": v for k, v in (msg.get("versions") or {}).items()})
                    self._update(run_id, "log", message=f"model loaded on {runtime.get('device_name')}")

            self._update(run_id, "log", message="launching sandbox worker")
            res = run_sandboxed(
                "infer", job,
                SandboxLimits(timeout_s=self.settings.worker_timeout_s, memory_mb=self.settings.worker_mem_mb),
                tmp_root=self.settings.tmp_dir, on_message=on_message, sample_gpu=cfg.device in ("cuda", "auto"),
            )
            if not res.ok:
                raise RuntimeError(f"sandbox worker failed: {res.error}")
            result = res.result or {}
            runtime.update(result.get("runtime") or {})
            wall_s = result.get("wall_s")
            dev = runtime.get("device")
            resources = {
                "kind": "measured",
                "peak_rss_mb": res.peak_rss_mb,
                "cpu_percent_mean": res.cpu_percent_mean,
                "cpu_percent_max": res.cpu_percent_max,
                "gpu_max_memory_allocated_mb": result.get("gpu_max_memory_allocated_mb"),
                "gpu_util_mean": res.gpu_util_mean if dev == "cuda" else None,
                "gpu_util_max": res.gpu_util_max if dev == "cuda" else None,
                "device": dev,
                "device_name": runtime.get("device_name"),
                "notes": [
                    "peak_rss_mb sums the worker process tree (includes model load and warm-up).",
                    "cpu_percent is summed over cores (100 = one full core), sampled every 0.2 s.",
                    "gpu_util is device-wide from nvidia-smi (other processes included).",
                    f"sandbox limits: {res.limits}",
                ],
            }
            if any(r is None for r in frame_results):
                raise RuntimeError("worker returned fewer frames than requested")

        self._update(run_id, "progress", progress=0.92, message="computing metrics")
        cmap = raw["resolved_class_map"]
        eval_frames = []
        for fr, res_fr in zip(frames, frame_results):
            assert res_fr is not None
            gts = [{"class": a["class_name"], "bbox": xywh_to_xyxy(a["bbox_xywh"]),
                    "attrs": {k: a.get(k) for k in ("object_id", "visible_fraction", "occluded_fraction", "truncated",
                                                     "distance_m", "area_px")}} for a in fr.get("annotations", [])]
            preds = []
            for det in res_fr["detections"]:
                mapped = cmap.get(det["class_name"])
                if mapped is None:
                    continue
                preds.append({"class": mapped, "bbox": det["bbox_xyxy"], "conf": det["conf"]})
            eval_frames.append({"file": fr["file"], "width": fr["width"], "height": fr["height"],
                                "conditions": fr.get("conditions", {}), "gt": gts, "preds": preds})
        m = evaluate(eval_frames, classes, cfg.conf)
        lat = latency_block([r["timing"] for r in frame_results if r], warmups, wall_s, raw["mock"])
        blocks = hardware_blocks(
            executed_device=None if raw["mock"] else runtime.get("device"),
            measured_p50_ms=lat["total_ms"]["p50"],
            budget_fps=cfg.budget_fps,
            gflops=raw["model"].get("gflops"),
            gflops_imgsz=raw["model"].get("gflops_imgsz"),
            imgsz=cfg.imgsz,
            mock=raw["mock"],
        )
        requested = cfg.compute_profile
        if requested == "auto":
            requested = "host-gpu" if runtime.get("device") == "cuda" else "host-cpu"
        hw = next(b for b in blocks if b.profile == requested)
        warnings = list(raw["warnings"])
        if requested.startswith("host-") and not raw["mock"]:
            executed = "host-gpu" if runtime.get("device") == "cuda" else "host-cpu"
            if executed != requested:
                warnings.append(f"compute_profile {requested} requested but the run executed on {executed}")
        warnings.extend(runtime.get("warnings") or [])
        metrics = {
            "run_id": run_id,
            "mock": raw["mock"],
            "banner": MOCK_BANNER if raw["mock"] else None,
            "classes": classes,
            **m,
            "latency": lat,
            "resources": resources,
            "hardware": hw.model_dump(),
            "hardware_profiles": [b.model_dump() for b in blocks],
            "simulated": {"note": MOCK_BANNER} if raw["mock"] else {},
        }
        validated = RunMetrics.model_validate(metrics).model_dump(mode="json")
        d = self.settings.runs_dir / run_id
        write_json_atomic(d / "predictions.json", {"run_id": run_id, "mock": raw["mock"],
                                                   "inference_conf_floor": INFERENCE_CONF_FLOOR,
                                                   "frames": frame_results})
        write_json_atomic(d / "metrics.json", validated)
        runtime_store = {k: v for k, v in runtime.items() if k != "names"}
        self._update(run_id, "complete", status="complete", progress=1.0, message="complete", finished_at=utcnow(),
                     metrics_available=True, runtime=runtime_store, versions=versions,
                     warnings=list(dict.fromkeys(warnings)))

    # -- lifecycle -----------------------------------------------------------

    def recover(self) -> None:
        """Mark runs interrupted by a restart as failed (their worker process is gone)."""
        if not self.settings.runs_dir.exists():
            return
        for d in self.settings.runs_dir.iterdir():
            p = d / "run.json"
            if p.exists():
                raw = read_json(p)
                if raw.get("status") in ("queued", "running"):
                    raw.update(status="failed", message="failed", error="interrupted by service restart",
                               finished_at=utcnow())
                    write_json_atomic(p, raw)

    def wait(self, run_id: str, timeout: float | None = None) -> RunRecord:
        fut = self.futures.get(run_id)
        if fut is not None:
            fut.result(timeout=timeout)
        return self.get(run_id)

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)
