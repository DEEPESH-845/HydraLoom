"""Logs vision latency, temperature and throttling on the Raspberry Pi for the Hardware bench (/hardware).

    python pi_bench.py --model best.onnx --seconds 300 --out pi-log.csv

Uses the camera when it opens, otherwise random frames (say so in the report: compute only, no capture).
"""

from __future__ import annotations

import argparse
import csv
import subprocess
import time
from pathlib import Path

import numpy as np


def temp_c() -> float | None:
    try:
        return int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000.0
    except (OSError, ValueError):
        return None


def throttled() -> int | None:
    """1 when the firmware reports under-voltage, capping or throttling right now (bits 0 to 3)."""
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=2).stdout
        return int(bool(int(out.split("=")[1], 16) & 0xF))
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return None


def load(path: str, imgsz: int):
    if path.endswith(".onnx"):
        import onnxruntime as ort

        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        inp = sess.get_inputs()[0]
        h, w = (d if isinstance(d, int) else imgsz for d in inp.shape[2:4])

        def run(frame: np.ndarray) -> None:
            ys = np.linspace(0, frame.shape[0] - 1, h).astype(int)
            xs = np.linspace(0, frame.shape[1] - 1, w).astype(int)
            x = frame[ys][:, xs, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
            sess.run(None, {inp.name: x})

        return run
    from ultralytics import YOLO

    model = YOLO(path)
    return lambda frame: model.predict(frame, imgsz=imgsz, verbose=False)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--seconds", type=float, default=300)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--out", default="pi-log.csv")
    a = ap.parse_args()
    infer = load(a.model, a.imgsz)
    cap = None
    try:
        import cv2

        cap = cv2.VideoCapture(a.camera)
        if not cap.isOpened() or not cap.read()[0]:  # on a Pi the device can open without ever delivering a frame
            cap = None
    except ImportError:
        pass
    blank = np.random.default_rng(0).integers(0, 255, (720, 1280, 3), dtype=np.uint8)
    for _ in range(3):
        infer(blank)  # warm-up frames are not logged
    t0 = time.monotonic()
    with open(a.out, "w", newline="", encoding="utf-8") as fh:
        fh.write(f"# model={Path(a.model).name} imgsz={a.imgsz} source={'camera' if cap else 'random frames'}\n")
        w = csv.writer(fh)
        w.writerow(["t_s", "latency_ms", "temp_c", "throttled"])
        while (t := time.monotonic() - t0) < a.seconds:
            s = time.perf_counter()
            ok, frame = cap.read() if cap else (True, blank)
            if not ok:
                print("camera stopped delivering frames: the log ends early")
                break
            infer(frame)
            ms = (time.perf_counter() - s) * 1000
            tc, th = temp_c(), throttled()
            w.writerow([f"{t:.3f}", f"{ms:.2f}", "" if tc is None else f"{tc:.1f}", "" if th is None else th])
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
