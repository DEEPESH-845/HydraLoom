"""Inference adapter interface shared by the sandbox worker and the mock path."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class FrameInput:
    file: str
    path: str
    width: int
    height: int
    # Ground truth is only provided to the MockAdapter. Real adapters never receive it.
    annotations: list[dict] | None = None
    conditions: dict | None = None


@dataclass
class Detection:
    class_id: int
    class_name: str
    bbox_xyxy: list[float]
    conf: float

    def to_dict(self) -> dict:
        return {
            "class_id": self.class_id,
            "class_name": self.class_name,
            "bbox_xyxy": [round(float(v), 2) for v in self.bbox_xyxy],
            "conf": round(float(self.conf), 5),
        }


@dataclass
class FramePrediction:
    detections: list[Detection]
    timing_ms: dict[str, float | None] = field(default_factory=dict)


@dataclass
class AdapterConfig:
    conf_floor: float = 0.001
    iou: float = 0.7
    imgsz: int = 640
    max_det: int = 300
    device: str = "cpu"


class InferenceAdapter(ABC):
    """Loads one model and predicts on frames.

    ``UltralyticsPtAdapter`` and ``OnnxAdapter`` run only inside the sandbox worker.
    ``MockAdapter`` runs in the API process because it never loads a model file.
    """

    name: str = "base"
    mock: bool = False

    @abstractmethod
    def load(self, model_path: str | None, config: AdapterConfig) -> dict[str, Any]:
        """Load the model. Returns runtime info (device name, class names, versions)."""

    @abstractmethod
    def predict(self, frame: FrameInput) -> FramePrediction:
        """Run inference on one frame."""

    def gpu_max_memory_mb(self) -> float | None:
        return None

    def close(self) -> None:  # pragma: no cover - default no-op
        return None
