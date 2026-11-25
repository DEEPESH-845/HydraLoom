"""FastAPI application factory.

Run: ``cd backend && .venv/Scripts/python -m uvicorn gantrylab.app:app --port 8000``
"""

from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI echoes the rejected input, and NaN or a lone surrogate cannot be sent back as JSON (a 500).
        detail = [{k: e[k] for k in ("type", "loc", "msg") if k in e} for e in exc.errors()]
        text = "".join(ch if not 0xD800 <= ord(ch) <= 0xDFFF else "?" for ch in repr(detail))
        safe = detail if text == repr(detail) else [{"type": "invalid", "loc": ["body"], "msg": "the body is not valid text"}]
        return JSONResponse({"detail": safe}, status_code=422)

    if settings.api_token:
        expected = f"Bearer {settings.api_token}".encode()

        # Added before CORS, so CORS wraps it: a refused write still carries the headers the browser needs to show it.
        @app.middleware("http")
        async def require_token(request: Request, call_next) -> Response:  # noqa: ANN001
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                given = request.headers.get("authorization", "").encode("utf-8", "surrogateescape")
                if not hmac.compare_digest(given, expected):
                    return JSONResponse({"detail": "this backend needs its access token for uploads, runs and reports"},
                                        status_code=401, headers={"WWW-Authenticate": "Bearer"})
            return await call_next(request)

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
