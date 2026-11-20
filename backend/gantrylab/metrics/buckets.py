"""Bucketing rules for condition and annotation slices.

Every bucket has a stable label, an order (for ordinal sensitivity analysis) and numeric bounds.
Bounds are half-open ``[lo, hi)`` except the last bucket which is closed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Bucket:
    label: str
    order: int
    lo: float | None = None
    hi: float | None = None

    @property
    def midpoint(self) -> float | None:
        if self.lo is None or self.hi is None or math.isinf(self.hi):
            return self.lo
        return (self.lo + self.hi) / 2


# Numeric condition keys: list of (lo, hi, label) edges.
NUMERIC_EDGES: dict[str, list[tuple[float, float, str]]] = {
    "turbidity": [(0.0, 0.1, "clear"), (0.1, 0.3, "light"), (0.3, 0.6, "moderate"), (0.6, math.inf, "heavy")],
    "ntu": [(0.0, 1.0, "0-1"), (1.0, 5.0, "1-5"), (5.0, 20.0, "5-20"), (20.0, math.inf, ">=20")],
    "lighting": [(0.0, 0.3, "dark"), (0.3, 0.6, "dim"), (0.6, math.inf, "bright")],
    "current_speed_mps": [(0.0, 0.25, "slack"), (0.25, 0.5, "light"), (0.5, 1.0, "moderate"), (1.0, math.inf, "strong")],
    "depth_m": [(0.0, 5.0, "0-5m"), (5.0, 10.0, "5-10m"), (10.0, 20.0, "10-20m"), (20.0, 50.0, "20-50m"),
                (50.0, math.inf, ">=50m")],
    "vehicle_speed_mps": [(0.0, 0.2, "slow"), (0.2, 0.5, "medium"), (0.5, math.inf, "fast")],
    "motion_blur_px": [(0.0, 1.0, "<1px"), (1.0, 3.0, "1-3px"), (3.0, math.inf, ">=3px")],
}
SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

DISTANCE_EDGES = [(0.0, 1.0, "<1m"), (1.0, 2.0, "1-2m"), (2.0, 4.0, "2-4m"), (4.0, 8.0, "4-8m"), (8.0, math.inf, ">=8m")]
OCCLUSION_EDGES = [(0.0, 0.1, "none"), (0.1, 0.5, "partial"), (0.5, math.inf, "heavy")]
SIZE_EDGES = [(0.0, 32.0**2, "small"), (32.0**2, 96.0**2, "medium"), (96.0**2, math.inf, "large")]


def bucket_from_edges(value: float, edges: list[tuple[float, float, str]]) -> Bucket | None:
    if value is None or not isinstance(value, (int, float)) or math.isnan(float(value)):
        return None
    v = float(value)
    for i, (lo, hi, label) in enumerate(edges):
        last = i == len(edges) - 1
        if (v >= lo and v < hi) or (last and v >= lo):
            return Bucket(label, i, lo, hi)
    if v < edges[0][0]:
        lo, hi, label = edges[0]
        return Bucket(label, 0, lo, hi)
    return None


def direction_sector(deg: float) -> Bucket | None:
    if deg is None or not isinstance(deg, (int, float)):
        return None
    d = float(deg) % 360.0
    idx = int(((d + 22.5) % 360) // 45)
    lo = (idx * 45 - 22.5) % 360
    return Bucket(SECTORS[idx], idx, lo, lo + 45)


def condition_bucket(key: str, value: Any, dynamic_edges: dict[str, list] | None = None) -> Bucket | None:
    """Bucket one frame condition value. Strings and booleans are categorical."""
    if value is None:
        return None
    if isinstance(value, bool):
        return Bucket(str(value).lower(), int(value))
    if isinstance(value, str):
        return Bucket(value, 0)
    if key == "current_dir_deg":
        return direction_sector(value)
    if key in NUMERIC_EDGES:
        return bucket_from_edges(value, NUMERIC_EDGES[key])
    if dynamic_edges and key in dynamic_edges:
        return bucket_from_edges(value, dynamic_edges[key])
    return None


def dynamic_numeric_edges(values: list[float], n_bins: int = 4) -> list[tuple[float, float, str]]:
    """Equal-width bins over the observed range for unknown numeric condition keys."""
    vals = [float(v) for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if not vals:
        return []
    lo, hi = min(vals), max(vals)
    if hi <= lo:
        return [(lo, math.inf, f"{lo:g}")]
    step = (hi - lo) / n_bins
    edges = []
    for i in range(n_bins):
        a = lo + i * step
        b = lo + (i + 1) * step if i < n_bins - 1 else math.inf
        label = f"{a:.3g}-{b:.3g}" if not math.isinf(b) else f">={a:.3g}"
        edges.append((a, b, label))
    return edges


def occlusion_value(attrs: dict) -> float | None:
    occ = attrs.get("occluded_fraction")
    if isinstance(occ, (int, float)):
        return float(occ)
    vis = attrs.get("visible_fraction")
    if isinstance(vis, (int, float)):
        return 1.0 - float(vis)
    return None
