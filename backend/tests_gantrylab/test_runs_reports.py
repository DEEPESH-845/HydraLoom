"""End-to-end mock runs through the HTTP API, reports, LLM fallback, patches, ask and compare."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gantrylab.llm import ProviderError
from gantrylab.schemas import EngineeringReport, RunMetrics

from .conftest import make_dataset, run_mock, upload_dataset, wait_for

MOCK = "MOCK ADAPTER - not a real model evaluation"


@pytest.fixture
def mock_run(client, ready_model, dataset) -> dict:
    run = run_mock(client, ready_model["id"], dataset["id"])
    assert run["status"] == "complete", run
    return run


def test_mock_run_end_to_end(client, mock_run, ready_model, dataset):
    run = mock_run
    assert run["mock"] is True and run["adapter"] == "mock" and run["progress"] == 1.0
    assert MOCK in run["warnings"]
    assert run["model"]["sha256"] == ready_model["sha256"]
    assert run["dataset"]["manifest_sha256"] == dataset["manifest_sha256"]
    m = client.get(f"/api/v1/runs/{run['id']}/metrics").json()
    RunMetrics.model_validate(m)
    assert m["mock"] is True and m["banner"] == MOCK
    assert m["latency"]["kind"] == "not_measured" and m["latency"]["total_ms"]["p50"] is None
    assert m["hardware"]["kind"] == "simulated"
    assert m["overall"]["n_gt"] == dataset["n_annotations"]
    assert 0 <= m["overall"]["recall"] <= 1
    est = [b for b in m["hardware_profiles"] if b["kind"] == "estimated"]
    assert {b["profile"] for b in est} == {"rpi4", "rpi5"}
    preds = client.get(f"/api/v1/runs/{run['id']}/predictions").json()
    assert len(preds["frames"]) == dataset["n_frames"] and preds["mock"] is True
    data_dir: Path = client.app.state.gl.settings.data_dir
    for f in ("run.json", "metrics.json", "predictions.json"):
        assert (data_dir / "runs" / run["id"] / f).exists()
    assert run["id"] in [r["id"] for r in client.get("/api/v1/runs").json()["runs"]]


def test_mock_run_is_deterministic(client, ready_model, dataset):
    a = run_mock(client, ready_model["id"], dataset["id"])
    b = run_mock(client, ready_model["id"], dataset["id"])
    ma = client.get(f"/api/v1/runs/{a['id']}/metrics").json()
    mb = client.get(f"/api/v1/runs/{b['id']}/metrics").json()
    assert ma["overall"] == mb["overall"]
    cmp = client.get(f"/api/v1/compare?runs={a['id']},{b['id']}").json()
    assert cmp["comparison_type"] == "repeat"
    assert cmp["overall_deltas"]["recall"]["delta"] == 0
    assert any("MOCK" in n for n in cmp["notes"])


def test_websocket_events(client, ready_model, dataset):
    body = {"model_id": ready_model["id"], "dataset_id": dataset["id"], "adapter": "mock"}
    rid = client.post("/api/v1/runs", json=body).json()["id"]
    events = []
    with client.websocket_connect(f"/api/v1/runs/{rid}/events") as ws:
        while True:
            try:
                ev = ws.receive_json()
            except Exception:
                break
            events.append(ev)
            if ev["type"] in ("complete", "failed"):
                break
    assert events, "no events"
    assert events[-1]["type"] == "complete" and events[-1]["progress"] == 1.0
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(seqs)


def test_run_validation(client, ready_model, dataset):
    r = client.post("/api/v1/runs", json={"model_id": ready_model["id"], "dataset_id": "ds_missing", "adapter": "mock"})
    assert r.status_code == 404
    r = client.post("/api/v1/runs", json={"model_id": ready_model["id"], "dataset_id": dataset["id"],
                                          "config": {"class_map": {"NOT_A_MODEL_CLASS": "MINE"}}})
    assert r.status_code == 400
    r = client.post("/api/v1/runs", json={"model_id": ready_model["id"], "dataset_id": dataset["id"],
                                          "config": {"class_map": {"MINE": "WHALE"}}})
    assert r.status_code == 400
    r = client.post("/api/v1/runs", json={"model_id": ready_model["id"], "dataset_id": dataset["id"],
                                          "config": {"imgsz": 650}})
    assert r.status_code == 422
    r = client.post("/api/v1/runs", json={"model_id": ready_model["id"], "dataset_id": dataset["id"],
                                          "config": {"compute_profile": "jetson"}})
    assert r.status_code == 400
    assert client.get("/api/v1/runs/run_nope").status_code == 404


def test_report_deterministic(client, mock_run):
    r = client.post(f"/api/v1/runs/{mock_run['id']}/report", json={})
    assert r.status_code == 201, r.text
    rep = r.json()
    EngineeringReport.model_validate(rep)
    assert rep["provider"] == "deterministic" and rep["fallback"] is False
    assert rep["mock"] is True and rep["banner"] == MOCK
    assert MOCK in rep["disclaimers"]
    assert MOCK in rep["executive_summary"]["overall"]
    assert len(rep["evidence_hash"]) == 64
    m = client.get(f"/api/v1/runs/{mock_run['id']}/metrics").json()
    hm = rep["executive_summary"]["headline_metrics"]
    assert hm["recall"] == m["overall"]["recall"] and hm["map50"] == m["overall"]["map50"]
    assert rep["number_check"]["replaced"] == []
    evidence_ids = set(client.get(f"/api/v1/reports/{rep['id']}/export.json").json()["evidence"]["items"])
    for rec in rep["recommendations"]:
        assert rec["evidence_refs"] and set(rec["evidence_refs"]) <= evidence_ids
    for s in rep["config_suggestions"]:
        assert set(s["evidence"]) <= evidence_ids
        assert "improved weights" not in s["expected_benefit"].lower()
    data_dir: Path = client.app.state.gl.settings.data_dir
    assert (data_dir / "reports" / f"{rep['id']}.json").exists()
    assert client.get(f"/api/v1/reports/{rep['id']}").json()["id"] == rep["id"]
    html = client.get(f"/api/v1/reports/{rep['id']}/export.html")
    assert html.status_code == 200 and MOCK in html.text and "@media print" in html.text
    assert "<script" not in html.text.lower()
    assert client.get(f"/api/v1/reports?run_id={mock_run['id']}").json()["reports"][0]["id"] == rep["id"]


def test_report_requires_complete_run(client, ready_model, dataset):
    rid = client.post("/api/v1/runs", json={"model_id": ready_model["id"], "dataset_id": dataset["id"],
                                            "adapter": "mock"}).json()["id"]
    r = client.post(f"/api/v1/runs/{rid}/report", json={})
    assert r.status_code in (201, 409)


def test_report_never_sends_images_or_weights(client, mock_run, monkeypatch):
    captured = {}

    def fake_complete(self, system, user, timeout_s):
        captured["user"] = user
        raise ProviderError("boom")

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-1234567890")
    monkeypatch.setattr("gantrylab.llm.providers.AnthropicProvider.complete", fake_complete)
    rep = client.post(f"/api/v1/runs/{mock_run['id']}/report", json={"provider": "anthropic"}).json()
    assert rep["fallback"] is True and rep["provider"] == "deterministic"
    assert "anthropic failed" in rep["fallback_reason"]
    user = captured["user"]
    assert "sk-ant-test-key" not in user and "sk-ant-test-key" not in json.dumps(rep)
    assert "original.pt" not in user and "base64" not in user.lower()
    assert "\\x89PNG" not in user and "IHDR" not in user


def test_llm_fallback_on_provider_error(client, mock_run, monkeypatch):
    calls = {"n": 0}

    def boom(self, system, user, timeout_s):
        calls["n"] += 1
        raise ProviderError("HTTP 529 overloaded")

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-x")
    monkeypatch.setattr("gantrylab.llm.providers.AnthropicProvider.complete", boom)
    rep = client.post(f"/api/v1/runs/{mock_run['id']}/report", json={"provider": "auto"}).json()
    EngineeringReport.model_validate(rep)
    assert calls["n"] == 1
    assert rep["fallback"] is True and rep["provider"] == "deterministic" and "529" in rep["fallback_reason"]


def test_llm_invalid_json_retry_then_fallback(client, mock_run, monkeypatch):
    calls = {"n": 0}

    def garbage(self, system, user, timeout_s):
        calls["n"] += 1
        return "I think the model is great!"

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr("gantrylab.llm.providers.OpenAIProvider.complete", garbage)
    rep = client.post(f"/api/v1/runs/{mock_run['id']}/report", json={"provider": "openai"}).json()
    assert calls["n"] == 2  # one repair retry
    assert rep["fallback"] is True and "invalid JSON" in rep["fallback_reason"]


def test_llm_numbers_are_verified(client, mock_run, monkeypatch):
    """A valid LLM response whose narrative invents numbers gets those fields replaced."""

    def fake(self, system, user, timeout_s):
        ev = json.loads(user.split("EVIDENCE:\n", 1)[1].split("\n\nCANDIDATE_RECOMMENDATIONS", 1)[0])
        recall = ev["items"]["overall"]["recall"]
        return json.dumps({
            "overall": f"MOCK ADAPTER run. Recall was {recall:.3f}.",
            "key_findings": [{"text": "Recall reached 0.987 in every condition.", "evidence_refs": ["overall"]},
                             {"text": f"Overall recall {recall:.3f}.", "evidence_refs": ["overall", "bogus:ref"]}],
            "performance_breakdown": "Precision was 0.123456 which is invented.",
            "environmental_sensitivity": "See evidence.",
            "failure_analysis": "See evidence.",
            "conditions": "See evidence.",
            "hardware_suitability": "See evidence.",
            "recommendations": [{"priority": 1, "action": "Do X", "rationale": "Because.", "evidence_refs": ["nope"]}],
            "next_experiment_rationale": "Repeat with more frames.",
            "config_suggestion_rationales": {},
        })

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-x")
    monkeypatch.setattr("gantrylab.llm.providers.AnthropicProvider.complete", fake)
    rep = client.post(f"/api/v1/runs/{mock_run['id']}/report", json={"provider": "anthropic"}).json()
    assert rep["provider"] == "anthropic" and rep["fallback"] is False
    replaced = {r["field"] for r in rep["number_check"]["replaced"]}
    assert "performance_breakdown" in replaced and "key_findings[0]" in replaced and "recommendations[0]" in replaced
    body = json.dumps({k: v for k, v in rep.items() if k != "number_check"})
    assert "0.123456" not in body and "0.987" not in body
    kf = rep["executive_summary"]["key_findings"]
    assert len(kf) == 1 and kf[0]["evidence_refs"] == ["overall"]
    # Recommendations without valid refs are dropped, deterministic ones are used instead.
    assert all(r["evidence_refs"] for r in rep["recommendations"])
    assert rep["executive_summary"]["overall"].startswith("MOCK ADAPTER")


def test_patches_leave_originals_unchanged(client, mock_run):
    hyp = "# my training hyperparameters\nlr0: 0.01\nhsv_v: 0.4  # brightness\nmosaic: 1.0\n"
    inf = "conf: 0.25\niou: 0.7\nimgsz: 640\n"
    rep = client.post(f"/api/v1/runs/{mock_run['id']}/report",
                      json={"user_files": {"hyp.yaml": hyp, "inference.yaml": inf}}).json()
    assert rep["user_files_provided"] == ["hyp.yaml", "inference.yaml"]
    stored = client.app.state.gl.settings.reports_dir / rep["id"] / "inputs"
    for name, text in (("hyp.yaml", hyp), ("inference.yaml", inf), ("data.yaml", None)):
        p = client.get(f"/api/v1/reports/{rep['id']}/patches/{name}")
        assert p.status_code == 200, p.text
        body = p.json()
        if text is not None:
            assert body["original"] == text and body["original_source"] == "user_file"
            assert (stored / name).read_text(encoding="utf-8") == text  # original never rewritten
            import yaml

            patched = yaml.safe_load(body["patched"])
            for s in rep["config_suggestions"]:
                if s["file"] == name and s["patchable"]:
                    assert patched[s["key"]] == s["suggested"]
                    assert s["id"] in body["applied_suggestions"]
            if body["applied_suggestions"]:
                assert body["diff"].startswith("--- a/" + name)
            assert "# my training hyperparameters" in body["patched"] or name != "hyp.yaml"
        else:
            assert body["original_source"] == "empty"
    for s in rep["config_suggestions"]:
        if s["file"] == "hyp.yaml" and s["key"] == "hsv_v":
            assert s["original"] == 0.4 and s["original_source"] == "user_file"
    assert client.get(f"/api/v1/reports/{rep['id']}/patches/evil.yaml").status_code == 404


@pytest.mark.parametrize("question,expect_ref_prefix", [
    ("Which condition degraded performance most?", "slice:"),
    ("Which class failed the most?", "class:"),
    ("Which config should I test next?", ""),
    ("Can this run on a Raspberry Pi 5 in real time?", "hardware:"),
    ("Tell me a joke", "overall"),
])
def test_ask_deterministic(client, mock_run, question, expect_ref_prefix):
    rep = client.post(f"/api/v1/runs/{mock_run['id']}/report", json={}).json()
    a = client.post(f"/api/v1/reports/{rep['id']}/ask", json={"question": question})
    assert a.status_code == 200, a.text
    body = a.json()
    assert body["answer"] and body["uncertainty"] and body["evidence_refs"]
    assert body["mock"] is True and body["provider"] == "deterministic"
    assert any(r.startswith(expect_ref_prefix) for r in body["evidence_refs"])


def test_ask_llm_fallback(client, mock_run, monkeypatch):
    rep = client.post(f"/api/v1/runs/{mock_run['id']}/report", json={}).json()

    def boom(self, system, user, timeout_s):
        raise ProviderError("timeout")

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-x")
    monkeypatch.setattr("gantrylab.llm.providers.AnthropicProvider.complete", boom)
    a = client.post(f"/api/v1/reports/{rep['id']}/ask", json={"question": "Which class failed?"}).json()
    assert a["fallback"] is True and a["provider"] == "deterministic" and a["evidence_refs"]


def test_compare_environments(client, ready_model):
    m1, f1 = make_dataset(20, seed=1, environment_cycle=("harbor",))
    m2, f2 = make_dataset(20, seed=2, name="reef sweep", environment_cycle=("reef",))
    d1 = upload_dataset(client, m1, f1).json()
    d2 = upload_dataset(client, m2, f2).json()
    a = run_mock(client, ready_model["id"], d1["id"])
    b = run_mock(client, ready_model["id"], d2["id"])
    cmp = client.get(f"/api/v1/compare?runs={a['id']},{b['id']}")
    assert cmp.status_code == 200, cmp.text
    body = cmp.json()
    assert body["comparison_type"] == "environments"
    assert {s["id"] for s in body["slice_deltas"]} >= {"slice:environment:harbor", "slice:environment:reef"}
    assert client.get(f"/api/v1/compare?runs={a['id']}").status_code == 400


def test_health_and_profiles(client):
    h = client.get("/api/v1/health").json()
    assert h["status"] == "ok" and h["adapters"]["mock"] is True
    assert h["llm_providers"]["deterministic"] is True and h["llm_providers"]["anthropic"] is False
    assert "sk-" not in json.dumps(h)
    profiles = {p["id"]: p for p in client.get("/api/v1/compute-profiles").json()["profiles"]}
    assert profiles["host-cpu"]["kind"] == "measured"
    assert profiles["rpi4"]["kind"] == "estimated" and profiles["rpi5"]["kind"] == "estimated"
    assert any("ESTIMATE ONLY" in a for a in profiles["rpi4"]["assumptions"])


def test_cors_allows_frontend(client):
    r = client.options("/api/v1/health", headers={"Origin": "http://localhost:3000",
                                                 "Access-Control-Request-Method": "GET"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"
    r = client.options("/api/v1/health", headers={"Origin": "http://evil.example",
                                                 "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in r.headers


def test_restart_recovery(make_client, ready_model, dataset, client):
    # A run left "running" by a crashed process is marked failed on the next start-up.
    data_dir = client.app.state.gl.settings.data_dir
    run = run_mock(client, ready_model["id"], dataset["id"])
    p = data_dir / "runs" / run["id"] / "run.json"
    raw = json.loads(p.read_text())
    raw["status"] = "running"
    p.write_text(json.dumps(raw))
    from gantrylab.app import create_app
    from fastapi.testclient import TestClient

    with TestClient(create_app(data_dir=data_dir)) as c2:
        rec = c2.get(f"/api/v1/runs/{run['id']}").json()
        assert rec["status"] == "failed" and "restart" in rec["error"]


def test_deterministic_intents_and_unique_refs():
    from gantrylab.reports.service import INTENTS, _uniq

    def intent(q):
        return next((name for name, pat in INTENTS if pat.search(q)), None)

    assert intent("Which environmental parameter caused the largest degradation?") == "condition"
    assert intent("Why did my model fail in the harbor?") == "condition"
    assert intent("Which training configuration should I test next?") == "config"
    assert intent("Which classes were confused?") == "confusion"
    assert _uniq(["a", "b", "a"]) == ["a", "b"]
