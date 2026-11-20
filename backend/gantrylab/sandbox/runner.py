"""Parent-side launcher for the sandbox worker subprocess.

The API process never deserialises an uploaded checkpoint.
It starts ``python -I`` running :mod:`gantrylab.sandbox.worker` with:

* a scrubbed environment (no API keys, tokens or secrets),
* an empty temporary working directory and private TEMP / HOME / config dirs,
* a wall-clock timeout,
* a memory limit (Windows Job Object; POSIX ``RLIMIT_AS`` for CPU jobs) plus a psutil RSS watchdog,
* on Windows, an active-process limit that prevents the worker from spawning children,
* a line-oriented JSON protocol on stdout (lines prefixed with ``@@GL@@``).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import psutil

from ..config import BACKEND_ROOT

PROTOCOL_PREFIX = "@@GL@@ "
SECRET_KEY_RE = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)", re.IGNORECASE)
PASSTHROUGH_ENV = (
    "PATH",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
    "CUDA_VISIBLE_DEVICES",
    "CUDA_DEVICE_ORDER",
    "LANG",
    "LC_ALL",
)

BOOTSTRAP = (
    "import sys;"
    "sys.path.insert(0, {root!r});"
    "import runpy;"
    "runpy.run_module('gantrylab.sandbox.worker', run_name='__main__', alter_sys=True)"
)


@dataclass
class SandboxLimits:
    timeout_s: float
    memory_mb: int
    max_processes: int = 2  # Windows venv launcher + interpreter


@dataclass
class SandboxResult:
    ok: bool
    returncode: int | None
    result: dict | None
    error: str | None
    messages: list[dict] = field(default_factory=list)
    stderr_tail: str = ""
    wall_s: float = 0.0
    timed_out: bool = False
    killed_reason: str | None = None
    peak_rss_mb: float | None = None
    cpu_percent_mean: float | None = None
    cpu_percent_max: float | None = None
    gpu_util_mean: float | None = None
    gpu_util_max: float | None = None
    limits: dict = field(default_factory=dict)


def scrubbed_env(home: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for key in PASSTHROUGH_ENV:
        val = os.environ.get(key)
        if val is not None and not SECRET_KEY_RE.search(key):
            env[key] = val
    tmp = home / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    yolo = home / "yolo"
    yolo.mkdir(parents=True, exist_ok=True)
    env.update(
        {
            "TEMP": str(tmp),
            "TMP": str(tmp),
            "TMPDIR": str(tmp),
            "HOME": str(home),
            "USERPROFILE": str(home),
            "APPDATA": str(home),
            "LOCALAPPDATA": str(home),
            "XDG_CONFIG_HOME": str(home),
            "XDG_CACHE_HOME": str(home),
            "TORCH_HOME": str(home / "torch"),
            "YOLO_CONFIG_DIR": str(yolo),
            "YOLO_OFFLINE": "True",
            "YOLO_AUTOINSTALL": "False",
            "YOLO_VERBOSE": "False",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "MPLBACKEND": "Agg",
            "GANTRYLAB_SANDBOX_HOME": str(home),
            # getpass.getuser() falls back to the POSIX-only pwd module when these are unset.
            "USERNAME": "gantrylab-sandbox",
            "LOGNAME": "gantrylab-sandbox",
        }
    )
    # Defence in depth: drop anything that looks like a credential even if allowlisted above.
    return {k: v for k, v in env.items() if not SECRET_KEY_RE.search(k)}


# ---------------------------------------------------------------------------
# Windows Job Object (memory limit, kill-on-close, active process limit)
# ---------------------------------------------------------------------------


class _WinJob:
    def __init__(self, memory_mb: int, max_processes: int) -> None:
        import ctypes
        from ctypes import wintypes

        self._ctypes = ctypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._k32 = k32

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class BASIC(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k32.QueryInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        self._EXTENDED = EXTENDED

        self.handle = k32.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        info = EXTENDED()
        flags = 0x2000 | 0x400  # KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION
        if memory_mb > 0:
            flags |= 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
            info.ProcessMemoryLimit = int(memory_mb) * 1024 * 1024
        if max_processes > 0:
            flags |= 0x8  # JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            info.BasicLimitInformation.ActiveProcessLimit = int(max_processes)
        info.BasicLimitInformation.LimitFlags = flags
        if not k32.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

    def assign(self, proc_handle: int) -> None:
        if not self._k32.AssignProcessToJobObject(self.handle, proc_handle):
            raise OSError(self._ctypes.get_last_error(), "AssignProcessToJobObject failed")

    def peak_process_memory_mb(self) -> float | None:
        ctypes = self._ctypes
        info = self._EXTENDED()
        if self._k32.QueryInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info), None):
            return info.PeakProcessMemoryUsed / (1024 * 1024)
        return None

    def close(self) -> None:
        if self.handle:
            self._k32.CloseHandle(self.handle)
            self.handle = None


def _resume_process(proc_handle: int) -> None:
    import ctypes

    ntdll = ctypes.WinDLL("ntdll")
    ntdll.NtResumeProcess.argtypes = [ctypes.c_void_p]
    status = ntdll.NtResumeProcess(ctypes.c_void_p(proc_handle))
    if status != 0:
        raise OSError(f"NtResumeProcess failed with NTSTATUS {status:#x}")


def _posix_preexec(memory_mb: int, limit_address_space: bool) -> Callable[[], None]:
    def _fn() -> None:  # pragma: no cover - runs in the child on POSIX only
        import resource

        os.setsid()
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if limit_address_space and memory_mb > 0:
            lim = memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (lim, lim))

    return _fn


# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------


def _tree(proc: psutil.Process) -> list[psutil.Process]:
    try:
        return [proc, *proc.children(recursive=True)]
    except psutil.Error:
        return [proc]


def _gpu_util_sample() -> float | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
        )
        vals = [float(v) for v in out.stdout.split() if v.strip()]
        return max(vals) if vals else None
    except Exception:
        return None


def kill_tree(proc: subprocess.Popen) -> None:
    try:
        root = psutil.Process(proc.pid)
        for p in reversed(_tree(root)):
            try:
                p.kill()
            except psutil.Error:
                pass
    except psutil.Error:
        pass
    try:
        proc.kill()
    except OSError:
        pass


def run_sandboxed(
    command: str,
    job: dict,
    limits: SandboxLimits,
    *,
    tmp_root: Path | None = None,
    on_message: Callable[[dict], None] | None = None,
    sample_gpu: bool = False,
    cancel_event: threading.Event | None = None,
) -> SandboxResult:
    """Run the sandbox worker ``command`` with ``job`` on stdin and collect protocol messages."""
    if tmp_root is not None:
        tmp_root.mkdir(parents=True, exist_ok=True)
    base = Path(tempfile.mkdtemp(prefix="gl-sbx-", dir=str(tmp_root) if tmp_root else None))
    cwd = base / "cwd"
    home = base / "home"
    cwd.mkdir()
    home.mkdir()
    env = scrubbed_env(home)
    cmd = [sys.executable, "-I", "-c", BOOTSTRAP.format(root=str(BACKEND_ROOT)), command]

    is_windows = os.name == "nt"
    limit_info: dict[str, Any] = {"timeout_s": limits.timeout_s, "memory_mb": limits.memory_mb}
    job_obj: _WinJob | None = None
    creationflags = 0
    preexec = None
    if is_windows:
        creationflags = 0x00000004 | 0x08000000  # CREATE_SUSPENDED | CREATE_NO_WINDOW
    else:
        cpu_only = str(job.get("config", {}).get("device", "cpu")) == "cpu"
        preexec = _posix_preexec(limits.memory_mb, limit_address_space=cpu_only)
        limit_info["mechanism"] = "rlimit_as+rss_watchdog" if cpu_only else "rss_watchdog"

    started = time.perf_counter()
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=creationflags,
        preexec_fn=preexec,  # noqa: PLW1509 - POSIX only, sets rlimits
        close_fds=True,
    )
    if is_windows:
        try:
            job_obj = _WinJob(limits.memory_mb, limits.max_processes)
            job_obj.assign(int(proc._handle))  # type: ignore[attr-defined]
            limit_info["mechanism"] = "windows_job_object+rss_watchdog"
            limit_info["max_processes"] = limits.max_processes
        except Exception as exc:  # pragma: no cover - fall back to watchdog only
            limit_info["mechanism"] = f"rss_watchdog (job object failed: {exc})"
        _resume_process(int(proc._handle))  # type: ignore[attr-defined]

    messages: list[dict] = []
    result: dict | None = None
    error: str | None = None
    stderr_tail: deque[str] = deque(maxlen=200)

    def _read_stdout() -> None:
        nonlocal result, error
        assert proc.stdout is not None
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line.startswith(PROTOCOL_PREFIX):
                stderr_tail.append(line)
                continue
            try:
                msg = json.loads(line[len(PROTOCOL_PREFIX):])
            except json.JSONDecodeError:
                stderr_tail.append(line[:500])
                continue
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "result":
                result = msg
            elif mtype == "error":
                error = str(msg.get("message", "worker error"))[:4000]
            elif mtype != "frame":
                # Per-frame messages are delivered through on_message only to bound memory.
                messages.append(msg)
            if on_message is not None:
                try:
                    on_message(msg)
                except Exception:
                    pass

    def _read_stderr() -> None:
        assert proc.stderr is not None
        for raw in iter(proc.stderr.readline, b""):
            stderr_tail.append(raw.decode("utf-8", errors="replace").rstrip("\r\n")[:1000])

    t_out = threading.Thread(target=_read_stdout, daemon=True)
    t_err = threading.Thread(target=_read_stderr, daemon=True)
    t_out.start()
    t_err.start()
    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(job).encode("utf-8"))
        proc.stdin.close()
    except (BrokenPipeError, OSError):
        pass

    peak_rss = 0.0
    cpu_samples: list[float] = []
    gpu_samples: list[float] = []
    killed_reason: str | None = None
    timed_out = False
    try:
        root = psutil.Process(proc.pid)
    except psutil.Error:
        root = None
    last_gpu = 0.0
    primed: dict[int, psutil.Process] = {}
    while True:
        rc = proc.poll()
        if rc is not None:
            break
        elapsed = time.perf_counter() - started
        if elapsed > limits.timeout_s:
            timed_out = True
            killed_reason = f"wall-clock timeout after {limits.timeout_s:.0f}s"
            kill_tree(proc)
            break
        if cancel_event is not None and cancel_event.is_set():
            killed_reason = "cancelled"
            kill_tree(proc)
            break
        if root is not None:
            rss = 0
            cpu = 0.0
            for p in _tree(root):
                try:
                    if p.pid not in primed:
                        primed[p.pid] = p
                        p.cpu_percent(None)
                    rss += p.memory_info().rss
                    cpu += primed[p.pid].cpu_percent(None)
                except psutil.Error:
                    pass
            peak_rss = max(peak_rss, rss / (1024 * 1024))
            if elapsed > 0.5:
                cpu_samples.append(cpu)
            if limits.memory_mb > 0 and rss > limits.memory_mb * 1024 * 1024:
                killed_reason = f"memory limit exceeded ({rss / 1048576:.0f} MB > {limits.memory_mb} MB)"
                kill_tree(proc)
                break
        if sample_gpu and time.perf_counter() - last_gpu > 1.0:
            last_gpu = time.perf_counter()
            g = _gpu_util_sample()
            if g is not None:
                gpu_samples.append(g)
        time.sleep(0.2)

    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:  # pragma: no cover
        kill_tree(proc)
    t_out.join(timeout=10)
    t_err.join(timeout=5)
    wall = time.perf_counter() - started
    if job_obj is not None:
        peak_job = job_obj.peak_process_memory_mb()
        if peak_job is not None:
            limit_info["peak_committed_mb"] = round(peak_job, 1)
        job_obj.close()
    shutil.rmtree(base, ignore_errors=True)

    rc = proc.returncode
    if killed_reason and not error:
        error = killed_reason
    if result is None and error is None:
        tail = "\n".join(list(stderr_tail)[-15:])
        if rc not in (0, None) and limits.memory_mb > 0 and is_windows and "MemoryError" in tail:
            error = f"worker exceeded memory limit of {limits.memory_mb} MB"
        else:
            error = f"worker exited with code {rc} without a result"
    return SandboxResult(
        ok=result is not None and error is None,
        returncode=rc,
        result=result,
        error=error,
        messages=messages,
        stderr_tail="\n".join(list(stderr_tail)[-40:]),
        wall_s=wall,
        timed_out=timed_out,
        killed_reason=killed_reason,
        peak_rss_mb=round(peak_rss, 1) if peak_rss else None,
        cpu_percent_mean=round(sum(cpu_samples) / len(cpu_samples), 1) if cpu_samples else None,
        cpu_percent_max=round(max(cpu_samples), 1) if cpu_samples else None,
        gpu_util_mean=round(sum(gpu_samples) / len(gpu_samples), 1) if gpu_samples else None,
        gpu_util_max=round(max(gpu_samples), 1) if gpu_samples else None,
        limits=limit_info,
    )
