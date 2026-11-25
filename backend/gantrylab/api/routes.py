"""All /api/v1 routes."""

from __future__ import annotations

import asyncio
import os
import platform
from importlib import metadata

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from .. import __version__
from ..hardware import gpu_names, host_cpu_name, list_profiles
from ..llm import provider_status
from ..schemas import (
    AskRequest,
    AskResponse,
    CompareResponse,
    ComputeProfileList,
    DatasetDetail,
    DatasetList,
    DatasetRecord,
    EngineeringReport,
    HealthResponse,
    ModelList,
    ModelRecord,
    PatchResponse,
    ReportCreate,
    ReportList,
    RunCreate,
    RunCreated,
    RunList,
    RunMetrics,
    RunPredictions,
    RunRecord,
)
from ..services.compare import compare_runs
from .multipart import parse_multipart

router = APIRouter(prefix="/api/v1")
TERMINAL = ("complete", "failed")


def _state(request: Request):  # noqa: ANN202
    return request.app.state.gl


# ---------------------------------------------------------------------------
# Health / compute profiles
# ---------------------------------------------------------------------------


def _pkg(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


@router.get("/health", response_model=HealthResponse, tags=["health"])
def health(request: Request) -> HealthResponse:
    st = _state(request)
    s = st.settings
    versions = {"python": platform.python_version()}
    for p in ("fastapi", "pydantic", "numpy", "torch", "torchvision", "ultralytics", "onnxruntime", "onnx"):
        versions[p] = _pkg(p)
    torch_v = versions.get("torch") or ""
    writable = os.access(s.data_dir, os.W_OK)
    return HealthResponse(
        status="ok",
        service="gantrylab-backend",
        version=__version__,
        versions=versions,
        adapters={"ultralytics": bool(versions["ultralytics"] and versions["torch"]),
                  "onnx": bool(versions["onnxruntime"]), "mock": True},
        devices={"cpu": host_cpu_name(), "cuda": list(gpu_names()),
                 "torch_cuda_build": torch_v.split("+", 1)[1] if "+" in torch_v else None},
        llm_providers=provider_status(),
        llm_default=s.llm_provider,
        data_dir_writable=writable,
        write_auth=bool(s.api_token),
        limits={"max_model_mb": s.max_model_mb, "max_dataset_frames": s.max_dataset_frames,
                "max_frame_mb": s.max_frame_mb, "max_dataset_mb": s.max_dataset_mb,
                "worker_timeout_s": s.worker_timeout_s, "worker_mem_mb": s.worker_mem_mb},
    )


@router.get("/compute-profiles", response_model=ComputeProfileList, tags=["compute"])
def compute_profiles() -> ComputeProfileList:
    return ComputeProfileList(profiles=list_profiles())


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


@router.post("/models", response_model=ModelRecord, status_code=201, tags=["models"],
             responses={200: {"model": ModelRecord, "description": "Duplicate upload (same SHA-256)"}})
async def upload_model(request: Request) -> JSONResponse:
    st = _state(request)
    s = st.settings
    cap = s.max_model_mb * 1024 * 1024
    form = await parse_multipart(request, s.tmp_dir, max_file_bytes=cap, max_total_bytes=cap, max_files=1,
                                 max_field_bytes=4096)
    try:
        files = [f for f in form.files if f.field == "file"]
        if len(files) != 1 or len(form.files) != 1:
            raise HTTPException(status_code=400, detail="exactly one 'file' part is required")
        f = files[0]
        names = form.fields.get("name") or [None]
        record, created = await asyncio.to_thread(
            st.models.register_upload, f.path, f.filename, f.sha256, f.size, f.head, names[0])
    finally:
        form.cleanup()
    return JSONResponse(record.model_dump(mode="json"), status_code=201 if created else 200)


@router.get("/models", response_model=ModelList, tags=["models"])
def list_models(request: Request) -> ModelList:
    return ModelList(models=_state(request).models.list())


@router.get("/models/{model_id}", response_model=ModelRecord, tags=["models"])
def get_model(model_id: str, request: Request) -> ModelRecord:
    return _state(request).models.get(model_id)


# ---------------------------------------------------------------------------
# Datasets
# ---------------------------------------------------------------------------


@router.post("/datasets", response_model=DatasetRecord, status_code=201, tags=["datasets"])
async def upload_dataset(request: Request) -> JSONResponse:
    st = _state(request)
    s = st.settings
    form = await parse_multipart(
        request, s.tmp_dir,
        max_file_bytes=s.max_frame_mb * 1024 * 1024,
        max_total_bytes=s.max_dataset_mb * 1024 * 1024,
        max_files=s.max_dataset_frames,
        max_field_bytes=s.max_manifest_mb * 1024 * 1024,
        text_file_fields=frozenset({"manifest"}),
    )
    try:
        rec = await asyncio.to_thread(st.datasets.ingest, form)
    finally:
        form.cleanup()
    return JSONResponse(rec.model_dump(mode="json", by_alias=True), status_code=201)


@router.get("/datasets", response_model=DatasetList, tags=["datasets"])
def list_datasets(request: Request) -> JSONResponse:
    items = [d.model_dump(mode="json", by_alias=True) for d in _state(request).datasets.list()]
    return JSONResponse({"datasets": items})


@router.get("/datasets/{dataset_id}", response_model=DatasetDetail, tags=["datasets"])
def get_dataset(dataset_id: str, request: Request) -> JSONResponse:
    return JSONResponse(_state(request).datasets.detail(dataset_id).model_dump(mode="json", by_alias=True))


@router.get("/datasets/{dataset_id}/manifest", tags=["datasets"])
def get_manifest(dataset_id: str, request: Request) -> JSONResponse:
    return JSONResponse(_state(request).datasets.manifest(dataset_id))


@router.get("/datasets/{dataset_id}/export/yolo.zip", tags=["datasets"], response_class=FileResponse)
def export_yolo(dataset_id: str, request: Request) -> FileResponse:
    p = _state(request).datasets.yolo_zip_path(dataset_id)
    return FileResponse(p, media_type="application/zip", filename=f"{dataset_id}-yolo.zip")


@router.get("/datasets/{dataset_id}/export/coco.json", tags=["datasets"], response_class=FileResponse)
def export_coco(dataset_id: str, request: Request) -> FileResponse:
    p = _state(request).datasets.coco_path(dataset_id)
    return FileResponse(p, media_type="application/json", filename=f"{dataset_id}-coco.json")


@router.get("/datasets/{dataset_id}/frames/{file}", tags=["datasets"], response_class=FileResponse)
def get_frame(dataset_id: str, file: str, request: Request) -> FileResponse:
    p = _state(request).datasets.frame_path(dataset_id, file)
    media = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
    return FileResponse(p, media_type=media, headers={"Cache-Control": "public, max-age=31536000, immutable",
                                                      "X-Content-Type-Options": "nosniff"})


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


@router.post("/runs", response_model=RunCreated, status_code=202, tags=["runs"])
def create_run(body: RunCreate, request: Request) -> RunCreated:
    rec = _state(request).runs.create(body)
    return RunCreated(id=rec.id, status=rec.status, events_url=f"/api/v1/runs/{rec.id}/events",
                      status_url=f"/api/v1/runs/{rec.id}")


@router.get("/runs", response_model=RunList, tags=["runs"])
def list_runs(request: Request) -> RunList:
    return RunList(runs=_state(request).runs.list())


@router.get("/runs/{run_id}", response_model=RunRecord, tags=["runs"])
def get_run(run_id: str, request: Request) -> RunRecord:
    return _state(request).runs.get(run_id)


@router.get("/runs/{run_id}/metrics", response_model=RunMetrics, tags=["runs"])
def get_metrics(run_id: str, request: Request) -> JSONResponse:
    return JSONResponse(_state(request).runs.metrics(run_id))


@router.get("/runs/{run_id}/predictions", response_model=RunPredictions, tags=["runs"])
def get_predictions(run_id: str, request: Request) -> JSONResponse:
    return JSONResponse(_state(request).runs.predictions(run_id))


@router.websocket("/runs/{run_id}/events")
async def run_events(websocket: WebSocket, run_id: str) -> None:
    st = websocket.app.state.gl
    await websocket.accept()
    incoming: asyncio.Task | None = None
    try:
        try:
            raw = st.runs.get_raw(run_id)
        except HTTPException:
            await websocket.send_json({"type": "error", "message": "run not found"})
            await websocket.close(code=4404)
            return
        seq = 0
        # Pending receive: the only way to notice a client that left (or a server shutdown) while no event is due.
        incoming = asyncio.create_task(websocket.receive())
        if not st.runs.events_since(run_id, 0):
            # Unknown in memory (for example after a restart): send a snapshot.
            await websocket.send_json({"run_id": run_id, "seq": 0, "type": "status", "status": raw["status"],
                                       "progress": raw["progress"], "message": raw["message"], "ts": raw["created_at"]})
            if raw["status"] in TERMINAL:
                await websocket.close()
                return
        while True:
            events = st.runs.events_since(run_id, seq)
            for ev in events:
                await websocket.send_json(ev)
            seq += len(events)
            if events and events[-1]["status"] in TERMINAL and events[-1]["type"] in TERMINAL:
                break
            if not events:
                cur = st.runs.get_raw(run_id)
                if cur["status"] in TERMINAL and not st.runs.events_since(run_id, seq):
                    await websocket.send_json({"run_id": run_id, "seq": seq, "type": cur["status"],
                                               "status": cur["status"], "progress": cur["progress"],
                                               "message": cur["message"], "ts": cur.get("finished_at") or ""})
                    break
            await asyncio.wait({incoming}, timeout=0.2)
            if incoming.done():
                if incoming.result()["type"] == "websocket.disconnect":
                    return
                incoming = asyncio.create_task(websocket.receive())
        await websocket.close()
    except WebSocketDisconnect:
        return
    finally:
        if incoming is not None:
            incoming.cancel()


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


@router.post("/runs/{run_id}/report", response_model=EngineeringReport, status_code=201, tags=["reports"])
async def create_report(run_id: str, body: ReportCreate, request: Request) -> JSONResponse:
    rep = await asyncio.to_thread(_state(request).reports.create, run_id, body)
    return JSONResponse(rep, status_code=201)


@router.get("/reports", response_model=ReportList, tags=["reports"])
def list_reports(request: Request, run_id: str | None = None) -> ReportList:
    return ReportList(reports=_state(request).reports.list(run_id))


@router.get("/reports/{report_id}", response_model=EngineeringReport, tags=["reports"])
def get_report(report_id: str, request: Request) -> JSONResponse:
    return JSONResponse(_state(request).reports.get(report_id))


@router.get("/reports/{report_id}/export.json", tags=["reports"])
def export_report_json(report_id: str, request: Request) -> JSONResponse:
    st = _state(request)
    body = {"report": st.reports.get(report_id), "evidence": st.reports.evidence(report_id)}
    return JSONResponse(body, headers={"Content-Disposition": f'attachment; filename="{report_id}.json"'})


@router.get("/reports/{report_id}/export.html", response_class=HTMLResponse, tags=["reports"])
def export_report_html(report_id: str, request: Request) -> HTMLResponse:
    return HTMLResponse(_state(request).reports.html(report_id),
                        headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
                                 "X-Content-Type-Options": "nosniff"})


@router.get("/reports/{report_id}/patches/{file}", response_model=PatchResponse, tags=["reports"])
def get_patch(report_id: str, file: str, request: Request) -> PatchResponse:
    return _state(request).reports.patch(report_id, file)


@router.post("/reports/{report_id}/ask", response_model=AskResponse, tags=["reports"])
async def ask(report_id: str, body: AskRequest, request: Request) -> AskResponse:
    return await asyncio.to_thread(_state(request).reports.ask, report_id, body)


# ---------------------------------------------------------------------------
# Compare
# ---------------------------------------------------------------------------


@router.get("/compare", response_model=CompareResponse, tags=["compare"])
def compare(request: Request, runs: str = Query(..., description="Two run ids separated by a comma")) -> CompareResponse:
    ids = [r.strip() for r in runs.split(",") if r.strip()]
    return compare_runs(_state(request).runs, ids)
