"""Model upload validation, immutability, dedupe and versioning."""

from __future__ import annotations

import hashlib
from pathlib import Path

from gantrylab.storage import is_read_only

from .conftest import fake_pt_bytes, upload_model, wait_for


def test_rejects_bad_extension(client):
    r = upload_model(client, fake_pt_bytes(), "model.pkl")
    assert r.status_code == 400 and "extension" in r.json()["detail"]
    r = upload_model(client, fake_pt_bytes(), "model")
    assert r.status_code == 400


def test_rejects_bad_magic(client):
    r = upload_model(client, b"hello world, not a zip", "model.pt")
    assert r.status_code == 400 and "magic" in r.json()["detail"]
    r = upload_model(client, b"\x00\x01garbage", "model.onnx")
    assert r.status_code == 400 and "ONNX" in r.json()["detail"]


def test_rejects_legacy_pickle(client):
    import pickle

    r = upload_model(client, pickle.dumps({"model": 1}, protocol=2), "legacy.pt")
    assert r.status_code == 400 and "legacy" in r.json()["detail"]


def test_rejects_zip_without_data_pkl(client):
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("archive/other.bin", b"x")
    r = upload_model(client, buf.getvalue(), "nodata.pt")
    assert r.status_code == 400 and "data.pkl" in r.json()["detail"]


def test_rejects_path_traversal_and_control_names(client):
    for bad in ("../evil.pt", "..\\evil.pt", "dir/evil.pt", "evil\x01.pt"):
        r = upload_model(client, fake_pt_bytes(), bad)
        assert r.status_code == 400, bad
    r = upload_model(client, fake_pt_bytes(), "ok.pt", name="../../etc")
    assert r.status_code == 400


def test_rejects_empty_and_oversize(make_client):
    c = make_client(GANTRYLAB_MAX_MODEL_MB="1")
    r = upload_model(c, b"", "empty.pt")
    assert r.status_code == 400
    big = b"PK\x03\x04" + b"\0" * (3 * 1024 * 1024)
    r = upload_model(c, big, "big.pt")
    assert r.status_code == 413  # rejected from Content-Length before reading the body
    slightly_big = b"PK\x03\x04" + b"\0" * (1024 * 1024 + 512 * 1024)
    r = upload_model(c, slightly_big, "big.pt")
    assert r.status_code == 413  # rejected mid-stream by the per-file byte counter
    assert "exceeds" in r.json()["detail"]
    tmp = c.app.state.gl.settings.tmp_dir
    assert not any(tmp.glob("upload-*.part")), "partial upload left on disk"
    assert c.get("/api/v1/models").json()["models"] == []


def test_upload_stores_immutable_original_and_dedupes(client):
    content = fake_pt_bytes("immutable")
    sha = hashlib.sha256(content).hexdigest()
    r = upload_model(client, content, "detector.pt")
    assert r.status_code == 201, r.text
    rec = r.json()
    assert rec["id"] == sha and rec["sha256"] == sha and rec["version"] == 1 and rec["format"] == "pt"
    data_dir: Path = client.app.state.gl.settings.data_dir
    path = data_dir / rec["storage_path"]
    assert path == data_dir / "models" / sha / "original.pt"
    assert path.read_bytes() == content
    assert is_read_only(path)
    wait_for(lambda: client.get(f"/api/v1/models/{sha}").json()["status"] == "ready")
    # Same bytes again: existing record, no new version, file untouched.
    r2 = upload_model(client, content, "renamed.pt", name="something-else")
    assert r2.status_code == 200
    assert r2.json()["id"] == sha and r2.json()["deduplicated"] is True and r2.json()["name"] == "detector"
    assert path.read_bytes() == content
    assert len(client.get("/api/v1/models").json()["models"]) == 1


def test_same_name_creates_new_version(client):
    a = upload_model(client, fake_pt_bytes("v1"), "harbor.pt").json()
    b = upload_model(client, fake_pt_bytes("v2"), "harbor.pt").json()
    assert a["version"] == 1 and b["version"] == 2 and a["id"] != b["id"]
    rec = wait_for(lambda: (m := client.get(f"/api/v1/models/{b['id']}").json())["status"] == "ready" and m)
    assert [v["version"] for v in rec["versions"]] == [1, 2]
    assert rec["inspection"]["names"]["0"] == "SHIPWRECK"


def test_inspection_rejection_is_recorded(make_client):
    def reject(path, fmt):
        from gantrylab.services.models import InspectionRejected

        raise InspectionRejected("Disallowed pickle global os.system")

    c = make_client(inspector=reject)
    rec = upload_model(c, fake_pt_bytes("bad"), "bad.pt").json()
    rec = wait_for(lambda: (m := c.get(f"/api/v1/models/{rec['id']}").json())["status"] != "pending" and m)
    assert rec["status"] == "rejected" and "os.system" in rec["status_reason"]


def test_unknown_model_404(client):
    assert client.get("/api/v1/models/" + "0" * 64).status_code == 404
    assert client.get("/api/v1/models/../../etc").status_code == 404
