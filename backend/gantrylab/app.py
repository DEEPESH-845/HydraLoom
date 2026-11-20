"""FastAPI application factory.

Run: ``cd backend && .venv/Scripts/python -m uvicorn gantrylab.app:app --port 8000``
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import Settings, load_settings
from .reports.service import ReportService
from .services.datasets import DatasetStore
from .services.models import Inspector, ModelRegistry
from .services.runs import RunManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@dataclass
class AppState:
    settings: Settings
    models: ModelRegistry
    datasets: DatasetStore
    runs: RunManager
    reports: ReportService


def create_app(data_dir: str | Path | None = None, inspector: Inspector | None = None) -> FastAPI:
    settings = load_settings(data_dir)
    settings.ensure_dirs()
    models = ModelRegistry(settings, inspector=inspector)
    datasets = DatasetStore(settings)
    runs = RunManager(settings, models, datasets)
    reports = ReportService(settings, runs, models, datasets)
    state = AppState(settings, models, datasets, runs, reports)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        runs.recover()
        models.resume_pending()
        yield
        runs.shutdown()
        models.shutdown()

    app = FastAPI(
        title="GANTRYLAB model evaluation API",
        version=__version__,
        description="Model registry, synthetic dataset ingest, sandboxed inference, metrics and engineering reports.",
        lifespan=lifespan,
    )
    app.state.gl = state
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    from .api.routes import router

    app.include_router(router)
    return app


app = create_app()
