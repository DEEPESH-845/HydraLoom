"""Ultralytics ``.pt`` adapter.

Runs only inside the sandbox worker.
``torch.load`` is patched (see :func:`gantrylab.sandbox.worker.install_restricted_torch_load`)
before Ultralytics is asked to load the checkpoint, so every unpickle goes through
:mod:`gantrylab.sandbox.restricted_pickle`.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from .base import AdapterConfig, Detection, FrameInput, FramePrediction, InferenceAdapter


def resolve_device(requested: str) -> str:
    import torch

    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("cuda requested but torch.cuda.is_available() is False")
    return requested


class UltralyticsPtAdapter(InferenceAdapter):
    name = "ultralytics"

    def __init__(self) -> None:
        self.model = None
        self.cfg = AdapterConfig()
        self.device = "cpu"
        self.names: dict[int, str] = {}

    def load(self, model_path: str | None, config: AdapterConfig) -> dict[str, Any]:
        import torch
        from ultralytics import YOLO

        assert model_path
        self.cfg = config
        self.device = resolve_device(config.device)
        self.model = YOLO(model_path, task=None)
        self.names = {int(k): str(v) for k, v in dict(self.model.names).items()}
        info: dict[str, Any] = {"device": self.device, "names": self.names, "warnings": []}
        if self.device == "cuda" and config.device == "auto":
            # A laptop GPU can intermittently fail to create a CUDA context ("out of memory" with the card idle).
            # With device "auto" the run falls back to the CPU instead of failing; the runtime records the device
            # that actually executed, so latency is labelled as measured on the CPU, never as GPU.
            try:
                self.model.predict(source=np.zeros((64, 64, 3), dtype=np.uint8), imgsz=64, device="cuda", verbose=False, save=False)
                torch.cuda.synchronize()
            except RuntimeError as exc:
                self.device = "cpu"
                info["device"] = "cpu"
                info["warnings"].append(f"CUDA initialisation failed ({type(exc).__name__}: {str(exc).splitlines()[0][:120]}); "
                                        "fell back to the CPU, latency is measured on the CPU")
                try:
                    torch.cuda.empty_cache()
                except RuntimeError:
                    pass
        if self.device == "cuda":
            info["device_name"] = torch.cuda.get_device_name(0)
            torch.cuda.reset_peak_memory_stats()
        else:
            info["device_name"] = "cpu"
        return info

    def predict(self, frame: FrameInput) -> FramePrediction:
        from PIL import Image

        assert self.model is not None
        rgb = np.asarray(Image.open(frame.path).convert("RGB"))
        bgr = np.ascontiguousarray(rgb[:, :, ::-1])
        t0 = time.perf_counter()
        results = self.model.predict(
            source=bgr,
            conf=self.cfg.conf_floor,
            iou=self.cfg.iou,
            imgsz=self.cfg.imgsz,
            max_det=self.cfg.max_det,
            device=self.device,
            verbose=False,
            save=False,
        )
        total = (time.perf_counter() - t0) * 1000
        r = results[0]
        dets: list[Detection] = []
        if r.boxes is not None and len(r.boxes):
            xyxy = r.boxes.xyxy.cpu().numpy()
            conf = r.boxes.conf.cpu().numpy()
            cls = r.boxes.cls.cpu().numpy().astype(int)
            for b, s, c in zip(xyxy, conf, cls):
                dets.append(Detection(int(c), self.names.get(int(c), str(int(c))), b.tolist(), float(s)))
        speed = dict(r.speed or {})
        return FramePrediction(
            dets,
            {
                "preprocess_ms": speed.get("preprocess"),
                "inference_ms": speed.get("inference"),
                "postprocess_ms": speed.get("postprocess"),
                "total_ms": total,
            },
        )

    def gpu_max_memory_mb(self) -> float | None:
        import torch

        if self.device == "cuda":
            return torch.cuda.max_memory_allocated() / (1024 * 1024)
        return None
