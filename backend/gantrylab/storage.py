"""Filesystem JSON helpers: atomic writes, read-only originals, safe names, ids."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def lock_for(key: str) -> threading.RLock:
    """Process-wide re-entrant lock per logical resource key."""
    with _locks_guard:
        lk = _locks.get(key)
        if lk is None:
            lk = threading.RLock()
            _locks[key] = lk
        return lk


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def is_safe_id(value: str) -> bool:
    return bool(SAFE_ID_RE.match(value or ""))


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False, default=_json_default)
            fh.flush()
            os.fsync(fh.fileno())
        _retry_on_sharing_violation(lambda: os.replace(tmp, path))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _retry_on_sharing_violation(fn: Any, attempts: int = 50, delay: float = 0.02) -> Any:
    """Windows refuses to replace or open a file while another handle is mid-replace or open
    without FILE_SHARE_DELETE (PermissionError). These windows are milliseconds long, so retry."""
    for i in range(attempts):
        try:
            return fn()
        except PermissionError:
            if os.name != "nt" or i == attempts - 1:
                raise
            time.sleep(delay)


def _json_default(obj: Any) -> Any:
    try:
        import numpy as np

        if isinstance(obj, np.generic):
            return obj.item()
        if isinstance(obj, np.ndarray):
            return obj.tolist()
    except ImportError:  # pragma: no cover
        pass
    if isinstance(obj, Path):
        return str(obj)
    raise TypeError(f"not JSON serialisable: {type(obj).__name__}")


def read_json(path: Path) -> Any:
    def _read() -> Any:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    return _retry_on_sharing_violation(_read)


def make_read_only(path: Path) -> None:
    """Clear every write bit. On Windows this sets FILE_ATTRIBUTE_READONLY."""
    os.chmod(path, stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)


def is_read_only(path: Path) -> bool:
    mode = os.stat(path).st_mode
    return not (mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_hash(obj: Any) -> str:
    """Stable SHA-256 of a JSON-serialisable object (sorted keys, no whitespace)."""
    blob = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=_json_default)
    return sha256_bytes(blob.encode("utf-8"))
