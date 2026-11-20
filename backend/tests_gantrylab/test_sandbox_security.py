"""The restricted unpickler and the sandbox must reject malicious checkpoints without executing them."""

from __future__ import annotations

import io
import pickle
import sys
import zipfile
from pathlib import Path

import pytest

from gantrylab.sandbox.restricted_pickle import DisallowedGlobal, safe_loads

from .conftest import upload_model, wait_for


def pt_zip(pkl: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("archive/data.pkl", pkl)
        zf.writestr("archive/version", b"3\n")
    return buf.getvalue()


def _s(text: str) -> bytes:
    """Protocol-0 string literal."""
    return b"S" + repr(text).encode() + b"\n"


def payloads(marker: Path) -> dict[str, bytes]:
    m = str(marker)
    py = sys.executable
    return {
        # os.system("<python> -c open(marker).write")
        "os.system": b"cos\nsystem\n(" + _s(f'"{py}" -c "open(r\'{m}\', \'w\').write(\'pwned\')"') + b"tR.",
        "nt.system": b"cnt\nsystem\n(" + _s(f'"{py}" -c "open(r\'{m}\', \'w\').write(\'pwned\')"') + b"tR.",
        "posix.system": b"cposix\nsystem\n(" + _s("touch /tmp/pwned") + b"tR.",
        "builtins.eval": b"cbuiltins\neval\n(" + _s(f"open(r'{m}', 'w').write('pwned')") + b"tR.",
        "builtins.exec": b"c__builtin__\nexec\n(" + _s(f"open(r'{m}', 'w').write('pwned')") + b"tR.",
        "subprocess.Popen": (b"csubprocess\nPopen\n((lp0\n" + _s(py) + b"a" + _s("-c") + b"a"
                             + _s(f"open(r'{m}', 'w').write('pwned')") + b"atR."),
        "builtins.getattr": b"cbuiltins\ngetattr\n(cbuiltins\ndict\n" + _s("keys") + b"tR.",
        "nested_in_ordereddict": (b"ccollections\nOrderedDict\n)R(" + _s("x") + b"cos\nsystem\n("
                                  + _s("echo pwned") + b"tRu."),
        "torch.save": b"ctorch\nsave\n(" + _s("x") + _s(m) + b"tR.",
        "importlib": b"cimportlib\nimport_module\n(" + _s("os") + b"tR.",
    }


@pytest.mark.parametrize("name", list(payloads(Path("x")).keys()))
def test_restricted_unpickler_blocks(name: str, tmp_path: Path):
    marker = tmp_path / "marker.txt"
    with pytest.raises(DisallowedGlobal):
        safe_loads(payloads(marker)[name])
    assert not marker.exists()


def test_reduce_on_allowlisted_module_class_is_blocked():
    # DetectionModel is an allowlisted global (needed for NEWOBJ) but calling it runs __init__,
    # so REDUCE on it must be refused.
    payload = b"cultralytics.nn.tasks\nDetectionModel\n(" + _s("yolov8n.yaml") + b"tR."
    with pytest.raises(DisallowedGlobal, match="call allowlist"):
        safe_loads(payload)


def test_rebuild_from_type_wrapper_checks_function():
    payload = (b"ctorch._tensor\n_rebuild_from_type_v2\n(cultralytics.nn.tasks\nDetectionModel\n"
               b"ctorch\nTensor\n(" + _s("yolov8n.yaml") + b"t}tR.")
    with pytest.raises(DisallowedGlobal):
        safe_loads(payload)


def test_benign_containers_load():
    data = {"a": [1, 2.5, (3, "x")], "b": {1, 2}, "c": frozenset({3}), "d": b"bytes", "e": None, "f": True}
    assert safe_loads(pickle.dumps(data, protocol=2)) == data
    assert safe_loads(pickle.dumps(data, protocol=4)) == data


def test_torch_load_with_restricted_module_rejects(tmp_path: Path):
    torch = pytest.importorskip("torch")
    from gantrylab.sandbox.restricted_pickle import restricted_pickle_module

    marker = tmp_path / "marker.txt"
    blob = pt_zip(payloads(marker)["os.system"])
    with pytest.raises(DisallowedGlobal):
        torch.load(io.BytesIO(blob), weights_only=False, pickle_module=restricted_pickle_module)
    assert not marker.exists()


def test_yolov8n_loads_through_restricted_unpickler():
    torch = pytest.importorskip("torch")
    from gantrylab.sandbox.restricted_pickle import restricted_pickle_module

    from .conftest import YOLOV8N

    if not YOLOV8N.exists():
        pytest.skip("yolov8n.pt not present")
    ckpt = torch.load(str(YOLOV8N), map_location="cpu", weights_only=False, pickle_module=restricted_pickle_module)
    assert type(ckpt["model"]).__name__ == "DetectionModel"
    assert len(ckpt["model"].names) == 80


def test_sandbox_rejects_malicious_upload_end_to_end(make_client, tmp_path: Path):
    """Upload through the HTTP API with the REAL sandbox inspector. The payload must never run."""
    client = make_client(inspector=None)
    for name in ("os.system", "builtins.eval", "subprocess.Popen", "nested_in_ordereddict"):
        marker = tmp_path / f"marker-{name}.txt"
        blob = pt_zip(payloads(marker)[name])
        r = upload_model(client, blob, f"evil-{name.replace('.', '-')}.pt")
        assert r.status_code == 201, r.text
        mid = r.json()["id"]
        rec = wait_for(lambda: (m := client.get(f"/api/v1/models/{mid}").json())["status"] != "pending" and m,
                       timeout=180)
        assert rec["status"] == "rejected", rec
        assert "Disallowed pickle" in rec["status_reason"], rec["status_reason"]
        assert not marker.exists(), f"payload {name} executed"


def test_sandbox_env_is_scrubbed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from gantrylab.sandbox.runner import SandboxLimits, run_sandboxed

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-leak")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("SOME_SERVICE_TOKEN", "t0k3n")
    monkeypatch.setenv("DB_SECRET", "s3cr3t")
    res = run_sandboxed("selftest", {}, SandboxLimits(timeout_s=60, memory_mb=2048), tmp_root=tmp_path)
    assert res.ok, res.error
    keys = set(res.result["env_keys"])
    assert not any(k.endswith(("_KEY", "_TOKEN", "_SECRET")) for k in keys), keys
    assert "ANTHROPIC_API_KEY" not in keys
    assert res.result["cwd_entries"] == []


def test_sandbox_timeout_kills_worker(tmp_path: Path):
    from gantrylab.sandbox.runner import SandboxLimits, run_sandboxed

    res = run_sandboxed("selftest-sleep", {"seconds": 60}, SandboxLimits(timeout_s=3, memory_mb=2048), tmp_root=tmp_path)
    assert not res.ok and res.timed_out
    assert "timeout" in res.error
    assert res.wall_s < 30


def test_sandbox_memory_limit(tmp_path: Path):
    from gantrylab.sandbox.runner import SandboxLimits, run_sandboxed

    ok = run_sandboxed("selftest-alloc", {"mb": 64}, SandboxLimits(timeout_s=60, memory_mb=1024), tmp_root=tmp_path)
    assert ok.ok, ok.error
    res = run_sandboxed("selftest-alloc", {"mb": 1500}, SandboxLimits(timeout_s=60, memory_mb=512), tmp_root=tmp_path)
    assert not res.ok
    assert res.result is None


def test_sandbox_blocks_child_processes(tmp_path: Path):
    from gantrylab.sandbox.runner import SandboxLimits, run_sandboxed

    res = run_sandboxed("selftest-spawn", {}, SandboxLimits(timeout_s=60, memory_mb=2048), tmp_root=tmp_path)
    assert res.ok, res.error
    assert res.result["spawned"] is False
    assert "sandbox blocked" in res.result["error"]
    if sys.platform == "win32":
        # Without the audit hook the Job Object active-process limit still refuses the child.
        raw = run_sandboxed("selftest-spawn-raw", {}, SandboxLimits(timeout_s=60, memory_mb=2048), tmp_root=tmp_path)
        assert raw.ok, raw.error
        assert raw.result["spawned"] is False, raw.result
