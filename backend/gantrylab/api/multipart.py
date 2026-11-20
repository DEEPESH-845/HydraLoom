"""Streaming multipart/form-data parser with hard size caps.

Starlette's ``request.form()`` spools the whole body before the handler sees it.
This parser consumes ``request.stream()`` chunk by chunk and aborts as soon as a cap is exceeded,
so an oversized upload is rejected mid-stream and never fully written to disk.
Client-supplied file names are recorded but never used to build paths.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO

from fastapi import HTTPException, Request
from python_multipart.multipart import MultipartParser, parse_options_header


class UploadRejected(HTTPException):
    pass


@dataclass
class StreamedFile:
    field: str
    filename: str
    content_type: str | None
    path: Path
    size: int = 0
    sha256: str = ""
    head: bytes = b""


@dataclass
class ParsedForm:
    fields: dict[str, list[str]] = field(default_factory=dict)
    files: list[StreamedFile] = field(default_factory=list)

    def cleanup(self) -> None:
        for f in self.files:
            try:
                f.path.unlink(missing_ok=True)
            except OSError:
                pass


async def parse_multipart(
    request: Request,
    tmp_dir: Path,
    *,
    max_file_bytes: int,
    max_total_bytes: int,
    max_files: int,
    max_field_bytes: int,
    text_file_fields: frozenset[str] = frozenset(),
) -> ParsedForm:
    """Parse a multipart body. Raises 413 / 400 ``HTTPException`` on violations.

    ``text_file_fields`` lists field names whose file parts are read into ``fields`` as text
    (for example a manifest sent as a Blob) instead of being written to disk.
    """
    ctype = request.headers.get("content-type", "")
    mime, params = parse_options_header(ctype)
    if mime != b"multipart/form-data" or b"boundary" not in params:
        raise HTTPException(status_code=415, detail="expected multipart/form-data")
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > max_total_bytes + 1024 * 1024:
                raise HTTPException(status_code=413, detail=f"request body exceeds {max_total_bytes} bytes")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid Content-Length") from exc

    tmp_dir.mkdir(parents=True, exist_ok=True)
    form = ParsedForm()
    state: dict = {"headers": {}, "hf": b"", "hv": b"", "name": None, "file": None, "fh": None,
                   "buf": None, "hasher": None, "size": 0, "text_file": False}
    errors: list[HTTPException] = []

    def fail(status: int, detail: str) -> None:
        exc = HTTPException(status_code=status, detail=detail)
        errors.append(exc)
        raise exc

    def on_part_begin() -> None:
        state.update(headers={}, hf=b"", hv=b"", name=None, file=None, fh=None, buf=None, hasher=None, size=0,
                     text_file=False)

    def on_header_field(data: bytes, start: int, end: int) -> None:
        state["hf"] += data[start:end]

    def on_header_value(data: bytes, start: int, end: int) -> None:
        state["hv"] += data[start:end]

    def on_header_end() -> None:
        state["headers"][state["hf"].strip().lower()] = state["hv"].strip()
        state["hf"] = b""
        state["hv"] = b""

    def on_headers_finished() -> None:
        disp, dparams = parse_options_header(state["headers"].get(b"content-disposition", b""))
        if disp != b"form-data" or b"name" not in dparams:
            fail(400, "malformed multipart part (missing form-data name)")
        name = dparams[b"name"].decode("utf-8", "replace")
        state["name"] = name
        if b"filename" in dparams and name not in text_file_fields:
            if len(form.files) >= max_files:
                fail(413, f"too many files (max {max_files})")
            raw_name = dparams[b"filename"].decode("utf-8", "replace")
            ct = state["headers"].get(b"content-type")
            sf = StreamedFile(field=name, filename=raw_name, content_type=ct.decode() if ct else None,
                              path=tmp_dir / f"upload-{uuid.uuid4().hex}.part")
            state["file"] = sf
            state["fh"] = open(sf.path, "wb")
            state["hasher"] = hashlib.sha256()
            form.files.append(sf)
        else:
            state["buf"] = bytearray()
            state["text_file"] = b"filename" in dparams

    def on_part_data(data: bytes, start: int, end: int) -> None:
        chunk = data[start:end]
        state["size"] += len(chunk)
        sf: StreamedFile | None = state["file"]
        if sf is not None:
            if state["size"] > max_file_bytes:
                fail(413, f"file {sf.filename!r} exceeds {max_file_bytes} bytes")
            fh: BinaryIO = state["fh"]
            fh.write(chunk)
            state["hasher"].update(chunk)
            if len(sf.head) < 64:
                sf.head = (sf.head + chunk)[:64]
        else:
            if state["size"] > max_field_bytes:
                fail(413, f"form field {state['name']!r} exceeds {max_field_bytes} bytes")
            state["buf"].extend(chunk)

    def on_part_end() -> None:
        sf: StreamedFile | None = state["file"]
        if sf is not None:
            state["fh"].close()
            state["fh"] = None
            sf.size = state["size"]
            sf.sha256 = state["hasher"].hexdigest()
        elif state["buf"] is not None:
            try:
                text = bytes(state["buf"]).decode("utf-8")
            except UnicodeDecodeError:
                fail(400, f"form field {state['name']!r} is not valid UTF-8")
            form.fields.setdefault(state["name"], []).append(text)

    parser = MultipartParser(
        params[b"boundary"],
        callbacks={
            "on_part_begin": on_part_begin,
            "on_header_field": on_header_field,
            "on_header_value": on_header_value,
            "on_header_end": on_header_end,
            "on_headers_finished": on_headers_finished,
            "on_part_data": on_part_data,
            "on_part_end": on_part_end,
        },
    )
    total = 0
    try:
        async for chunk in request.stream():
            total += len(chunk)
            if total > max_total_bytes + 1024 * 1024:
                raise HTTPException(status_code=413, detail=f"request body exceeds {max_total_bytes} bytes")
            parser.write(chunk)
        parser.finalize()
    except HTTPException:
        _abort(state, form)
        raise
    except Exception as exc:
        _abort(state, form)
        if errors:
            raise errors[0] from exc
        raise HTTPException(status_code=400, detail=f"malformed multipart body: {type(exc).__name__}") from exc
    if errors:
        _abort(state, form)
        raise errors[0]
    return form


def _abort(state: dict, form: ParsedForm) -> None:
    fh = state.get("fh")
    if fh is not None:
        try:
            fh.close()
        except OSError:
            pass
    form.cleanup()
