"""Compute profiles: measured host profiles and estimated embedded targets.

Measured, estimated and simulated values are kept in separate blocks and are never mixed.
Estimated profiles use a GFLOPs throughput model with explicit, labelled assumption constants.
"""

from __future__ import annotations

import functools
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass

from .schemas import ComputeProfile, HardwareBlock


@dataclass(frozen=True)
class EstimatedTarget:
    id: str
    name: str
    effective_gflops: float
    overhead_ms: float
    assumptions: tuple[str, ...]


# ASSUMPTION constants. They are planning placeholders, not measurements.
# Replace them with a measurement of the exact model on the actual device before relying on them.
RPI4 = EstimatedTarget(
    id="rpi4",
    name="Raspberry Pi 4 Model B (4x Cortex-A72 @ 1.5 GHz, CPU only)",
    effective_gflops=3.0,
    overhead_ms=25.0,
    assumptions=(
        "ASSUMPTION: effective sustained PyTorch FP32 throughput of 3.0 GFLOP/s on 4x Cortex-A72 @ 1.5 GHz "
        "(well below the NEON theoretical peak; framework, memory bandwidth and thermal throttling dominate).",
        "ASSUMPTION: 25 ms fixed per-frame overhead (image decode, resize, Python and NMS).",
        "Model: latency_ms = GFLOPs_at_imgsz / effective_GFLOPs * 1000 + overhead_ms; GFLOPs scale with (imgsz/ref)^2.",
        "No accelerator (Coral / Hailo) assumed. Batch size 1. Active cooling assumed.",
        "ESTIMATE ONLY - never measured. Replace with a measurement on the actual device.",
    ),
)
RPI5 = EstimatedTarget(
    id="rpi5",
    name="Raspberry Pi 5 (4x Cortex-A76 @ 2.4 GHz, CPU only)",
    effective_gflops=10.0,
    overhead_ms=12.0,
    assumptions=(
        "ASSUMPTION: effective sustained PyTorch FP32 throughput of 10.0 GFLOP/s on 4x Cortex-A76 @ 2.4 GHz.",
        "ASSUMPTION: 12 ms fixed per-frame overhead (image decode, resize, Python and NMS).",
        "Model: latency_ms = GFLOPs_at_imgsz / effective_GFLOPs * 1000 + overhead_ms; GFLOPs scale with (imgsz/ref)^2.",
        "No accelerator (AI Kit / Hailo) assumed. Batch size 1. Active cooling assumed.",
        "ESTIMATE ONLY - never measured. Replace with a measurement on the actual device.",
    ),
)
ESTIMATED_TARGETS = {t.id: t for t in (RPI4, RPI5)}


@functools.lru_cache(maxsize=1)
def host_cpu_name() -> str:
    try:
        if os.name == "nt":
            import winreg

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip()
        if os.path.exists("/proc/cpuinfo"):
            with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if line.lower().startswith(("model name", "hardware", "processor\t: arm")):
                        return line.split(":", 1)[1].strip()
        if platform.system() == "Darwin":
            out = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=3)
            if out.stdout.strip():
                return out.stdout.strip()
    except Exception:
        pass
    return platform.processor() or platform.machine() or "unknown CPU"


@functools.lru_cache(maxsize=1)
def gpu_names() -> tuple[str, ...]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return ()
    try:
        out = subprocess.run([exe, "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True,
                             timeout=5)
        return tuple(n.strip() for n in out.stdout.splitlines() if n.strip())
    except Exception:
        return ()


def list_profiles() -> list[ComputeProfile]:
    cpu = host_cpu_name()
    gpus = gpu_names()
    profiles = [
        ComputeProfile(id="host-cpu", name=f"This host - CPU ({cpu})", kind="measured", hardware_name=cpu,
                       available=True, device="cpu", method="measured by executing the run on this host's CPU",
                       assumptions=["Measured values come from the sandbox worker on this host."]),
        ComputeProfile(id="host-gpu", name=f"This host - GPU ({gpus[0] if gpus else 'none detected'})",
                       kind="measured", hardware_name=gpus[0] if gpus else None, available=bool(gpus),
                       device="cuda", method="measured by executing the run on this host's CUDA GPU",
                       assumptions=["Measured values come from the sandbox worker on this host.",
                                    "GPU utilisation is device-wide (nvidia-smi), not per process."]),
    ]
    for t in ESTIMATED_TARGETS.values():
        profiles.append(ComputeProfile(
            id=t.id, name=t.name, kind="estimated", hardware_name=t.name, available=True, device=None,
            method="GFLOPs throughput model (estimate, never measured)", effective_gflops=t.effective_gflops,
            overhead_ms=t.overhead_ms, assumptions=list(t.assumptions)))
    return profiles


def profile_ids() -> set[str]:
    return {"auto", "host-cpu", "host-gpu", *ESTIMATED_TARGETS}


def estimate_latency_ms(target: EstimatedTarget, gflops: float, gflops_imgsz: int, imgsz: int) -> float:
    scaled = gflops * (imgsz / float(gflops_imgsz)) ** 2
    return scaled / target.effective_gflops * 1000.0 + target.overhead_ms


def _fps(lat_ms: float | None) -> float | None:
    return 1000.0 / lat_ms if lat_ms and lat_ms > 0 else None


def hardware_blocks(
    *,
    executed_device: str | None,
    measured_p50_ms: float | None,
    budget_fps: float,
    gflops: float | None,
    gflops_imgsz: int | None,
    imgsz: int,
    mock: bool,
) -> list[HardwareBlock]:
    """One block per profile. Host blocks are measured (or simulated for mock runs); Pi blocks estimated."""
    blocks: list[HardwareBlock] = []
    cpu = host_cpu_name()
    gpus = gpu_names()
    for pid, dev, name in (("host-cpu", "cpu", f"This host - CPU ({cpu})"),
                           ("host-gpu", "cuda", f"This host - GPU ({gpus[0] if gpus else 'none detected'})")):
        if mock:
            blocks.append(HardwareBlock(
                profile=pid, name=name, kind="simulated", latency_ms_p50=None, fps=None,
                budget_fps_required=budget_fps, meets_budget=None, method="mock adapter - no inference executed",
                assumptions=["MOCK ADAPTER - latency was not measured and is not reported."]))
            continue
        executed = executed_device == dev
        lat = measured_p50_ms if executed else None
        fps = _fps(lat)
        blocks.append(HardwareBlock(
            profile=pid, name=name, kind="measured", latency_ms_p50=lat, fps=fps, budget_fps_required=budget_fps,
            meets_budget=(fps >= budget_fps) if fps is not None else None,
            method="measured p50 of per-frame total latency (warm-up excluded)" if executed
            else "not executed on this profile in this run",
            assumptions=[] if executed else ["This run did not execute on this profile; no value is reported."]))
    for t in ESTIMATED_TARGETS.values():
        if gflops and gflops_imgsz:
            lat = estimate_latency_ms(t, gflops, gflops_imgsz, imgsz)
            fps = _fps(lat)
            blocks.append(HardwareBlock(
                profile=t.id, name=t.name, kind="estimated", latency_ms_p50=round(lat, 2), fps=fps,
                budget_fps_required=budget_fps, meets_budget=fps >= budget_fps if fps is not None else None,
                method=f"GFLOPs model: {gflops:.3f} GFLOPs @ {gflops_imgsz} scaled to imgsz {imgsz}",
                assumptions=list(t.assumptions)))
        else:
            blocks.append(HardwareBlock(
                profile=t.id, name=t.name, kind="estimated", latency_ms_p50=None, fps=None,
                budget_fps_required=budget_fps, meets_budget=None,
                method="unavailable: model GFLOPs unknown (for example ONNX models)",
                assumptions=list(t.assumptions)))
    return blocks
