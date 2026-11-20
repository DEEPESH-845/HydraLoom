"""Dataset manifest validation, storage and YOLO / COCO export correctness."""

from __future__ import annotations

import copy
import io
import json
import zipfile

import pytest
import yaml

from .conftest import CLASSES, make_dataset, png_bytes, upload_dataset


def test_upload_and_detail(client):
    manifest, files = make_dataset(8)
    r = upload_dataset(client, manifest, files)
    assert r.status_code == 201, r.text
    rec = r.json()
    assert rec["schema"] == "gantrylab.dataset/1" and rec["n_frames"] == 8 and rec["classes"] == CLASSES
    assert rec["conditions"]["turbidity"]["type"] == "numeric"
    assert set(rec["conditions"]["environment"]["values"]) == {"harbor", "reef"}
    n_ann = sum(len(f["annotations"]) for f in manifest["frames"])
    assert rec["n_annotations"] == n_ann
    d = client.get(f"/api/v1/datasets/{rec['id']}").json()
    assert len(d["frames"]) == 8
    assert client.get("/api/v1/datasets").json()["datasets"][0]["id"] == rec["id"]
    img = client.get(f"/api/v1/datasets/{rec['id']}/frames/000001.png")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    assert img.content == files[0][1]


def test_yolo_export_is_correct(client):
    manifest, files = make_dataset(3, width=320, height=240)
    ds = upload_dataset(client, manifest, files).json()
    z = client.get(f"/api/v1/datasets/{ds['id']}/export/yolo.zip")
    assert z.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    names = set(zf.namelist())
    assert {"data.yaml", "images/000001.png", "labels/000001.txt"} <= names
    data_yaml = yaml.safe_load(zf.read("data.yaml"))
    assert data_yaml["nc"] == 5 and data_yaml["names"][1] == "MINE"
    frame = manifest["frames"][0]
    lines = zf.read("labels/000001.txt").decode().strip().splitlines()
    assert len(lines) == len(frame["annotations"])
    for line, ann in zip(lines, frame["annotations"]):
        cls, cx, cy, w, h = line.split()
        x, y, bw, bh = ann["bbox_xywh"]
        assert int(cls) == CLASSES.index(ann["class_name"])
        assert float(cx) == pytest.approx((x + bw / 2) / 320, abs=1e-6)
        assert float(cy) == pytest.approx((y + bh / 2) / 240, abs=1e-6)
        assert float(w) == pytest.approx(bw / 320, abs=1e-6)
        assert float(h) == pytest.approx(bh / 240, abs=1e-6)


def test_coco_export_is_correct(client):
    manifest, files = make_dataset(4)
    ds = upload_dataset(client, manifest, files).json()
    coco = client.get(f"/api/v1/datasets/{ds['id']}/export/coco.json").json()
    assert [c["name"] for c in coco["categories"]] == CLASSES
    assert [c["id"] for c in coco["categories"]] == [1, 2, 3, 4, 5]
    assert len(coco["images"]) == 4
    n_ann = sum(len(f["annotations"]) for f in manifest["frames"])
    assert len(coco["annotations"]) == n_ann
    a0 = coco["annotations"][0]
    src = manifest["frames"][0]["annotations"][0]
    assert a0["bbox"] == src["bbox_xywh"] and a0["image_id"] == 1
    assert a0["category_id"] == CLASSES.index(src["class_name"]) + 1
    assert a0["area"] == pytest.approx(src["bbox_xywh"][2] * src["bbox_xywh"][3])
    assert a0["iscrowd"] == 0 and a0["gantrylab"]["object_id"] == src["object_id"]
    assert len({a["id"] for a in coco["annotations"]}) == n_ann


@pytest.mark.parametrize("mutate,needle", [
    (lambda m: m.update(schema="gantrylab.dataset/2"), "schema"),
    (lambda m: m["frames"][0]["annotations"][0].update(class_name="WHALE"), "not in classes"),
    (lambda m: m["frames"][0]["annotations"][0].update(bbox_xywh=[300, 200, 100, 100]), "exceeds image bounds"),
    (lambda m: m["frames"][0]["annotations"][0].update(bbox_xywh=[1, 1, 0, 5]), "width and height"),
    (lambda m: m["frames"][0].update(file="../evil.png"), "plain file name"),
    (lambda m: m["frames"][0].update(file="sub/evil.png"), "plain file name"),
    (lambda m: m["frames"][0].update(file="evil.exe"), "must end with"),
    (lambda m: m.update(classes=["A", "A"]), "unique"),
    (lambda m: m.update(unexpected=1), "Extra inputs"),
    (lambda m: m["frames"][0]["conditions"].update({"bad key!": 1}), "invalid condition key"),
    (lambda m: m["frames"][1].update(file=m["frames"][0]["file"]), "unique"),
])
def test_manifest_validation(client, mutate, needle):
    manifest, files = make_dataset(3)
    m = copy.deepcopy(manifest)
    mutate(m)
    r = upload_dataset(client, m, files)
    assert r.status_code in (400, 422), r.text
    assert needle in json.dumps(r.json()), r.text


def test_files_must_match_manifest(client):
    manifest, files = make_dataset(3)
    r = upload_dataset(client, manifest, files[:2])
    assert r.status_code == 400 and "000003.png" in json.dumps(r.json())
    r = upload_dataset(client, manifest, files + [("extra.png", files[0][1])])
    assert r.status_code == 400 and "extra.png" in json.dumps(r.json())
    r = upload_dataset(client, manifest, [("../000001.png", files[0][1])] + files[1:])
    assert r.status_code == 400


def test_images_must_decode_and_match_size(client):
    manifest, files = make_dataset(2, width=320, height=240)
    bad = [(files[0][0], b"not an image")] + files[1:]
    r = upload_dataset(client, manifest, bad)
    assert r.status_code == 400 and "decode" in r.json()["detail"]
    wrong = [(files[0][0], png_bytes(100, 100, [], 1))] + files[1:]
    r = upload_dataset(client, manifest, wrong)
    assert r.status_code == 400 and "100x100" in r.json()["detail"]
    jpeg_as_png = [(files[0][0], png_bytes(320, 240, [], 1, fmt="JPEG"))] + files[1:]
    r = upload_dataset(client, manifest, jpeg_as_png)
    assert r.status_code == 400 and "JPEG" in r.json()["detail"]
    assert client.get("/api/v1/datasets").json()["datasets"] == []


def test_caps(make_client):
    c = make_client(GANTRYLAB_MAX_DATASET_FRAMES="2", GANTRYLAB_MAX_FRAME_MB="1")
    manifest, files = make_dataset(3)
    r = upload_dataset(c, manifest, files)
    assert r.status_code == 413
    manifest, files = make_dataset(1)
    big = [(files[0][0], b"\x89PNG" + b"\0" * (2 * 1024 * 1024))]
    r = upload_dataset(c, manifest, big)
    assert r.status_code == 413


def test_invalid_manifest_json(client):
    _, files = make_dataset(1)
    r = client.post("/api/v1/datasets", data={"manifest": "{not json"},
                    files=[("files", (files[0][0], files[0][1], "image/png"))])
    assert r.status_code == 422


def test_frame_endpoint_rejects_traversal(client):
    manifest, files = make_dataset(1)
    ds = upload_dataset(client, manifest, files).json()
    assert client.get(f"/api/v1/datasets/{ds['id']}/frames/..%2Fdataset.json").status_code == 404
    assert client.get(f"/api/v1/datasets/{ds['id']}/frames/manifest.json").status_code == 404
    assert client.get("/api/v1/datasets/ds_nope/frames/000001.png").status_code == 404
