"""Model registry: secure upload, immutable content-addressed storage, sandboxed inspection."""

from __future__ import annotations

import logging
import re
import shutil
import zipfile
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Callable

from fastapi import HTTPException

from ..config import Settings
from ..sandbox.runner import SandboxLimits, run_sandboxed
from ..schemas import ModelInspection, ModelRecord, ModelVersionRef
from ..storage import SHA256_RE, lock_for, make_read_only, read_json, utcnow, write_json_atomic

log = logging.getLogger("gantrylab.models")

ALLOWED_EXT = {".pt": "pt", ".onnx": "onnx"}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,119}$")
SUPPORTED_TASKS = {"detect", "segment", "pose", None}
DATA_PKL_RE = re.compile(r"^[^/\\]+/data\.pkl$")
MAX_ZIP_ENTRIES = 200_000

Inspector = Callable[[Path, str], dict]


class InspectionRejected(Exception):
    pass


def validate_filename(filename: str) -> tuple[str, str]:
    """Return (format, extension). Reject path components, control characters and bad extensions."""
    if not filename or len(filename) > 255:
        raise HTTPException(status_code=400, detail="missing or overlong file name")
    if any(c in filename for c in ("/", "\\", "\x00")) or ".." in filename or any(ord(c) < 32 for c in filename):
        raise HTTPException(status_code=400, detail="file name must not contain path separators, '..' or control characters")
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail=f"unsupported extension {ext or '(none)'}; only .pt and .onnx are accepted")
    return ALLOWED_EXT[ext], ext


def validate_magic(path: Path, fmt: str, head: bytes) -> None:
    """Cheap structural validation in the API process. Never unpickles anything."""
    if fmt == "pt":
        if not head.startswith(b"PK\x03\x04"):
            if head[:1] == b"\x80":
                raise HTTPException(status_code=400, detail="legacy (non-zip) pickle checkpoints are rejected; "
                                                            "re-save with torch>=1.6 zip serialization")
            raise HTTPException(status_code=400, detail="invalid .pt file: not a PyTorch zip archive (bad magic)")
        try:
            with zipfile.ZipFile(path) as zf:
                infos = zf.infolist()
                if len(infos) > MAX_ZIP_ENTRIES:
                    raise HTTPException(status_code=400, detail="invalid .pt file: too many archive entries")
                names = [i.filename for i in infos]
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="invalid .pt file: corrupt zip archive") from exc
        pkls = [n for n in names if DATA_PKL_RE.match(n)]
        if len(pkls) != 1:
            raise HTTPException(status_code=400, detail="invalid .pt file: expected exactly one '<archive>/data.pkl' entry")
        if any(n.startswith(("/", "\\")) or ".." in n.split("/") for n in names):
            raise HTTPException(status_code=400, detail="invalid .pt file: unsafe archive entry names")
    else:
        # ONNX ModelProto starts with field 1 (ir_version, varint) => tag byte 0x08.
        if head[:1] != b"\x08":
            raise HTTPException(status_code=400, detail="invalid .onnx file: not an ONNX protobuf (bad magic)")


class ModelRegistry:
    def __init__(self, settings: Settings, inspector: Inspector | None = None) -> None:
        self.settings = settings
        self.inspector = inspector or self._sandbox_inspect
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gl-inspect")
        self.futures: dict[str, Future] = {}

    # -- storage -------------------------------------------------------------

    def _dir(self, sha: str) -> Path:
        return self.settings.models_dir / sha

    def _record_path(self, sha: str) -> Path:
        return self._dir(sha) / "model.json"

    def _load_raw(self, sha: str) -> dict | None:
        p = self._record_path(sha)
        return read_json(p) if p.exists() else None

    def _all_raw(self) -> list[dict]:
        out = []
        if not self.settings.models_dir.exists():
            return out
        for d in self.settings.models_dir.iterdir():
            if d.is_dir() and SHA256_RE.match(d.name):
                r = self._load_raw(d.name)
                if r:
                    out.append(r)
        return out

    def _to_record(self, raw: dict, all_raw: list[dict] | None = None, deduplicated: bool = False) -> ModelRecord:
        all_raw = all_raw if all_raw is not None else self._all_raw()
        versions = sorted(
            (ModelVersionRef(version=r["version"], id=r["id"], sha256=r["sha256"], uploaded_at=r["uploaded_at"],
                             status=r["status"]) for r in all_raw if r["name"] == raw["name"]),
            key=lambda v: v.version,
        )
        data = {**raw, "versions": versions, "deduplicated": deduplicated}
        return ModelRecord.model_validate(data)

    def list(self) -> list[ModelRecord]:
        raws = self._all_raw()
        raws.sort(key=lambda r: (r["uploaded_at"], r["id"]), reverse=True)
        return [self._to_record(r, raws) for r in raws]

    def get(self, model_id: str) -> ModelRecord:
        raw = self.get_raw(model_id)
        return self._to_record(raw)

    def get_raw(self, model_id: str) -> dict:
        if not SHA256_RE.match(model_id or ""):
            raise HTTPException(status_code=404, detail="model not found")
        raw = self._load_raw(model_id)
        if raw is None:
            raise HTTPException(status_code=404, detail="model not found")
        return raw

    def original_path(self, raw: dict) -> Path:
        return self.settings.data_dir / raw["storage_path"]

    # -- upload --------------------------------------------------------------

    def register_upload(self, tmp_path: Path, filename: str, sha: str, size: int, head: bytes,
                        name: str | None) -> tuple[ModelRecord, bool]:
        """Validate and store an uploaded temp file. Returns (record, created)."""
        fmt, ext = validate_filename(filename)
        if size == 0:
            raise HTTPException(status_code=400, detail="empty file")
        validate_magic(tmp_path, fmt, head)
        display = (name or Path(filename).stem).strip()
        if not NAME_RE.match(display):
            raise HTTPException(status_code=400, detail="invalid model name (1-120 chars: letters, digits, space, . _ ( ) + -)")
        with lock_for("models"):
            existing = self._load_raw(sha)
            if existing is not None:
                tmp_path.unlink(missing_ok=True)
                return self._to_record(existing, deduplicated=True), False
            d = self._dir(sha)
            d.mkdir(parents=True, exist_ok=True)
            dest = d / f"original{ext}"
            shutil.move(str(tmp_path), dest)
            make_read_only(dest)
            all_raw = self._all_raw()
            version = 1 + max((r["version"] for r in all_raw if r["name"] == display), default=0)
            raw = {
                "id": sha,
                "sha256": sha,
                "name": display,
                "version": version,
                "format": fmt,
                "size_bytes": size,
                "original_filename": filename,
                "uploaded_at": utcnow(),
                "status": "pending",
                "status_reason": "inspection queued",
                "inspection": None,
                "inspected_at": None,
                "storage_path": dest.relative_to(self.settings.data_dir).as_posix(),
            }
            write_json_atomic(self._record_path(sha), raw)
        self.submit_inspection(sha)
        return self._to_record(raw), True

    # -- inspection ----------------------------------------------------------

    def submit_inspection(self, sha: str) -> Future:
        fut = self.pool.submit(self._inspect, sha)
        self.futures[sha] = fut
        return fut

    def _sandbox_inspect(self, path: Path, fmt: str) -> dict:
        res = run_sandboxed(
            "inspect",
            {"model_path": str(path), "format": fmt},
            SandboxLimits(timeout_s=self.settings.inspect_timeout_s, memory_mb=self.settings.worker_mem_mb),
            tmp_root=self.settings.tmp_dir,
        )
        if not res.ok or not res.result:
            raise InspectionRejected(res.error or "inspection failed")
        return res.result["inspection"]

    def _inspect(self, sha: str) -> None:
        raw = self._load_raw(sha)
        if raw is None:
            return
        path = self.original_path(raw)
        status, reason, inspection = "rejected", None, None
        try:
            data = dict(self.inspector(path, raw["format"]))
            data["names"] = {str(k): str(v) for k, v in (data.get("names") or {}).items()}
            for key in ("checkpoint_ultralytics_version", "checkpoint_date", "checkpoint_torch_version"):
                if data.get(key) is not None:
                    data[key] = str(data[key])
            inspection = ModelInspection.model_validate(data).model_dump()
            task = inspection.get("task")
            if task not in SUPPORTED_TASKS:
                reason = f"task {task!r} is not supported for detection evaluation (supported: detect, segment, pose)"
            elif not inspection.get("names"):
                reason = "model has no class names; cannot map classes for evaluation"
            else:
                status, reason = "ready", None
        except InspectionRejected as exc:
            reason = f"rejected by sandbox inspection: {exc}"
        except Exception as exc:  # noqa: BLE001
            log.exception("inspection crashed for %s", sha)
            reason = f"inspection error: {type(exc).__name__}: {exc}"
        try:
            with lock_for("models"):
                raw = self._load_raw(sha) or raw
                raw.update(status=status, status_reason=reason, inspection=inspection, inspected_at=utcnow())
                write_json_atomic(self._record_path(sha), raw)
        except Exception:
            # The record stays "pending" and is re-inspected on the next start-up (resume_pending).
            log.exception("could not persist inspection result for %s", sha)
            raise

    def resume_pending(self) -> None:
        for raw in self._all_raw():
            if raw.get("status") == "pending":
                self.submit_inspection(raw["sha256"])

    def wait(self, sha: str, timeout: float | None = None) -> ModelRecord:
        fut = self.futures.get(sha)
        if fut is not None:
            fut.result(timeout=timeout)
        return self.get(sha)

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)
