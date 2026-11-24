"""Real inference with backend/yolov8n.pt through the HTTP API and the sandbox worker.

Marked ``real``: slow (spawns the worker, imports torch). Run alone with ``-m real -s`` to see timings.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from gantrylab.metrics.engine import iou_matrix

from .conftest import BACKEND, YOLOV8N, make_dataset, upload_dataset, upload_model, wait_for

pytestmark = [pytest.mark.real, pytest.mark.skipif(not YOLOV8N.exists(), reason="backend/yolov8n.pt not present")]

ONNX_FIXTURE = BACKEND / "data" / "fixtures" / "yolov8n.onnx"


def _wait_model(client, mid: str) -> dict:
    return wait_for(lambda: (m := client.get(f"/api/v1/models/{mid}").json())["status"] != "pending" and m, timeout=300)


def _run(client, model_id: str, dataset_id: str, **config) -> dict:
    body = {"model_id": model_id, "dataset_id": dataset_id, "adapter": "auto",
            "config": {"class_map": {"boat": "SHIPWRECK", "tie": "DEBRIS"}, "warmup_frames": 2, **config}}
    r = client.post("/api/v1/runs", json=body)
    assert r.status_code == 202, r.text
    rid = r.json()["id"]
    return wait_for(lambda: (x := client.get(f"/api/v1/runs/{rid}").json())["status"] in ("complete", "failed") and x,
                    timeout=600)


@pytest.fixture(scope="module")
def onnx_path() -> Path:
    """Export yolov8n.pt to ONNX once (trusted local checkpoint) into the ignored data dir."""
    if ONNX_FIXTURE.exists():
        return ONNX_FIXTURE
    ONNX_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    script = (
        "import shutil, sys; from ultralytics import YOLO; "
        f"p = YOLO(r'{YOLOV8N}').export(format='onnx', imgsz=640, opset=17, dynamic=False, simplify=False); "
        f"shutil.move(p, r'{ONNX_FIXTURE}')"
    )
    work = ONNX_FIXTURE.parent / "export-work"
    work.mkdir(exist_ok=True)
    import shutil

    shutil.copy(YOLOV8N, work / "yolov8n.pt")
    script = script.replace(str(YOLOV8N), str(work / "yolov8n.pt"))
    subprocess.run([sys.executable, "-c", script], check=True, cwd=work, capture_output=True, timeout=600)
    return ONNX_FIXTURE


def _report(name: str, metrics: dict) -> None:
    lat = metrics["latency"]
    res = metrics["resources"]
    print(f"\n[{name}] device={res['device_name']} frames={lat['n_frames']} warmup_excluded={lat['n_warmup_excluded']} "
          f"total_ms p50={lat['total_ms']['p50']:.2f} p95={lat['total_ms']['p95']:.2f} mean={lat['total_ms']['mean']:.2f} "
          f"inference_ms p50={lat['inference_ms']['p50']:.2f} wall_fps={lat['wall_fps']:.1f} "
          f"peak_rss_mb={res['peak_rss_mb']} cpu%={res['cpu_percent_mean']} "
          f"gpu_mem_mb={res['gpu_max_memory_allocated_mb']} gpu_util={res['gpu_util_mean']}")


def test_real_yolov8n_pt_inference(make_client, tmp_path):
    client = make_client(inspector=None)
    up = upload_model(client, YOLOV8N.read_bytes(), "yolov8n.pt")
    assert up.status_code == 201, up.text
    rec = _wait_model(client, up.json()["id"])
    assert rec["status"] == "ready", rec
    insp = rec["inspection"]
    assert insp["task"] == "detect" and insp["nc"] == 80 and insp["names"]["0"] == "person"
    assert insp["parameters"] == 3157200 and insp["gflops"] == pytest.approx(8.7, abs=0.3)
    assert insp["train_args"]["epochs"] == 500

    manifest, files = make_dataset(6, width=640, height=480, seed=11)
    ds = upload_dataset(client, manifest, files).json()

    run = _run(client, rec["id"], ds["id"], device="cpu", compute_profile="auto")
    assert run["status"] == "complete", run
    assert run["mock"] is False and run["adapter"] == "ultralytics"
    assert run["versions"]["worker_torch"].startswith("2.")
    m = client.get(f"/api/v1/runs/{run['id']}/metrics").json()
    _report("pt/cpu", m)
    assert m["mock"] is False and m["banner"] is None
    assert m["latency"]["kind"] == "measured" and m["latency"]["n_warmup_excluded"] == 2
    assert m["latency"]["total_ms"]["n"] == 6 and m["latency"]["total_ms"]["p50"] > 0
    assert m["resources"]["kind"] == "measured" and m["resources"]["peak_rss_mb"] > 50
    assert m["hardware"]["profile"] == "host-cpu" and m["hardware"]["kind"] == "measured"
    assert m["hardware"]["latency_ms_p50"] == m["latency"]["total_ms"]["p50"]
    rpi = {b["profile"]: b for b in m["hardware_profiles"]}
    assert rpi["rpi4"]["kind"] == "estimated" and rpi["rpi4"]["latency_ms_p50"] > m["hardware"]["latency_ms_p50"]
    preds = client.get(f"/api/v1/runs/{run['id']}/predictions").json()
    assert len(preds["frames"]) == 6
    assert sum(len(f["detections"]) for f in preds["frames"]) > 0
    rep = client.post(f"/api/v1/runs/{run['id']}/report", json={}).json()
    assert rep["mock"] is False and "MOCK" not in json.dumps(rep["executive_summary"])

    try:
        import torch

        has_cuda = torch.cuda.is_available()
    except Exception:  # pragma: no cover
        has_cuda = False
    if has_cuda:
        run_gpu = _run(client, rec["id"], ds["id"], device="cuda")
        assert run_gpu["status"] == "complete", run_gpu
        mg = client.get(f"/api/v1/runs/{run_gpu['id']}/metrics").json()
        _report("pt/cuda", mg)
        assert mg["hardware"]["profile"] == "host-gpu" and mg["hardware"]["kind"] == "measured"
        assert mg["resources"]["gpu_max_memory_allocated_mb"] > 0

    pytest.real_pt_preds = preds  # type: ignore[attr-defined]


def _asset_dataset() -> tuple[dict, list[tuple[str, bytes]]]:
    """Two real photos bundled with Ultralytics, with hand-labelled boxes (test fixture only)."""
    import ultralytics
    from PIL import Image

    assets = Path(ultralytics.__file__).parent / "assets"
    gt = {
        "bus.jpg": [("SHIPWRECK", [22, 230, 784, 530]), ("DEBRIS", [48, 398, 198, 508]),
                    ("DEBRIS", [221, 405, 124, 453]), ("DEBRIS", [668, 390, 142, 488])],
        "zidane.jpg": [("DEBRIS", [120, 190, 1000, 530]), ("DEBRIS", [740, 40, 400, 680])],
    }
    frames, files = [], []
    for name, boxes in gt.items():
        path = assets / name
        w, h = Image.open(path).size
        frames.append({"file": name, "width": w, "height": h,
                       "conditions": {"environment": "assets", "turbidity": 0.0},
                       "annotations": [{"object_id": f"{name}-{i}", "class_name": c,
                                        "bbox_xywh": [x, y, min(bw, w - x), min(bh, h - y)]}
                                       for i, (c, (x, y, bw, bh)) in enumerate(boxes)]})
        files.append((name, path.read_bytes()))
    manifest = {"schema": "gantrylab.dataset/1", "name": "ultralytics assets", "seed": 0,
                "generator": {"app": "pytest", "version": "1"}, "classes": ["SHIPWRECK", "MINE", "DEBRIS", "PILING", "TIRE"],
                "frames": frames}
    return manifest, files


def test_real_onnx_inference_matches_pt(make_client, onnx_path):
    client = make_client(inspector=None)
    rec_onnx = _wait_model(client, upload_model(client, onnx_path.read_bytes(), "yolov8n.onnx").json()["id"])
    assert rec_onnx["status"] == "ready", rec_onnx
    assert rec_onnx["inspection"]["names"]["0"] == "person" and rec_onnx["inspection"]["imgsz"] == 640
    rec_pt = _wait_model(client, upload_model(client, YOLOV8N.read_bytes(), "yolov8n.pt").json()["id"])
    manifest, files = _asset_dataset()
    r = client.post("/api/v1/datasets", data={"manifest": json.dumps(manifest)},
                    files=[("files", (n, b, "image/jpeg")) for n, b in files])
    assert r.status_code == 201, r.text
    ds = r.json()
    cmap = {"bus": "SHIPWRECK", "person": "DEBRIS"}
    ro = _run(client, rec_onnx["id"], ds["id"], device="cpu", class_map=cmap)
    rp = _run(client, rec_pt["id"], ds["id"], device="cpu", class_map=cmap)
    assert ro["status"] == "complete" and rp["status"] == "complete", (ro, rp)
    assert ro["adapter"] == "onnx"
    mo = client.get(f"/api/v1/runs/{ro['id']}/metrics").json()
    mp = client.get(f"/api/v1/runs/{rp['id']}/metrics").json()
    _report("onnx/cpu", mo)
    print(f"\n[assets] recall onnx={mo['overall']['recall']:.3f} pt={mp['overall']['recall']:.3f} "
          f"map50 onnx={mo['overall']['map50']:.3f} pt={mp['overall']['map50']:.3f}")
    assert mo["overall"]["recall"] >= 0.8 and mp["overall"]["recall"] >= 0.8
    po = client.get(f"/api/v1/runs/{ro['id']}/predictions").json()["frames"]
    pp = client.get(f"/api/v1/runs/{rp['id']}/predictions").json()["frames"]
    # Ultralytics letterboxes .pt input to a stride-aligned rectangle; the ONNX export has a fixed 640x640 input.
    # Confident detections must still agree closely.
    compared = matched = 0
    for fo, fp in zip(po, pp):
        for d in (d for d in fo["detections"] if d["conf"] >= 0.5):
            compared += 1
            same = [x for x in fp["detections"] if x["class_name"] == d["class_name"]]
            if not same:
                continue
            ious = iou_matrix(np.array([d["bbox_xyxy"]]), np.array([x["bbox_xyxy"] for x in same]))[0]
            k = int(np.argmax(ious))
            if ious[k] >= 0.85 and abs(same[k]["conf"] - d["conf"]) < 0.1:
                matched += 1
    print(f"[onnx-vs-pt] confident ONNX detections: {compared}; matched in PyTorch output: {matched}")
    assert compared >= 4
    assert matched == compared
