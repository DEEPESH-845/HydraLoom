"""Synthetic dataset ingest, storage and YOLO / COCO export."""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path
from typing import Any

import yaml
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError

from ..api.multipart import ParsedForm
from ..config import Settings
from ..schemas import DatasetDetail, DatasetManifest, DatasetRecord, FRAME_FILE_RE
from ..storage import (
    canonical_hash,
    is_safe_id,
    lock_for,
    make_read_only,
    new_id,
    read_json,
    utcnow,
    write_json_atomic,
)

Image.MAX_IMAGE_PIXELS = 64_000_000  # decompression-bomb guard
FORMAT_BY_EXT = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG"}


def _err_list(exc: ValidationError) -> list[dict]:
    out = []
    for e in exc.errors(include_url=False, include_input=False):
        out.append({"loc": list(e.get("loc", ())), "msg": e.get("msg"), "type": e.get("type")})
    return out[:50]


def yolo_label_lines(frame: dict, class_index: dict[str, int]) -> list[str]:
    W, H = float(frame["width"]), float(frame["height"])
    lines = []
    for a in frame.get("annotations", []):
        x, y, w, h = a["bbox_xywh"]
        x1, y1 = max(0.0, x), max(0.0, y)
        x2, y2 = min(W, x + w), min(H, y + h)
        if x2 <= x1 or y2 <= y1:
            continue
        cx, cy = (x1 + x2) / 2 / W, (y1 + y2) / 2 / H
        nw, nh = (x2 - x1) / W, (y2 - y1) / H
        lines.append(f"{class_index[a['class_name']]} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
    return lines


def coco_document(manifest: dict, dataset_id: str, created_at: str) -> dict:
    classes = manifest["classes"]
    cat_id = {c: i + 1 for i, c in enumerate(classes)}
    images, annotations = [], []
    ann_id = 1
    for img_id, fr in enumerate(manifest["frames"], start=1):
        images.append({
            "id": img_id,
            "file_name": fr["file"],
            "width": fr["width"],
            "height": fr["height"],
            "gantrylab_conditions": fr.get("conditions", {}),
            "gantrylab_camera": fr.get("camera"),
        })
        for a in fr.get("annotations", []):
            x, y, w, h = a["bbox_xywh"]
            annotations.append({
                "id": ann_id,
                "image_id": img_id,
                "category_id": cat_id[a["class_name"]],
                "bbox": [x, y, w, h],
                "area": w * h,
                "iscrowd": 0,
                "gantrylab": {k: a.get(k) for k in ("object_id", "visible_fraction", "occluded_fraction",
                                                     "truncated", "distance_m", "area_px")},
            })
            ann_id += 1
    return {
        "info": {
            "description": f"GANTRYLAB synthetic dataset {manifest['name']}",
            "version": manifest["schema"],
            "year": int(created_at[:4]),
            "date_created": created_at,
            "contributor": manifest.get("generator", {}).get("app", ""),
            "gantrylab_dataset_id": dataset_id,
            "gantrylab_seed": manifest.get("seed"),
        },
        "licenses": [],
        "images": images,
        "annotations": annotations,
        "categories": [{"id": cat_id[c], "name": c, "supercategory": "object"} for c in classes],
    }


def data_yaml_text(classes: list[str]) -> str:
    doc = {"path": ".", "train": "images", "val": "images", "nc": len(classes),
           "names": {i: c for i, c in enumerate(classes)}}
    return yaml.safe_dump(doc, sort_keys=False, allow_unicode=True)


def summarise_conditions(frames: list[dict]) -> dict[str, dict]:
    keys = sorted({k for f in frames for k in (f.get("conditions") or {})})
    out: dict[str, dict] = {}
    for k in keys:
        vals = [(f.get("conditions") or {}).get(k) for f in frames]
        vals = [v for v in vals if v is not None]
        nums = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if nums and len(nums) == len(vals):
            out[k] = {"type": "numeric", "min": float(min(nums)), "max": float(max(nums)), "n_frames": len(vals)}
        else:
            out[k] = {"type": "categorical", "values": sorted({str(v) for v in vals})[:50], "n_frames": len(vals)}
    return out


class DatasetStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _dir(self, ds_id: str) -> Path:
        if not is_safe_id(ds_id) or not ds_id.startswith("ds_"):
            raise HTTPException(status_code=404, detail="dataset not found")
        d = self.settings.datasets_dir / ds_id
        if not (d / "dataset.json").exists():
            raise HTTPException(status_code=404, detail="dataset not found")
        return d

    # -- ingest --------------------------------------------------------------

    def ingest(self, form: ParsedForm) -> DatasetRecord:
        manifests = form.fields.get("manifest") or []
        if len(manifests) != 1:
            raise HTTPException(status_code=400, detail="exactly one 'manifest' field is required")
        raw_text = manifests[0]
        try:
            raw = json.loads(raw_text)
        except (ValueError, RecursionError) as exc:  # JSONDecodeError, over-long integer, too deep
            raise HTTPException(status_code=422, detail=f"manifest is not valid JSON: {getattr(exc, 'msg', exc)}") from exc
        try:
            manifest = DatasetManifest.model_validate(raw)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail={"message": "manifest validation failed",
                                                          "errors": _err_list(exc)}) from exc
        if len(manifest.frames) > self.settings.max_dataset_frames:
            raise HTTPException(status_code=413, detail=f"too many frames (max {self.settings.max_dataset_frames})")

        files = [f for f in form.files if f.field in ("files", "files[]", "file")]
        if len(files) != len(form.files):
            raise HTTPException(status_code=400, detail="unexpected file field; use 'files'")
        by_name: dict[str, Any] = {}
        for f in files:
            if not FRAME_FILE_RE.match(f.filename) or ".." in f.filename:
                raise HTTPException(status_code=400, detail=f"unsafe file name {f.filename!r}")
            if f.filename in by_name:
                raise HTTPException(status_code=400, detail=f"duplicate file {f.filename!r}")
            by_name[f.filename] = f
        expected = {fr.file for fr in manifest.frames}
        missing = sorted(expected - set(by_name))
        extra = sorted(set(by_name) - expected)
        if missing or extra:
            raise HTTPException(status_code=400, detail={"message": "files do not match manifest frames",
                                                          "missing": missing[:50], "unexpected": extra[:50]})
        for fr in manifest.frames:
            self._check_image(by_name[fr.file].path, fr.file, fr.width, fr.height)

        ds_id = new_id("ds")
        created = utcnow()
        final = self.settings.datasets_dir / ds_id
        staging = self.settings.datasets_dir / f".{ds_id}.staging"
        (staging / "images").mkdir(parents=True)
        (staging / "labels").mkdir()
        try:
            mdump = manifest.model_dump(mode="json", by_alias=True, exclude_none=False)
            total = 0
            for fr in manifest.frames:
                src = by_name[fr.file]
                dest = staging / "images" / fr.file
                shutil.move(str(src.path), dest)
                total += src.size
            class_index = {c: i for i, c in enumerate(manifest.classes)}
            for fr in mdump["frames"]:
                stem = fr["file"].rsplit(".", 1)[0]
                lines = yolo_label_lines(fr, class_index)
                (staging / "labels" / f"{stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""),
                                                                  encoding="utf-8")
            (staging / "manifest.original.json").write_text(raw_text, encoding="utf-8")
            write_json_atomic(staging / "manifest.json", mdump)
            write_json_atomic(staging / "coco.json", coco_document(mdump, ds_id, created))
            (staging / "data.yaml").write_text(data_yaml_text(manifest.classes), encoding="utf-8")
            class_counts = {c: 0 for c in manifest.classes}
            n_ann = 0
            for fr in manifest.frames:
                for a in fr.annotations:
                    class_counts[a.class_name] += 1
                    n_ann += 1
            record = {
                "id": ds_id,
                "name": manifest.name,
                "schema": "gantrylab.dataset/1",
                "seed": manifest.seed,
                "generator": manifest.generator.model_dump(),
                "classes": manifest.classes,
                "n_frames": len(manifest.frames),
                "n_annotations": n_ann,
                "class_counts": class_counts,
                "conditions": summarise_conditions(mdump["frames"]),
                "manifest_sha256": canonical_hash(mdump),
                "total_bytes": total,
                "created_at": created,
            }
            write_json_atomic(staging / "dataset.json", record)
            for p in [*(staging / "images").iterdir(), staging / "manifest.original.json", staging / "manifest.json"]:
                make_read_only(p)
            staging.rename(final)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True, onexc=_force_remove)
            raise
        finally:
            form.cleanup()
        return DatasetRecord.model_validate(record)

    def _check_image(self, path: Path, name: str, width: int, height: int) -> None:
        expected_fmt = FORMAT_BY_EXT[Path(name).suffix.lower()]
        try:
            with Image.open(path) as im:
                fmt = im.format
                size = im.size
                im.load()
        except Exception as exc:  # noqa: BLE001 - decoders raise SyntaxError, struct.error, ... on corrupt data
            raise HTTPException(status_code=400, detail=f"{name}: image does not decode ({type(exc).__name__})") from exc
        if fmt != expected_fmt:
            raise HTTPException(status_code=400, detail=f"{name}: content is {fmt}, extension implies {expected_fmt}")
        if size != (width, height):
            raise HTTPException(status_code=400, detail=f"{name}: image is {size[0]}x{size[1]}, manifest says {width}x{height}")

    # -- read ----------------------------------------------------------------

    def list(self) -> list[DatasetRecord]:
        out = []
        if not self.settings.datasets_dir.exists():
            return out
        for d in self.settings.datasets_dir.iterdir():
            p = d / "dataset.json"
            if d.is_dir() and not d.name.startswith(".") and p.exists():
                out.append(DatasetRecord.model_validate(read_json(p)))
        out.sort(key=lambda r: (r.created_at, r.id), reverse=True)
        return out

    def get(self, ds_id: str) -> DatasetRecord:
        return DatasetRecord.model_validate(read_json(self._dir(ds_id) / "dataset.json"))

    def detail(self, ds_id: str) -> DatasetDetail:
        d = self._dir(ds_id)
        rec = read_json(d / "dataset.json")
        man = read_json(d / "manifest.json")
        frames = [{"file": f["file"], "width": f["width"], "height": f["height"], "conditions": f.get("conditions", {}),
                   "n_annotations": len(f.get("annotations", []))} for f in man["frames"]]
        return DatasetDetail.model_validate({**rec, "frames": frames})

    def manifest(self, ds_id: str) -> dict:
        return read_json(self._dir(ds_id) / "manifest.json")

    def frame_path(self, ds_id: str, file: str) -> Path:
        d = self._dir(ds_id)
        if not FRAME_FILE_RE.match(file or "") or ".." in file:
            raise HTTPException(status_code=404, detail="frame not found")
        p = d / "images" / file
        if not p.is_file():
            raise HTTPException(status_code=404, detail="frame not found")
        return p

    def coco_path(self, ds_id: str) -> Path:
        return self._dir(ds_id) / "coco.json"

    def yolo_zip_path(self, ds_id: str) -> Path:
        d = self._dir(ds_id)
        out = d / "exports" / "yolo.zip"
        with lock_for(f"export:{ds_id}"):
            if out.exists():
                return out
            out.parent.mkdir(exist_ok=True)
            tmp = out.with_suffix(".zip.tmp")
            with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.write(d / "data.yaml", "data.yaml")
                for p in sorted((d / "images").iterdir()):
                    zf.write(p, f"images/{p.name}", compress_type=zipfile.ZIP_STORED)
                for p in sorted((d / "labels").iterdir()):
                    zf.write(p, f"labels/{p.name}")
            tmp.replace(out)
        return out


def _force_remove(func: Any, path: str, _exc: BaseException) -> None:
    import os
    import stat

    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except OSError:
        pass

