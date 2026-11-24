"""ONNX Runtime adapter for Ultralytics YOLOv8-style detection exports.

Runs only inside the sandbox worker.
Pre-processing (letterbox), output decoding and NMS are implemented in numpy.
"""

from __future__ import annotations

import ast
import time
from typing import Any

import numpy as np

from .base import AdapterConfig, Detection, FrameInput, FramePrediction, InferenceAdapter
from .nms import decode_yolov8, letterbox


def parse_names(raw: str | None) -> dict[int, str]:
    """Parse the Ultralytics ``names`` metadata string with ``ast.literal_eval`` (no code execution)."""
    if not raw:
        return {}
    try:
        val = ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return {}
    if isinstance(val, dict):
        return {int(k): str(v) for k, v in val.items()}
    if isinstance(val, (list, tuple)):
        return {i: str(v) for i, v in enumerate(val)}
    return {}


class OnnxAdapter(InferenceAdapter):
    name = "onnx"

    def __init__(self) -> None:
        self.session = None
        self.names: dict[int, str] = {}
        self.cfg = AdapterConfig()
        self.input_name = ""
        self.input_size = 640

    def load(self, model_path: str | None, config: AdapterConfig) -> dict[str, Any]:
        import onnxruntime as ort

        assert model_path
        self.cfg = config
        available = ort.get_available_providers()
        providers = ["CPUExecutionProvider"]
        warnings: list[str] = []
        if config.device in ("cuda", "auto") and "CUDAExecutionProvider" in available:
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        elif config.device == "cuda":
            warnings.append("cuda requested but this onnxruntime build has no CUDAExecutionProvider; ran on CPU")
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(model_path, sess_options=opts, providers=providers)
        meta = self.session.get_modelmeta().custom_metadata_map or {}
        self.names = parse_names(meta.get("names"))
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        shape = inp.shape
        fixed = [d for d in shape[2:] if isinstance(d, int)]
        self.input_size = int(fixed[0]) if fixed else int(config.imgsz)
        if fixed and int(config.imgsz) != self.input_size:
            warnings.append(f"model has fixed input {self.input_size}; requested imgsz {config.imgsz} ignored")
        used = self.session.get_providers()[0]
        return {
            "device": "cuda" if used == "CUDAExecutionProvider" else "cpu",
            "device_name": used,
            "names": self.names,
            "input_size": self.input_size,
            "warnings": warnings,
            "onnxruntime": ort.__version__,
        }

    def predict(self, frame: FrameInput) -> FramePrediction:
        from PIL import Image

        assert self.session is not None
        img = np.asarray(Image.open(frame.path).convert("RGB"))
        t0 = time.perf_counter()
        canvas, gain, (px, py) = letterbox(img, self.input_size)
        x = canvas.astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        x = np.ascontiguousarray(x)
        t1 = time.perf_counter()
        out = self.session.run(None, {self.input_name: x})[0]
        t2 = time.perf_counter()
        boxes, scores, cls = decode_yolov8(out, self.cfg.conf_floor, self.cfg.iou, self.cfg.max_det)
        h, w = img.shape[:2]
        dets: list[Detection] = []
        for b, s, c in zip(boxes, scores, cls):
            x1 = float(np.clip((b[0] - px) / gain, 0, w))
            y1 = float(np.clip((b[1] - py) / gain, 0, h))
            x2 = float(np.clip((b[2] - px) / gain, 0, w))
            y2 = float(np.clip((b[3] - py) / gain, 0, h))
            dets.append(Detection(int(c), self.names.get(int(c), str(int(c))), [x1, y1, x2, y2], float(s)))
        t3 = time.perf_counter()
        return FramePrediction(
            dets,
            {
                "preprocess_ms": (t1 - t0) * 1000,
                "inference_ms": (t2 - t1) * 1000,
                "postprocess_ms": (t3 - t2) * 1000,
                "total_ms": (t3 - t0) * 1000,
            },
        )
