"""Inference adapters.

Only ``MockAdapter`` is importable without torch / onnxruntime.
Real adapters are imported lazily by the sandbox worker.
"""

from .base import AdapterConfig, Detection, FrameInput, FramePrediction, InferenceAdapter
from .mock_adapter import MOCK_BANNER, MockAdapter

__all__ = [
    "AdapterConfig",
    "Detection",
    "FrameInput",
    "FramePrediction",
    "InferenceAdapter",
    "MOCK_BANNER",
    "MockAdapter",
]
