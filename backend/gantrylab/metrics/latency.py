"""Latency statistics over per-frame timings (warm-up frames are never included)."""

from __future__ import annotations

from typing import Any

import numpy as np


def stat(values: list[float | None]) -> dict[str, Any]:
    v = np.array([x for x in values if x is not None], dtype=np.float64)
    if v.size == 0:
        return {"n": 0, "mean": None, "p50": None, "p95": None, "min": None, "max": None}
    return {
        "n": int(v.size),
        "mean": float(v.mean()),
        "p50": float(np.percentile(v, 50)),
        "p95": float(np.percentile(v, 95)),
        "min": float(v.min()),
        "max": float(v.max()),
    }


def latency_block(timings: list[dict], warmup: list[dict], wall_s: float | None, mock: bool) -> dict[str, Any]:
    keys = ("preprocess_ms", "inference_ms", "postprocess_ms", "total_ms")
    out: dict[str, Any] = {k: stat([t.get(k) for t in timings]) for k in keys}
    total = out["total_ms"]
    measured = not mock and total["n"] > 0
    fps_lat = 1000.0 / total["mean"] if measured and total["mean"] else None
    wall_fps = len(timings) / wall_s if measured and wall_s and wall_s > 0 else None
    return {
        "kind": "measured" if measured else "not_measured",
        "n_frames": len(timings),
        "n_warmup_excluded": len(warmup),
        "warmup_total_ms": [w.get("total_ms") for w in warmup],
        **out,
        "fps_from_mean_latency": fps_lat,
        "wall_fps": wall_fps,
        "note": (
            "MOCK ADAPTER - no inference was executed, latency is not measured."
            if mock
            else "Per-frame timings exclude image decode from disk. total_ms wraps the adapter call; "
            "pre/inference/post come from the adapter. Warm-up frames are excluded."
        ),
    }
