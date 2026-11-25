"""Regression tests for the backend bug audit. Each test failed before the matching fix."""

from __future__ import annotations

import asyncio
import json
import math
import os
import socket
import subprocess
import sys
import threading
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from gantrylab.config import BACKEND_ROOT
from gantrylab.services import models as models_mod
from gantrylab.services import runs as runs_mod
from gantrylab.sandbox import runner

from .conftest import (
    CLASSES,
    fake_inspector,
    fake_pt_bytes,
    make_dataset,
    png_bytes,
    run_mock,
    upload_dataset,
    upload_model,
    wait_for,
)


@pytest.fixture
def api(make_client) -> TestClient:
    """Client that turns server crashes into 500 responses instead of raising them in the test."""
    c = make_client()
    return TestClient(c.app, raise_server_exceptions=False)


def _ready(client: TestClient, tag: str = "m", filename: str = "m.pt") -> dict:
    mid = upload_model(client, fake_pt_bytes(tag), filename).json()["id"]
    return wait_for(lambda: (m := client.get(f"/api/v1/models/{mid}").json())["status"] != "pending" and m)


def _strict(resp) -> dict:  # noqa: ANN001
    return json.loads(resp.text, parse_constant=lambda c: pytest.fail(f"response contains {c}"))


# ---------------------------------------------------------------------------
# Dataset ingest
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("patch", [
    ("camera", {"cx": math.nan}), ("camera", {"fx": math.inf}), ("camera", {"position": [0, math.inf, 0]}),
    ("annotations", {"distance_m": math.inf}), ("annotations", {"area_px": math.inf}),
    ("conditions", {"k": 10**400}), ("conditions", {"k": "\ud800"}), ("conditions", {"k\n": 1}),
], ids=["nan-cx", "inf-fx", "inf-position", "inf-distance", "inf-area", "huge-int", "surrogate", "newline-key"])
def test_manifest_rejects_values_json_cannot_carry(api, patch):
    manifest, files = make_dataset(1)
    target = manifest["frames"][0][patch[0]]
    (target[0] if patch[0] == "annotations" else target).update(patch[1])
    r = upload_dataset(api, manifest, files)
    assert r.status_code == 422, r.text
    assert api.get("/api/v1/datasets").json() == {"datasets": []}


def test_class_name_with_trailing_newline_is_rejected(api):
    manifest, files = make_dataset(1)
    manifest["classes"] = [*CLASSES, "EXTRA\n"]
    assert upload_dataset(api, manifest, files).status_code == 422


@pytest.mark.parametrize("text", ["[" * 200_000, '{"seed": ' + "1" * 5000 + "}"], ids=["deep-nesting", "huge-int"])
def test_unparseable_manifest_is_422(api, text):
    r = api.post("/api/v1/datasets", data={"manifest": text}, files=[("files", ("a.png", b"x", "image/png"))])
    assert r.status_code == 422, r.text


def test_corrupt_png_chunk_is_400(api):
    manifest, files = make_dataset(1)
    name, data = files[0]
    at = data.index(b"IDAT")  # a short IDAT length makes Pillow raise SyntaxError from load()
    length = int.from_bytes(data[at - 4:at], "big") - 20
    broken = data[:at - 4] + length.to_bytes(4, "big") + data[at:]
    r = upload_dataset(api, manifest, [(name, broken)])
    assert r.status_code == 400, r.text


# ---------------------------------------------------------------------------
# Multipart
# ---------------------------------------------------------------------------


def test_text_fields_share_one_memory_cap(make_client):
    c = make_client(GANTRYLAB_MAX_MANIFEST_MB="1")
    blob = "x" * 900_000
    r = c.post("/api/v1/datasets", data={"a": blob, "b": blob, "c": blob},
               files=[("files", ("a.png", b"x", "image/png"))])
    assert r.status_code == 413, r.text
    r = c.post("/api/v1/datasets", data={f"f{i}": "" for i in range(5000)},
               files=[("files", ("a.png", b"x", "image/png"))])
    assert r.status_code == 413, r.text


def test_body_without_closing_boundary_is_rejected(api):
    body = (b'--B\r\nContent-Disposition: form-data; name="file"; filename="m.pt"\r\n\r\n' + fake_pt_bytes()
            + b'\r\n--B\r\nContent-Disposition: form-data; name="name"\r\n\r\nmy detec')
    r = api.post("/api/v1/models", content=body, headers={"content-type": "multipart/form-data; boundary=B"})
    assert r.status_code == 400 and "malformed" in r.text, r.text
    assert api.get("/api/v1/models").json() == {"models": []}


def test_cancelled_upload_leaves_no_temp_file(tmp_path):
    from gantrylab.api.multipart import parse_multipart

    class Req:
        headers = {"content-type": "multipart/form-data; boundary=B"}

        async def stream(self):
            yield b'--B\r\nContent-Disposition: form-data; name="file"; filename="m.pt"\r\n\r\nabcdef'
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(parse_multipart(Req(), tmp_path, max_file_bytes=99, max_total_bytes=9999, max_files=1,
                                    max_field_bytes=99))
    assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["version", "utf8"])
def test_corrupt_zip_directory_is_400(api, kind):
    blob = bytearray(fake_pt_bytes())
    cd = blob.index(b"PK\x01\x02")
    if kind == "version":
        blob[cd + 6] = 160  # "version needed to extract" 16.0
    else:
        blob[cd + 9] |= 0x08  # UTF-8 name flag
        blob[blob.index(b"data.pkl", cd)] = 0xCD
    r = upload_model(api, bytes(blob))
    assert r.status_code == 400, r.text


def test_non_finite_inspection_values_do_not_break_the_model_list(make_client):
    def inspector(path, fmt):  # noqa: ANN001
        return {**fake_inspector(path, fmt), "gflops": math.nan, "train_args": {"lr0": math.inf},
                "checkpoint_epoch": math.nan}

    client = make_client(inspector=inspector)
    api = TestClient(client.app, raise_server_exceptions=False)
    m = _ready(api)
    assert m["status"] == "ready", m
    assert m["inspection"]["gflops"] is None and m["inspection"]["train_args"]["lr0"] is None
    assert len(_strict(api.get("/api/v1/models"))["models"]) == 1
    r = upload_model(api, fake_pt_bytes("m"))
    assert r.status_code == 200 and _strict(r)["deduplicated"] is True


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def test_failed_json_write_leaves_no_temp_file(tmp_path):
    from gantrylab.storage import write_json_atomic

    with pytest.raises(TypeError):
        write_json_atomic(tmp_path / "a.json", {"x": object()})
    assert list(tmp_path.iterdir()) == []


def test_startup_removes_leftovers_of_a_killed_process(tmp_path):
    from gantrylab.app import create_app

    with TestClient(create_app(data_dir=tmp_path, inspector=fake_inspector)) as c:
        s = c.app.state.gl.settings
    (s.tmp_dir / "upload-dead.part").write_bytes(b"x" * 10)
    (s.tmp_dir / "gl-sbx-dead" / "home").mkdir(parents=True)
    (s.datasets_dir / ".ds_dead.staging" / "images").mkdir(parents=True)
    with TestClient(create_app(data_dir=tmp_path, inspector=fake_inspector)):
        assert list(s.tmp_dir.iterdir()) == []
        assert list(s.datasets_dir.iterdir()) == []


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


def test_class_map_prefers_the_exact_name():
    cmap, _, uncovered = runs_mod.resolve_class_map(["mine", "MINE", "Tire"], ["mine", "MINE", "TIRE"], {})
    assert cmap == {"mine": "mine", "MINE": "MINE", "Tire": "TIRE"} and uncovered == []


@pytest.mark.parametrize("cond", [
    {"turbidity": "high"}, {"lighting": 2.0, "turbidity": 0.0}, {"motion_blur_px": -5.0, "turbidity": 0.0},
    {"turbidity": 1e30}, {"lighting": "dim"},
], ids=["text-turbidity", "bright", "negative-blur", "huge-turbidity", "text-lighting"])
def test_mock_run_accepts_any_valid_condition_value(client, ready_model, cond):
    manifest, files = make_dataset(2)
    for f in manifest["frames"]:
        f["conditions"].update(cond)
    ds = upload_dataset(client, manifest, files).json()
    run = run_mock(client, ready_model["id"], ds["id"])
    assert run["status"] == "complete", run["error"]


def test_non_finite_detections_never_reach_json(client, ready_model, dataset, monkeypatch):
    def fake(command, job, limits, *, on_message, **kw):  # noqa: ANN001
        for i, f in enumerate(job["frames"]):
            on_message({"type": "frame", "i": i, "file": f["file"], "timing": {"total_ms": 1.0}, "detections": [
                {"class_id": 1, "class_name": "MINE", "bbox_xyxy": [math.nan, 0.0, 10.0, 10.0], "conf": 0.9},
                {"class_id": 1, "class_name": "MINE", "bbox_xyxy": [0.0, 0.0, 10.0, 10.0], "conf": math.inf},
                {"class_id": 1, "class_name": "MINE", "bbox_xyxy": [0.0, 0.0, 10.0, 10.0], "conf": 0.9}]})
        return runner.SandboxResult(ok=True, returncode=0, result={"runtime": {"device": "cpu"}, "wall_s": 1.0}, error=None)

    monkeypatch.setattr(runs_mod, "run_sandboxed", fake)
    api = TestClient(client.app, raise_server_exceptions=False)
    rid = api.post("/api/v1/runs", json={"model_id": ready_model["id"], "dataset_id": dataset["id"]}).json()["id"]
    run = wait_for(lambda: (x := api.get(f"/api/v1/runs/{rid}").json())["status"] in ("complete", "failed") and x)
    assert run["status"] == "complete", run["error"]
    preds = _strict(api.get(f"/api/v1/runs/{rid}/predictions"))
    assert all(len(f["detections"]) == 1 for f in preds["frames"])
    _strict(api.get(f"/api/v1/runs/{rid}/metrics"))


def _sleeping_sandbox(*_a, **kw):  # noqa: ANN001, ANN003
    kw.pop("on_message", None)
    kw.pop("sample_gpu", None)
    return runner.run_sandboxed("selftest-sleep", {"seconds": 60}, runner.SandboxLimits(90, 2048), **kw)


def test_shutdown_stops_the_active_run(client, ready_model, dataset, monkeypatch):
    monkeypatch.setattr(runs_mod, "run_sandboxed", _sleeping_sandbox)
    rm = client.app.state.gl.runs
    rid = client.post("/api/v1/runs", json={"model_id": ready_model["id"], "dataset_id": dataset["id"]}).json()["id"]
    wait_for(lambda: rm.get(rid).message == "launching sandbox worker")
    time.sleep(0.5)
    rm.shutdown()
    rec = rm.wait(rid, timeout=15)
    assert rec.status == "failed" and "shutdown" in rec.error
    assert list(rm.settings.tmp_dir.iterdir()) == []


def test_shutdown_leaves_an_interrupted_inspection_pending(make_client, monkeypatch):
    monkeypatch.setattr(models_mod, "run_sandboxed", _sleeping_sandbox)
    client = make_client(inspector=None)
    reg = client.app.state.gl.models
    mid = upload_model(client, fake_pt_bytes()).json()["id"]
    time.sleep(0.5)
    reg.shutdown()
    assert reg.wait(mid, timeout=15).status == "pending"  # re-inspected on the next start-up, not rejected


class _Server:
    def __init__(self, app) -> None:  # noqa: ANN001
        import uvicorn

        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        self.port = s.getsockname()[1]
        s.close()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        wait_for(lambda: self.server.started, 15)

    def stop(self, timeout: float) -> bool:
        self.server.should_exit = True
        self.thread.join(timeout)
        stopped = not self.thread.is_alive()
        self.server.force_exit = True
        return stopped


def test_event_socket_notices_disconnect_and_does_not_block_shutdown(client, ready_model, dataset, monkeypatch):
    from websockets.sync.client import connect

    release = threading.Event()
    rm = client.app.state.gl.runs
    monkeypatch.setattr(rm, "_execute", lambda _rid: release.wait(30))  # a run that stays queued and emits nothing
    polls = [0]
    real = rm.events_since

    def counting(run_id, seq):  # noqa: ANN001
        polls[0] += 1
        return real(run_id, seq)

    monkeypatch.setattr(rm, "events_since", counting)
    srv = _Server(client.app)
    try:
        rid = client.post("/api/v1/runs", json={"model_id": ready_model["id"], "dataset_id": dataset["id"],
                                                "adapter": "mock"}).json()["id"]
        url = f"ws://127.0.0.1:{srv.port}/api/v1/runs/{rid}/events"
        with connect(url) as ws:
            assert json.loads(ws.recv(timeout=5))["status"] == "queued"
            ws.send("a client message is ignored")
            time.sleep(0.5)
        time.sleep(0.6)
        before = polls[0]
        time.sleep(1.0)
        leaked = polls[0] - before
        with connect(url) as ws:
            ws.recv(timeout=5)
            stopped = srv.stop(8)
    finally:
        release.set()
        srv.stop(10)
    assert leaked == 0, "the handler keeps polling after the client went away"
    assert stopped, "an open event socket keeps the server from shutting down"


# ---------------------------------------------------------------------------
# Sandbox
# ---------------------------------------------------------------------------


def test_failed_spawn_removes_the_private_directory(tmp_path, monkeypatch):
    def boom(*_a, **_k):  # noqa: ANN002, ANN003
        raise OSError("no more processes")

    monkeypatch.setattr(runner.subprocess, "Popen", boom)
    with pytest.raises(OSError):
        runner.run_sandboxed("selftest", {}, runner.SandboxLimits(5, 512), tmp_root=tmp_path)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("stmt", [
    "os.rename(home + '/a', out + '/planted')",
    "os.replace(home + '/a', out + '/victim')",
    "os.link(out + '/victim', home + '/b'); open(home + '/b', 'w').write('pwned')",
    "os.truncate(out + '/victim', 0)",
    "os.mkdir(out + '/d')",
    "os.symlink(home + '/a', out + '/s')",
], ids=["rename", "replace", "link", "truncate", "mkdir", "symlink"])
def test_audit_hook_blocks_writes_outside_home(tmp_path, stmt):
    home, out = tmp_path / "home", tmp_path / "out"
    home.mkdir()
    out.mkdir()
    (home / "a").write_text("x")
    (out / "victim").write_text("data")
    code = (f"import sys, os; sys.path.insert(0, {str(BACKEND_ROOT)!r})\n"
            "from gantrylab.sandbox.worker import install_audit_hook\ninstall_audit_hook()\n"
            f"home, out = {str(home)!r}, {str(out)!r}\n{stmt}\n")
    r = subprocess.run([sys.executable, "-c", code], env={**os.environ, "GANTRYLAB_SANDBOX_HOME": str(home)},
                       capture_output=True, text=True, timeout=60)
    assert "sandbox blocked" in r.stderr, r.stderr
    assert [p.name for p in out.iterdir()] == ["victim"] and (out / "victim").read_text() == "data"


def test_dotted_global_cannot_reach_classes_outside_the_allowlist():
    from gantrylab.sandbox.restricted_pickle import DisallowedGlobal, resolve_global

    with pytest.raises(DisallowedGlobal):
        resolve_global("ultralytics.utils.loss", "torch.os._wrap_close")
    assert resolve_global("ultralytics.utils.loss", "v8DetectionLoss").__name__ == "v8DetectionLoss"
    assert resolve_global("ultralytics.utils.tal", "TaskAlignedAssigner").__name__ == "TaskAlignedAssigner"


# ---------------------------------------------------------------------------
# Adapters
# ---------------------------------------------------------------------------


def test_decode_more_channels_than_anchors():
    """imgsz 32 has 21 anchors and an 80-class head has 84 channels, so the small axis is not the channel axis."""
    from gantrylab.adapters.nms import decode_yolov8

    for n_anchors in (21, 84):
        out = np.zeros((1, 84, n_anchors), np.float32)
        out[0, :4, 3] = [16, 16, 8, 8]
        out[0, 4 + 8, 3] = 0.9
        for layout in (out, out.transpose(0, 2, 1)) if n_anchors == 21 else (out,):
            boxes, scores, cls = decode_yolov8(layout, 0.001, 0.7, 300, n_classes=80)
            assert cls.tolist() == [8] and scores.tolist() == pytest.approx([0.9])
            assert boxes.tolist() == [[12, 12, 20, 20]]


def test_decode_ignores_mask_and_keypoint_channels():
    """Segment and pose exports append mask coefficients or keypoints after the class scores."""
    from gantrylab.adapters.nms import decode_yolov8

    out = np.zeros((1, 4 + 1 + 51, 8400), np.float32)
    out[0, :4, 7] = [100, 100, 20, 20]
    out[0, 4, 7] = 0.8
    out[0, 5:, 7] = 320.0  # keypoint pixel coordinates
    _, scores, cls = decode_yolov8(out, 0.001, 0.7, 300, n_classes=1)
    assert cls.tolist() == [0] and scores.tolist() == pytest.approx([0.8])


def test_decode_rejects_an_end_to_end_head():
    """NMS-free exports emit (300, 6) rows of xyxy, conf, class. Reading them as a raw head gives garbage detections."""
    from gantrylab.adapters.nms import decode_yolov8

    with pytest.raises(ValueError, match="unexpected YOLO output shape"):
        decode_yolov8(np.ones((1, 300, 6), np.float32), 0.001, 0.7, 300, n_classes=80)


@pytest.mark.parametrize("meta", [{"end2end": "True"}, {"args": "{'batch': 1, 'nms': True}"}], ids=["end2end", "nms"])
def test_onnx_export_with_built_in_nms_fails_loudly(tmp_path, meta):
    """Two-class models are ambiguous by shape (4 + 2 channels), so the export metadata decides."""
    onnx = pytest.importorskip("onnx")
    pytest.importorskip("onnxruntime")
    from gantrylab.adapters import AdapterConfig
    from gantrylab.adapters.onnx_adapter import OnnxAdapter

    h = onnx.helper
    graph = h.make_graph(
        [h.make_node("Identity", ["x"], ["y"])], "g",
        [h.make_tensor_value_info("x", onnx.TensorProto.FLOAT, [1, 3, 32, 32])],
        [h.make_tensor_value_info("y", onnx.TensorProto.FLOAT, [1, 3, 32, 32])])
    model = h.make_model(graph, opset_imports=[h.make_opsetid("", 17)], ir_version=8)
    h.set_model_props(model, {"names": "{0: 'a', 1: 'b'}", **meta})
    path = tmp_path / "m.onnx"
    onnx.save(model, str(path))
    with pytest.raises(ValueError, match="built-in NMS"):
        OnnxAdapter().load(str(path), AdapterConfig())


def test_letterbox_extreme_aspect_ratio():
    from gantrylab.adapters.nms import letterbox

    canvas, _, _ = letterbox(np.zeros((1, 2000, 3), np.uint8), 640)
    assert canvas.shape == (640, 640, 3)


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def test_dynamic_bins_stay_distinct_for_large_offsets():
    from gantrylab.metrics.engine import evaluate

    values = [1700000000 + i for i in range(8)]
    frames = [{"file": f"{i}.png", "width": 10, "height": 10, "conditions": {"t": v}, "preds": [],
               "gt": [{"class": "A", "bbox": [0, 0, 5, 5], "attrs": {}}]} for i, v in enumerate(values)]
    sl = [s for s in evaluate(frames, ["A"], 0.25)["slices"] if s["key"] == "t"]
    assert [s["n_frames"] for s in sl] == [2, 2, 2, 2]
    assert len({s["id"] for s in sl}) == 4


def test_visible_fraction_bucket_edge():
    from gantrylab.metrics.buckets import OCCLUSION_EDGES, bucket_from_edges, occlusion_value

    assert bucket_from_edges(occlusion_value({"visible_fraction": 0.9}), OCCLUSION_EDGES).label == "partial"


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


def _many_class_run(client, n: int, drop_all: bool) -> dict:  # noqa: ANN001
    classes = [f"LONG_CLASS_NAME_FOR_REPORTS_{i:03d}" for i in range(n)]
    frames, files = [], []
    for k in range(6):
        anns = [{"object_id": f"o{i}", "class_name": c, "bbox_xywh": [i % 10 * 30, i // 10 * 20, 25, 15]}
                for i, c in enumerate(classes)]
        frames.append({"file": f"{k}.png", "width": 320, "height": 240, "annotations": anns, "conditions": {}})
        files.append((f"{k}.png", png_bytes(320, 240, [], k)))
    manifest = {"schema": "gantrylab.dataset/1", "name": "many", "generator": {"app": "t", "version": "1"},
                "classes": classes, "frames": frames}
    ds = upload_dataset(client, manifest, files).json()
    m = _ready(client)
    run = run_mock(client, m["id"], ds["id"], class_map={c: None for c in classes} if drop_all else {})
    assert run["status"] == "complete", run["error"]
    return run


@pytest.mark.parametrize("drop_all", [False, True], ids=["per-class-lines", "uncovered-classes"])
def test_report_with_many_classes(api, drop_all):
    run = _many_class_run(api, 90, drop_all)
    r = api.post(f"/api/v1/runs/{run['id']}/report", json={})
    assert r.status_code == 201, r.text
    assert "more" in r.json()["performance_breakdown"]["narrative"]


@pytest.fixture
def lossy_run(api) -> dict:
    """A run whose confidence threshold is bad enough that a conf suggestion is always produced."""
    m = _ready(api)
    manifest, files = make_dataset(20)
    ds = upload_dataset(api, manifest, files).json()
    run = run_mock(api, m["id"], ds["id"], conf=0.9)
    assert run["status"] == "complete", run["error"]
    return run


@pytest.mark.parametrize("text", [
    "conf: &a [*a]\n", "d: 2024-13-45\n", "[" * 5000, 'conf: "\\ud800"\n',
    "a: &a [x,x,x,x,x,x,x,x,x,x]\n" + "".join(f"{q}: &{q} [{','.join(['*' + p] * 10)}]\n" for p, q in zip("abcdefg", "bcdefgh"))
    + "conf: *h\n",
], ids=["cycle", "bad-date", "deep", "surrogate", "alias-bomb"])
def test_report_survives_hostile_user_yaml(api, lossy_run, text):
    r = api.post(f"/api/v1/runs/{lossy_run['id']}/report", json={"user_files": {"inference.yaml": text}})
    assert r.status_code == 201, r.text
    assert len(r.content) < 1_000_000
    rid = _strict(r)["id"]
    assert _strict(api.get(f"/api/v1/reports/{rid}"))["id"] == rid


@pytest.mark.parametrize("text", ["- a\n- b\n", "{conf: 0.25, iou: 0.7}\n", "x: 1\n...\n"],
                         ids=["list", "flow-mapping", "document-end"])
def test_patch_of_unpatchable_user_file_is_not_a_crash(api, lossy_run, text):
    rep = api.post(f"/api/v1/runs/{lossy_run['id']}/report", json={"user_files": {"inference.yaml": text}}).json()
    r = api.get(f"/api/v1/reports/{rep['id']}/patches/inference.yaml")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["applied_suggestions"] == [] and body["patched"] == body["original"] == text
    assert "could not be patched" in body["note"]


def _suggest(cfg: dict, **metrics) -> list[dict]:  # noqa: ANN003
    from gantrylab.reports.suggestions import build_suggestions

    base = {"overall": {"f1": None, "n_gt": 100, "tp": 10}, "pr": {"best_f1": None}, "fp_types": {}, "slices": [],
            "sensitivity": [], "confused_pairs": [], "per_class": {}}
    run = {"config": {"conf": 0.25, "iou": 0.7, "imgsz": 640, "max_det": 300, **cfg},
           "dataset": {"classes": []}, "resolved_class_map": {}}
    return build_suggestions({**base, **metrics}, run, {}, None)[0]


def test_suggestions_never_move_the_wrong_way():
    # "fewer duplicates" needs a lower NMS IoU; "more pixels" needs a larger input.
    assert _suggest({"iou": 0.3}, fp_types={"duplicate": 10}) == []
    sl = [{"id": f"slice:object_size:{b}", "key": "object_size", "bucket": b, "recall": r, "n_gt": 50}
          for b, r in (("small", 0.1), ("large", 0.9))]
    assert [s for s in _suggest({"imgsz": 2048}, slices=sl) if s["key"] == "imgsz" and s["suggested"] < 2048] == []
    assert [s["suggested"] for s in _suggest({}, slices=sl) if s["file"] == "inference.yaml"] == [960]


# ---------------------------------------------------------------------------
# Gantry safety and pi_bench
# ---------------------------------------------------------------------------


def test_limit_switch_with_unknown_position_refuses_motion():
    from gantrylab.gantry_safety import ARM_PHRASE, Command, HardwareStatus, SafetySupervisor

    s = SafetySupervisor(mode="live")
    s.heartbeat(HardwareStatus(True, True, True, False, False, math.nan, 20.0), 0)
    assert s.arm(ARM_PHRASE, 0).ok
    assert not s.validate(Command(kind="MOVE", x=1.0, y=10.0, speed=5.0), 1).ok


# ---------------------------------------------------------------------------
# Legacy service
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("line", [b'{"depth": NaN}\n', b'{"depth": 1e999}\n', b'{"depth": ' + b"1" * 5000 + b"}\n"],
                         ids=["nan", "overflow", "huge-int"])
def test_unusable_uart_numbers_are_dropped(line, monkeypatch):
    from . import test_regression_legacy_serial as legacy

    monkeypatch.setattr(legacy.serial_bridge.serial, "Serial", legacy.FakeSerial)
    bridge = legacy.serial_bridge.SerialBridge()
    assert bridge.connect()
    try:
        bridge.serial_conn.q.put(line)
        bridge.serial_conn.q.put(b'{"depth": 4}\n')
        assert legacy._wait(lambda: bridge.get_latest() == {"depth": 4}, 2.0), "the reader thread died"
        bridge.serial_conn.q.put(line)
        time.sleep(0.2)
        assert bridge.get_latest() == {"depth": 4}
    finally:
        bridge.disconnect()


def test_repeated_fault_lasts_its_full_duration(monkeypatch):
    from . import test_regression_legacy_ws as legacy

    timers = []

    class FakeTimer:
        def __init__(self, _s, fn):  # noqa: ANN001
            self.fn, self.cancelled = fn, False
            timers.append(self)

        def start(self):
            pass

        def cancel(self):
            self.cancelled = True

    monkeypatch.setattr(legacy.fault_mod.threading, "Timer", FakeTimer)
    inj = legacy.main.fault_injector
    inj.trigger_anomaly("LEAK_DETECT")
    inj.trigger_anomaly("LEAK_DETECT")
    try:
        assert timers[0].cancelled and not timers[1].cancelled  # the first timer must not end the second fault early
    finally:
        inj._revert_leak()


@pytest.mark.parametrize("bad", [b"\x00\x01", '{"type": "SET_PWM", "payload": {"t1": 1' + "0" * 400 + "}}", "[" * 200_000],
                         ids=["binary", "huge-int", "deep"])
def test_command_channel_survives(bad):
    from . import test_regression_legacy_ws as legacy

    with TestClient(legacy.main.app).websocket_connect("/ws/command") as ws:
        ws.send_bytes(bad) if isinstance(bad, bytes) else ws.send_text(bad)
        ws.send_json({"type": "SET_MODE", "mode": "SIMULATION"})
        replies = [ws.receive_json()["type"]]
        if replies == ["ERROR"]:  # the huge integer is a finite number and is clamped instead
            replies.append(ws.receive_json()["type"])
        assert replies[-1] == "MODE_SWITCH_RESULT"
    legacy.main.hal_broker.sim_propulsion.set_pwm(0, 0, 0, 0)


def test_slow_mode_switch_does_not_stall_telemetry(monkeypatch):
    from . import test_regression_legacy_ws as legacy

    main = legacy.main

    def slow(_mode):  # noqa: ANN001
        time.sleep(1.5)
        return {"success": False, "message": "port did not open"}

    monkeypatch.setattr(main.hal_broker, "set_mode", slow)

    class Sock:
        def __init__(self):
            self.sent = asyncio.Event()
            self.n = 0

        async def accept(self):
            pass

        async def receive(self):
            self.n += 1
            if self.n == 1:
                return {"type": "websocket.receive", "text": '{"type": "SET_MODE", "mode": "HARDWARE"}'}
            return {"type": "websocket.disconnect", "code": 1000}

        async def receive_text(self):
            return (await self.receive())["text"] if self.n == 0 else await asyncio.sleep(99)

        async def send_json(self, _m):  # noqa: ANN001
            self.sent.set()

    async def go() -> float:
        sock = Sock()
        task = asyncio.create_task(main.command_endpoint(sock))
        worst = 0.0
        while not sock.sent.is_set():
            t = time.monotonic()
            await asyncio.sleep(0.02)
            worst = max(worst, time.monotonic() - t)
        task.cancel()
        return worst

    assert asyncio.run(go()) < 0.5


@pytest.mark.parametrize("good_frames", [0, 5])
def test_pi_bench_never_logs_random_frames_as_camera(tmp_path, monkeypatch, good_frames):
    import pi_bench

    seen = []

    class Cap:
        left = good_frames

        def __init__(self, _i):  # noqa: ANN001
            pass

        def isOpened(self):  # noqa: N802
            return True

        def read(self):
            Cap.left -= 1
            return (True, np.ones((4, 4, 3), np.uint8)) if Cap.left >= 0 else (False, None)

    class FakeCv2:
        VideoCapture = Cap

    out = tmp_path / "log.csv"
    monkeypatch.setitem(sys.modules, "cv2", FakeCv2)
    monkeypatch.setattr(pi_bench, "load", lambda *_a: lambda frame: (seen.append(frame.shape), time.sleep(0.01)))
    monkeypatch.setattr(sys, "argv", ["pi_bench.py", "--model", "m.onnx", "--seconds", "0.3", "--out", str(out)])
    pi_bench.main()
    logged = seen[3:]  # three warm-up frames
    header = out.read_text().splitlines()[0]
    assert logged and len(set(logged)) == 1, "camera and random frames are mixed in one log"
    assert ("source=camera" in header) == (logged[0] == (4, 4, 3))
