"""Deployment behaviour: the write token and request validation errors."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from gantrylab.app import create_app

ORIGIN = {"Origin": "http://localhost:3000"}
BODY = {"model_id": "x", "dataset_id": "y", "adapter": "mock", "seed": 0}


@pytest.fixture()
def secured(tmp_path, monkeypatch):
    monkeypatch.setenv("GANTRYLAB_API_TOKEN", "s3cret")
    with TestClient(create_app(tmp_path)) as client:
        yield client


def test_reads_are_open_and_writes_need_the_token(secured):
    health = secured.get("/api/v1/health")
    assert health.status_code == 200 and health.json()["write_auth"] is True
    assert secured.get("/api/v1/runs").status_code == 200
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "s3cret"}, {"Authorization": "Bearer s3cret "[:-3]}):
        r = secured.post("/api/v1/runs", json=BODY, headers={**ORIGIN, **headers})
        assert r.status_code == 401, headers
        assert r.headers["access-control-allow-origin"] == ORIGIN["Origin"]
    assert secured.post("/api/v1/models", files={"file": ("a.pt", b"x")}).status_code == 401
    assert secured.post("/api/v1/runs", json=BODY, headers={"Authorization": "Bearer s3cret"}).status_code == 404


def test_preflight_passes_without_the_token(secured):
    r = secured.options("/api/v1/runs", headers={**ORIGIN, "Access-Control-Request-Method": "POST",
                                                 "Access-Control-Request-Headers": "authorization,content-type"})
    assert r.status_code == 200
    assert "authorization" in r.headers["access-control-allow-headers"].lower()


def test_no_token_configured_leaves_local_use_open(tmp_path, monkeypatch):
    monkeypatch.delenv("GANTRYLAB_API_TOKEN", raising=False)
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/v1/health").json()["write_auth"] is False
        assert client.post("/api/v1/runs", json=BODY).status_code == 404


@pytest.mark.parametrize("raw", [
    '{"model_id":"x","dataset_id":"y","config":{"conf":NaN}}',
    '{"model_id":"x","dataset_id":"y","config":{"conf":1e999}}',
    '{"model_id":"\\ud800","dataset_id":"y","config":{"conf":"\\ud800"}}',
    "not json",
])
def test_unserialisable_request_values_are_422(tmp_path, raw):
    with TestClient(create_app(tmp_path), raise_server_exceptions=False) as client:
        r = client.post("/api/v1/runs", content=raw, headers={"content-type": "application/json"})
        assert r.status_code == 422
        assert r.json()["detail"]
