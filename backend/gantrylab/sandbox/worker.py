"""Sandbox worker entry point. Runs in a separate, isolated Python process.

Usage (launched by :mod:`gantrylab.sandbox.runner`, never by the API process directly)::

    python -I -c "<bootstrap>" inspect   < job.json
    python -I -c "<bootstrap>" infer     < job.json

Protocol: every message is one stdout line ``@@GL@@ {json}``.
Anything else printed by libraries is redirected to stderr.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import time
import traceback
from pathlib import Path
from typing import Any

PREFIX = "@@GL@@ "
_proto = None


def _setup_protocol_stream() -> None:
    """Keep a private handle on the real stdout, then point fd 1 at stderr.

    This stops C-level and Python-level library prints from corrupting the protocol.
    """
    global _proto
    _proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr


def emit(msg: dict) -> None:
    assert _proto is not None
    _proto.write(PREFIX + json.dumps(msg, default=_default, separators=(",", ":")) + "\n")
    _proto.flush()


def _default(obj: Any) -> Any:
    try:
        import numpy as np

        if isinstance(obj, np.generic):
            return obj.item()
        if isinstance(obj, np.ndarray):
            return obj.tolist()
    except ImportError:
        pass
    return str(obj)


# ---------------------------------------------------------------------------
# Defence in depth: audit hook installed after trusted imports, before untrusted data.
# Python audit hooks are not a security boundary; they only make exploitation noisier.
# ---------------------------------------------------------------------------

_BLOCKED_EVENTS = (
    "os.system",
    "os.exec",
    "os.posix_spawn",
    "os.spawn",
    "os.startfile",
    "os.fork",
    "os.forkpty",
    "subprocess.Popen",
    "socket.connect",
    "socket.bind",
    "socket.getaddrinfo",
    "webbrowser.open",
    "winreg.SetValue",
)


def install_audit_hook() -> None:
    home = os.environ.get("GANTRYLAB_SANDBOX_HOME")
    home_path = os.path.normcase(os.path.realpath(home)) if home else None
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC

    def _inside_home(path: Any) -> bool:
        if home_path is None or isinstance(path, int):
            return True
        try:
            p = os.path.normcase(os.path.realpath(os.fsdecode(path)))
        except Exception:
            return False
        return p == home_path or p.startswith(home_path + os.sep)

    def hook(event: str, args: tuple) -> None:
        if event.startswith(_BLOCKED_EVENTS):
            raise PermissionError(f"sandbox blocked {event}")
        if event == "open" and args:
            path, mode, flags = (list(args) + [None, None, None])[:3]
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & write_flags
            )
            if writing and not _inside_home(path):
                raise PermissionError(f"sandbox blocked write to {path!r}")
        elif event in ("os.remove", "os.rename", "os.rmdir", "shutil.rmtree", "os.chmod") and args:
            if not _inside_home(args[0]):
                raise PermissionError(f"sandbox blocked {event} on {args[0]!r}")

    sys.addaudithook(hook)


def install_restricted_torch_load() -> None:
    """Force every ``torch.load`` in this process through the restricted unpickler."""
    import torch

    from .restricted_pickle import restricted_pickle_module

    original = torch.load
    if getattr(original, "_gantrylab_restricted", False):
        return

    def restricted_load(f: Any, map_location: Any = None, pickle_module: Any = None, **kwargs: Any) -> Any:
        kwargs["weights_only"] = False
        kwargs.pop("pickle_module", None)
        return original(f, map_location=map_location, pickle_module=restricted_pickle_module, **kwargs)

    restricted_load._gantrylab_restricted = True  # type: ignore[attr-defined]
    torch.load = restricted_load  # type: ignore[assignment]


def _versions() -> dict[str, str | None]:
    from importlib import metadata

    out: dict[str, str | None] = {"python": platform.python_version()}
    for pkg in ("torch", "torchvision", "ultralytics", "onnxruntime", "onnx", "numpy"):
        try:
            out[pkg] = metadata.version(pkg)
        except metadata.PackageNotFoundError:
            out[pkg] = None
    return out


# ---------------------------------------------------------------------------
# inspect
# ---------------------------------------------------------------------------

TASK_BY_CLASS = {
    "DetectionModel": "detect",
    "SegmentationModel": "segment",
    "PoseModel": "pose",
    "ClassificationModel": "classify",
    "OBBModel": "obb",
    "WorldModel": "detect",
    "RTDETRDetectionModel": "detect",
}
TRAIN_ARG_KEYS = ("epochs", "imgsz", "batch", "data", "model", "optimizer", "lr0", "task", "single_cls", "rect")


def _jsonable(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    return str(v)


def inspect_pt(path: str) -> dict:
    import torch

    install_restricted_torch_load()
    from ultralytics.utils.torch_utils import get_flops

    install_audit_hook()
    ckpt = torch.load(path, map_location="cpu")
    if not isinstance(ckpt, dict) or ("model" not in ckpt and "ema" not in ckpt):
        raise ValueError("not an Ultralytics checkpoint: expected a dict with a 'model' or 'ema' entry")
    model = ckpt.get("ema") or ckpt.get("model")
    if not isinstance(model, torch.nn.Module):
        raise ValueError("checkpoint 'model' entry is not a torch.nn.Module")
    model = model.float().eval()
    names_raw = getattr(model, "names", None)
    if isinstance(names_raw, (list, tuple)):
        names = {i: str(n) for i, n in enumerate(names_raw)}
    elif isinstance(names_raw, dict):
        names = {int(k): str(v) for k, v in names_raw.items()}
    else:
        names = {}
    yaml_cfg = getattr(model, "yaml", None) or {}
    nc = len(names) or (int(yaml_cfg.get("nc")) if isinstance(yaml_cfg, dict) and yaml_cfg.get("nc") else None)
    task = getattr(model, "task", None) or TASK_BY_CLASS.get(type(model).__name__)
    train_args_raw = ckpt.get("train_args") or {}
    model_args = getattr(model, "args", None)
    if not train_args_raw and isinstance(model_args, dict):
        train_args_raw = model_args
    train_args = {k: _jsonable(train_args_raw.get(k)) for k in TRAIN_ARG_KEYS if k in train_args_raw}
    imgsz = train_args_raw.get("imgsz") if isinstance(train_args_raw, dict) else None
    if isinstance(imgsz, (list, tuple)):
        imgsz = int(max(imgsz))
    imgsz = int(imgsz) if imgsz else 640
    params = int(sum(p.numel() for p in model.parameters()))
    gflops = None
    try:
        g = get_flops(model, imgsz)
        gflops = round(float(g), 3) if g else None
    except Exception:
        gflops = None
    stride = getattr(model, "stride", None)
    max_stride = int(stride.max()) if stride is not None and hasattr(stride, "max") else 32
    forward_ok = False
    with torch.no_grad():
        s = max(max_stride, 32) * 5
        out = model(torch.zeros(1, 3, s, s))
        forward_ok = out is not None
    return {
        "format": "pt",
        "task": task,
        "names": names,
        "nc": nc,
        "imgsz": imgsz,
        "parameters": params,
        "gflops": gflops,
        "gflops_imgsz": imgsz if gflops else None,
        "architecture": type(model).__name__,
        "checkpoint_ultralytics_version": _jsonable(ckpt.get("version")),
        "checkpoint_date": _jsonable(ckpt.get("date")),
        "checkpoint_torch_version": None,
        "checkpoint_epoch": _jsonable(ckpt.get("epoch")),
        "train_args": train_args,
        "forward_check": "ok" if forward_ok else "failed",
    }


def inspect_onnx(path: str) -> dict:
    import ast

    import numpy as np
    import onnxruntime as ort

    from ..adapters.onnx_adapter import parse_names

    params = None
    opset = None
    try:
        import onnx

        install_audit_hook()
        proto = onnx.load(path, load_external_data=False)
        onnx.checker.check_model(proto)
        params = int(sum(int(np.prod(t.dims)) if len(t.dims) else 1 for t in proto.graph.initializer))
        opset = [{"domain": o.domain or "ai.onnx", "version": int(o.version)} for o in proto.opset_import]
        producer = f"{proto.producer_name} {proto.producer_version}".strip()
    except ImportError:
        install_audit_hook()
        producer = None
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    sess = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
    meta = sess.get_modelmeta().custom_metadata_map or {}
    names = parse_names(meta.get("names"))
    inputs = [{"name": i.name, "shape": [d if isinstance(d, int) else str(d) for d in i.shape], "type": i.type}
              for i in sess.get_inputs()]
    outputs = [{"name": o.name, "shape": [d if isinstance(d, int) else str(d) for d in o.shape], "type": o.type}
               for o in sess.get_outputs()]
    imgsz = None
    raw_imgsz = meta.get("imgsz")
    if raw_imgsz:
        try:
            v = ast.literal_eval(raw_imgsz)
            imgsz = int(max(v)) if isinstance(v, (list, tuple)) else int(v)
        except (ValueError, SyntaxError):
            imgsz = None
    if imgsz is None and inputs and isinstance(inputs[0]["shape"][-1], int):
        imgsz = int(inputs[0]["shape"][-1])
    nc = len(names) or None
    if nc is None and outputs:
        dims = [d for d in outputs[0]["shape"] if isinstance(d, int)]
        if len(dims) >= 2:
            nc = min(dims[1:]) - 4 if min(dims[1:]) > 4 else None
    return {
        "format": "onnx",
        "task": meta.get("task") or ("detect" if names else None),
        "names": names,
        "nc": nc,
        "imgsz": imgsz,
        "parameters": params,
        "gflops": None,
        "gflops_imgsz": None,
        "architecture": "onnx-graph",
        "checkpoint_ultralytics_version": meta.get("version"),
        "checkpoint_date": meta.get("date"),
        "checkpoint_torch_version": None,
        "onnx_producer": producer,
        "onnx_opset": opset,
        "inputs": inputs,
        "outputs": outputs,
        "train_args": {},
        "forward_check": "not run",
    }


# ---------------------------------------------------------------------------
# infer
# ---------------------------------------------------------------------------


def run_infer(job: dict) -> dict:
    from ..adapters.base import AdapterConfig, FrameInput

    cfg = job["config"]
    adapter_name = job["adapter"]
    if adapter_name == "ultralytics":
        import torch

        install_restricted_torch_load()
        import ultralytics  # noqa: F401 - trusted import before the audit hook

        from ..adapters.ultralytics_adapter import UltralyticsPtAdapter

        adapter = UltralyticsPtAdapter()
        torch.set_grad_enabled(False)
    elif adapter_name == "onnx":
        import onnxruntime  # noqa: F401

        from ..adapters.onnx_adapter import OnnxAdapter

        adapter = OnnxAdapter()
    else:
        raise ValueError(f"unknown adapter {adapter_name!r}")
    from PIL import Image  # noqa: F401 - import before the audit hook

    install_audit_hook()
    acfg = AdapterConfig(
        conf_floor=float(cfg["conf_floor"]),
        iou=float(cfg["iou"]),
        imgsz=int(cfg["imgsz"]),
        max_det=int(cfg["max_det"]),
        device=str(cfg["device"]),
    )
    info = adapter.load(job["model_path"], acfg)
    emit({"type": "env", "versions": _versions(), "runtime": _jsonable(info),
          "platform": platform.platform(), "machine": platform.machine()})
    frames = [FrameInput(file=f["file"], path=f["path"], width=int(f["width"]), height=int(f["height"]))
              for f in job["frames"]]
    warmup = int(job.get("warmup", 0))
    for i in range(min(warmup, 1_000) if frames else 0):
        pred = adapter.predict(frames[0])
        emit({"type": "warmup", "i": i, "file": frames[0].file, "timing": pred.timing_ms})
    t_start = time.perf_counter()
    for i, fi in enumerate(frames):
        pred = adapter.predict(fi)
        emit({"type": "frame", "i": i, "file": fi.file,
              "detections": [d.to_dict() for d in pred.detections], "timing": pred.timing_ms})
    wall = time.perf_counter() - t_start
    return {
        "n_frames": len(frames),
        "wall_s": wall,
        "gpu_max_memory_allocated_mb": adapter.gpu_max_memory_mb(),
        "runtime": _jsonable(info),
        "versions": _versions(),
    }


def main(argv: list[str] | None = None) -> int:
    _setup_protocol_stream()
    argv = sys.argv[1:] if argv is None else argv
    command = argv[0] if argv else ""
    try:
        job = json.loads(sys.stdin.read() or "{}")
        if command == "inspect":
            path = job["model_path"]
            fmt = job["format"]
            if not Path(path).is_file():
                raise FileNotFoundError("model file not found")
            payload = inspect_pt(path) if fmt == "pt" else inspect_onnx(path)
            payload["worker_versions"] = _versions()
            emit({"type": "result", "inspection": payload})
        elif command == "infer":
            emit({"type": "result", **run_infer(job)})
        elif command == "selftest":
            emit({"type": "result", "env_keys": sorted(os.environ.keys()), "cwd": os.getcwd(),
                  "cwd_entries": os.listdir(os.getcwd())})
        elif command == "selftest-sleep":
            time.sleep(float(job.get("seconds", 5)))
            emit({"type": "result", "slept": True})
        elif command == "selftest-alloc":
            block = bytearray(int(job.get("mb", 64)) * 1024 * 1024)
            for i in range(0, len(block), 4096):
                block[i] = 1
            emit({"type": "result", "allocated_mb": len(block) // (1024 * 1024)})
        elif command in ("selftest-spawn", "selftest-spawn-raw"):
            import subprocess

            if command == "selftest-spawn":
                install_audit_hook()
            try:
                subprocess.run([sys.executable, "-c", "pass"], check=True, timeout=30)
                spawned, err = True, None
            except BaseException as exc:  # noqa: BLE001
                spawned, err = False, f"{type(exc).__name__}: {exc}"
            emit({"type": "result", "spawned": spawned, "error": err})
        else:
            raise ValueError(f"unknown command {command!r}")
        return 0
    except BaseException as exc:  # noqa: BLE001 - report every failure through the protocol
        tb = traceback.format_exc(limit=6)
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}", "traceback": tb[-3000:]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
