"""Shared fixtures: isolated data dir per test, synthetic dataset builder, fake checkpoints."""

from __future__ import annotations

import io
import json
import random
import time
import zipfile
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

BACKEND = Path(__file__).resolve().parent.parent
YOLOV8N = BACKEND / "yolov8n.pt"
CLASSES = ["SHIPWRECK", "MINE", "DEBRIS", "PILING", "TIRE"]


def fake_inspector(path: Path, fmt: str) -> dict:
    """Stands in for the sandbox in API tests that do not exercise model loading."""
    return {
        "format": fmt,
        "task": "detect",
        "names": {str(i): c for i, c in enumerate(CLASSES)},
        "nc": len(CLASSES),
        "imgsz": 640,
        "parameters": 3_000_000,
        "gflops": 8.7,
        "gflops_imgsz": 640,
        "architecture": "DetectionModel",
        "train_args": {"epochs": 10, "imgsz": 640},
        "forward_check": "ok",
    }


def fake_pt_bytes(tag: str = "a") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("archive/data.pkl", b"\x80\x02}q\x00." + tag.encode())
        zf.writestr("archive/version", b"3\n")
    return buf.getvalue()


def png_bytes(w: int, h: int, boxes: list[list[float]], seed: int, fmt: str = "PNG") -> bytes:
    rng = random.Random(seed)
    im = Image.new("RGB", (w, h), (10, 40 + rng.randint(0, 40), 70 + rng.randint(0, 40)))
    d = ImageDraw.Draw(im)
    for x, y, bw, bh in boxes:
        d.rectangle([x, y, x + bw - 1, y + bh - 1], fill=(rng.randint(120, 255), rng.randint(80, 200), 40))
    out = io.BytesIO()
    im.save(out, format=fmt)
    return out.getvalue()


def make_dataset(n_frames: int = 40, seed: int = 1337, width: int = 320, height: int = 240,
                 name: str = "harbor sweep", environment_cycle: tuple[str, ...] = ("harbor", "reef")) -> tuple[dict, list[tuple[str, bytes]]]:
    rng = random.Random(seed)
    frames, files = [], []
    for i in range(n_frames):
        fname = f"{i + 1:06d}.png"
        anns = []
        boxes = []
        for k in range(rng.randint(1, 3)):
            bw = rng.choice([20, 40, 80, 120])
            bh = max(10, int(bw * rng.uniform(0.5, 1.0)))
            x = rng.uniform(0, width - bw - 1)
            y = rng.uniform(0, height - bh - 1)
            boxes.append([x, y, bw, bh])
            anns.append({
                "object_id": f"obj-{i}-{k}",
                "class_name": CLASSES[(i + k) % len(CLASSES)],
                "bbox_xywh": [round(x, 2), round(y, 2), bw, bh],
                "visible_fraction": round(rng.uniform(0.3, 1.0), 3),
                "occluded_fraction": round(rng.uniform(0.0, 0.7), 3),
                "truncated": False,
                "distance_m": round(rng.uniform(0.5, 9.0), 2),
                "area_px": float(bw * bh),
            })
        frames.append({
            "file": fname,
            "width": width,
            "height": height,
            "camera": {"fx": 200.0, "fy": 200.0, "cx": width / 2, "cy": height / 2, "position": [0, 1, 2],
                       "quaternion": [0, 0, 0, 1], "hfov_deg": 75},
            "conditions": {
                "environment": environment_cycle[i % len(environment_cycle)],
                "platform": "rov",
                "turbidity": [0.05, 0.2, 0.45, 0.8][i % 4],
                "ntu": [0.5, 2.6, 8.0, 25.0][i % 4],
                "lighting": [0.9, 0.5, 0.2][i % 3],
                "current_speed_mps": [0.1, 0.4, 0.8][i % 3],
                "current_dir_deg": (i * 45) % 360,
                "depth_m": [3.0, 7.0, 15.0][i % 3],
                "vehicle_speed_mps": 0.3,
                "motion_blur_px": [0.5, 2.0][i % 2],
            },
            "annotations": anns,
        })
        files.append((fname, png_bytes(width, height, boxes, seed + i)))
    manifest = {
        "schema": "gantrylab.dataset/1",
        "name": name,
        "seed": seed,
        "generator": {"app": "gantrylab-web", "version": "0.2.0", "renderer": "three r184"},
        "classes": CLASSES,
        "frames": frames,
    }
    return manifest, files


def upload_dataset(client: TestClient, manifest: dict, files: list[tuple[str, bytes]]):
    multipart = [("files", (n, b, "image/png")) for n, b in files]
    return client.post("/api/v1/datasets", data={"manifest": json.dumps(manifest)}, files=multipart)


def upload_model(client: TestClient, content: bytes, filename: str = "model.pt", name: str | None = None):
    data = {"name": name} if name else {}
    return client.post("/api/v1/models", files={"file": (filename, content, "application/octet-stream")}, data=data)


def wait_for(pred: Callable[[], Any], timeout: float = 120.0, interval: float = 0.1) -> Any:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = pred()
        if v:
            return v
        time.sleep(interval)
    raise TimeoutError("condition not met")


@pytest.fixture
def make_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    clients = []

    def _make(inspector=fake_inspector, **env: str) -> TestClient:
        for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GANTRYLAB_OLLAMA_MODEL", "GANTRYLAB_OLLAMA_URL",
                  "GANTRYLAB_LLM_PROVIDER"):
            monkeypatch.delenv(k, raising=False)
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        from gantrylab.app import create_app

        app = create_app(data_dir=tmp_path / f"data{len(clients)}", inspector=inspector)
        c = TestClient(app)
        c.__enter__()
        clients.append(c)
        return c

    yield _make
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


@pytest.fixture
def ready_model(client: TestClient) -> dict:
    r = upload_model(client, fake_pt_bytes("ready"), "harbor-detector.pt")
    assert r.status_code == 201, r.text
    mid = r.json()["id"]
    return wait_for(lambda: (m := client.get(f"/api/v1/models/{mid}").json())["status"] == "ready" and m)


@pytest.fixture
def dataset(client: TestClient) -> dict:
    manifest, files = make_dataset()
    r = upload_dataset(client, manifest, files)
    assert r.status_code == 201, r.text
    return r.json()


def run_mock(client: TestClient, model_id: str, dataset_id: str, **config: Any) -> dict:
    body = {"model_id": model_id, "dataset_id": dataset_id, "adapter": "mock", "seed": 7, "config": config}
    r = client.post("/api/v1/runs", json=body)
    assert r.status_code == 202, r.text
    rid = r.json()["id"]
    return wait_for(lambda: (x := client.get(f"/api/v1/runs/{rid}").json())["status"] in ("complete", "failed") and x)
