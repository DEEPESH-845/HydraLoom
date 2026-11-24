"""Runtime configuration read from environment variables.

Every value has a safe default so the service starts with no configuration.
Settings are resolved once per app instance (``get_settings`` is not cached globally)
so tests can point each app at its own data directory.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:  # pragma: no cover - configuration error
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return float(raw)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    cors_origins: list[str]
    max_model_mb: int
    max_dataset_frames: int
    max_frame_mb: int
    max_dataset_mb: int
    max_manifest_mb: int
    worker_timeout_s: float
    inspect_timeout_s: float
    worker_mem_mb: int
    max_concurrent_runs: int
    llm_provider: str
    llm_timeout_s: float
    warmup_frames: int
    extra: dict = field(default_factory=dict)

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def datasets_dir(self) -> Path:
        return self.data_dir / "datasets"

    @property
    def runs_dir(self) -> Path:
        return self.data_dir / "runs"

    @property
    def reports_dir(self) -> Path:
        return self.data_dir / "reports"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"

    def ensure_dirs(self) -> None:
        for d in (self.models_dir, self.datasets_dir, self.runs_dir, self.reports_dir, self.tmp_dir):
            d.mkdir(parents=True, exist_ok=True)


def load_settings(data_dir: str | Path | None = None) -> Settings:
    data = Path(data_dir or os.environ.get("GANTRYLAB_DATA_DIR") or (BACKEND_ROOT / "data")).resolve()
    origins_raw = os.environ.get("GANTRYLAB_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
    origins = [o.strip() for o in origins_raw.split(",") if o.strip()]
    return Settings(
        data_dir=data,
        cors_origins=origins,
        max_model_mb=_env_int("GANTRYLAB_MAX_MODEL_MB", 512),
        max_dataset_frames=_env_int("GANTRYLAB_MAX_DATASET_FRAMES", 5000),
        max_frame_mb=_env_int("GANTRYLAB_MAX_FRAME_MB", 20),
        max_dataset_mb=_env_int("GANTRYLAB_MAX_DATASET_MB", 2048),
        max_manifest_mb=_env_int("GANTRYLAB_MAX_MANIFEST_MB", 32),
        worker_timeout_s=_env_float("GANTRYLAB_WORKER_TIMEOUT_S", 1800.0),
        inspect_timeout_s=_env_float("GANTRYLAB_INSPECT_TIMEOUT_S", 180.0),
        worker_mem_mb=_env_int("GANTRYLAB_WORKER_MEM_MB", 8192),
        max_concurrent_runs=max(1, _env_int("GANTRYLAB_MAX_CONCURRENT_RUNS", 1)),
        llm_provider=os.environ.get("GANTRYLAB_LLM_PROVIDER", "auto").strip().lower() or "auto",
        llm_timeout_s=_env_float("GANTRYLAB_LLM_TIMEOUT_S", 90.0),
        warmup_frames=max(0, _env_int("GANTRYLAB_WARMUP_FRAMES", 3)),
    )
