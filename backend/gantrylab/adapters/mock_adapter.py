"""Deterministic mock adapter derived from ground truth with seeded noise.

Used for CI and UI development. It never loads the model file.
Every run produced with it is flagged ``mock: true`` and every report states
"MOCK ADAPTER - not a real model evaluation".
Its latency is not measured (there is no real inference), so timing fields are ``None``.
"""

from __future__ import annotations

import hashlib
from typing import Any

import numpy as np

from .base import AdapterConfig, Detection, FrameInput, FramePrediction, InferenceAdapter

MOCK_BANNER = "MOCK ADAPTER - not a real model evaluation"


class MockAdapter(InferenceAdapter):
    name = "mock"
    mock = True

    def __init__(self, classes: list[str], seed: int = 0) -> None:
        self.classes = list(classes)
        self.seed = int(seed)
        self.cfg = AdapterConfig()

    def load(self, model_path: str | None, config: AdapterConfig) -> dict[str, Any]:
        self.cfg = config
        return {
            "device": "none",
            "device_name": "mock (no inference)",
            "names": {i: c for i, c in enumerate(self.classes)},
            "warnings": [MOCK_BANNER],
        }

    def _rng(self, file: str) -> np.random.Generator:
        digest = hashlib.sha256(f"{self.seed}:{file}".encode()).digest()
        return np.random.default_rng(int.from_bytes(digest[:8], "little"))

    def predict(self, frame: FrameInput) -> FramePrediction:
        rng = self._rng(frame.file)
        cond = frame.conditions or {}
        turb = float(cond.get("turbidity", 0.0) or 0.0)
        light = float(cond.get("lighting", 1.0) if cond.get("lighting") is not None else 1.0)
        blur = float(cond.get("motion_blur_px", 0.0) or 0.0)
        dets: list[Detection] = []
        for ann in frame.annotations or []:
            x, y, w, h = ann["bbox_xywh"]
            vis = float(ann.get("visible_fraction", 1.0) if ann.get("visible_fraction") is not None else 1.0)
            small_pen = 0.25 if w * h < 32 * 32 else (0.08 if w * h < 96 * 96 else 0.0)
            p = 0.98 - 0.5 * (1.0 - vis) - 0.45 * turb - 0.2 * (1.0 - light) - 0.02 * blur - small_pen
            p = float(np.clip(p, 0.03, 0.98))
            if rng.random() >= p:
                continue
            jit = 0.02 + 0.08 * turb + 0.01 * blur
            nx = x + rng.normal(0, jit) * w
            ny = y + rng.normal(0, jit) * h
            nw = max(1.0, w * (1 + rng.normal(0, jit)))
            nh = max(1.0, h * (1 + rng.normal(0, jit)))
            x1 = float(np.clip(nx, 0, frame.width))
            y1 = float(np.clip(ny, 0, frame.height))
            x2 = float(np.clip(nx + nw, 0, frame.width))
            y2 = float(np.clip(ny + nh, 0, frame.height))
            if x2 - x1 < 1 or y2 - y1 < 1:
                continue
            cls_name = ann["class_name"]
            if len(self.classes) > 1 and rng.random() < 0.04 + 0.1 * turb:
                others = [c for c in self.classes if c != cls_name]
                cls_name = others[int(rng.integers(0, len(others)))]
            conf = float(np.clip(rng.normal(0.35 + 0.6 * p, 0.12), 0.01, 0.995))
            cid = self.classes.index(cls_name) if cls_name in self.classes else -1
            dets.append(Detection(cid, cls_name, [x1, y1, x2, y2], conf))
        n_fp = int(rng.poisson(0.15 + 1.2 * turb + 0.3 * (1.0 - light)))
        for _ in range(n_fp):
            if not self.classes:
                break
            w = float(rng.uniform(12, max(13.0, frame.width / 5)))
            h = float(rng.uniform(12, max(13.0, frame.height / 5)))
            x1 = float(rng.uniform(0, max(1.0, frame.width - w)))
            y1 = float(rng.uniform(0, max(1.0, frame.height - h)))
            cid = int(rng.integers(0, len(self.classes)))
            conf = float(np.clip(rng.beta(2, 5), 0.01, 0.95))
            dets.append(Detection(cid, self.classes[cid], [x1, y1, x1 + w, y1 + h], conf))
        dets = [d for d in dets if d.conf >= self.cfg.conf_floor]
        dets.sort(key=lambda d: -d.conf)
        return FramePrediction(
            dets[: self.cfg.max_det],
            {"preprocess_ms": None, "inference_ms": None, "postprocess_ms": None, "total_ms": None},
        )
