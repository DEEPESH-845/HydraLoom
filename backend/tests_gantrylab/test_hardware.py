"""Compute profiles: measured, estimated and simulated values stay labelled and separate."""

from __future__ import annotations

import pytest

from gantrylab.hardware import RPI4, RPI5, estimate_latency_ms, hardware_blocks, list_profiles


def test_estimated_values_are_labelled_estimated():
    blocks = {b.profile: b for b in hardware_blocks(executed_device="cpu", measured_p50_ms=40.0, budget_fps=10.0,
                                                    gflops=8.7, gflops_imgsz=640, imgsz=640, mock=False)}
    assert blocks["host-cpu"].kind == "measured" and blocks["host-cpu"].latency_ms_p50 == 40.0
    assert blocks["host-cpu"].meets_budget is True
    assert blocks["host-gpu"].kind == "measured" and blocks["host-gpu"].latency_ms_p50 is None
    for pid, target in (("rpi4", RPI4), ("rpi5", RPI5)):
        b = blocks[pid]
        assert b.kind == "estimated"
        assert any("ASSUMPTION" in a for a in b.assumptions)
        assert any("ESTIMATE ONLY" in a for a in b.assumptions)
        assert b.latency_ms_p50 == pytest.approx(8.7 / target.effective_gflops * 1000 + target.overhead_ms, abs=0.01)
        # Never derived from the measured host value.
        assert b.latency_ms_p50 != 40.0


def test_estimate_scales_with_imgsz_squared():
    base = estimate_latency_ms(RPI4, 8.0, 640, 640) - RPI4.overhead_ms
    double = estimate_latency_ms(RPI4, 8.0, 640, 1280) - RPI4.overhead_ms
    assert double == pytest.approx(4 * base)


def test_no_gflops_means_no_estimate():
    blocks = {b.profile: b for b in hardware_blocks(executed_device="cpu", measured_p50_ms=10.0, budget_fps=5.0,
                                                    gflops=None, gflops_imgsz=None, imgsz=640, mock=False)}
    assert blocks["rpi4"].kind == "estimated" and blocks["rpi4"].latency_ms_p50 is None
    assert blocks["rpi4"].meets_budget is None


def test_mock_host_values_are_simulated_not_measured():
    blocks = {b.profile: b for b in hardware_blocks(executed_device=None, measured_p50_ms=None, budget_fps=10.0,
                                                    gflops=8.7, gflops_imgsz=640, imgsz=640, mock=True)}
    assert blocks["host-cpu"].kind == "simulated" and blocks["host-cpu"].latency_ms_p50 is None
    assert blocks["rpi5"].kind == "estimated"


def test_profile_listing():
    profiles = {p.id: p for p in list_profiles()}
    assert set(profiles) == {"host-cpu", "host-gpu", "rpi4", "rpi5"}
    assert profiles["host-cpu"].kind == "measured" and profiles["host-cpu"].available
    assert profiles["rpi4"].kind == "estimated" and profiles["rpi4"].effective_gflops == RPI4.effective_gflops
