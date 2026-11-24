"""Restricted pickle module used to load untrusted PyTorch / Ultralytics checkpoints.

This module is imported only inside the sandbox worker process.
It is passed to ``torch.load(..., weights_only=False, pickle_module=restricted_pickle_module)``.

Defence layers:

1. ``find_class`` resolves only an explicit allowlist of globals.
   Anything else (``os.system``, ``builtins.eval``, ``subprocess.Popen``, ``getattr`` ...)
   raises ``DisallowedGlobal`` *before* the module is imported.
2. Calls made by the ``REDUCE``, ``INST`` and ``OBJ`` opcodes are restricted to a smaller
   allowlist of side-effect-free callables (tensor rebuild helpers, containers, ``torch.Size`` ...).
   Allowlisted ``nn.Module`` classes can therefore be materialised only through ``NEWOBJ``
   (``cls.__new__``), so their ``__init__`` never runs with attacker-controlled arguments.
3. Helpers that would otherwise call an arbitrary function argument
   (``torch._tensor._rebuild_from_type_v2``, ``copyreg._reconstructor``) are wrapped so the
   function argument must itself be in the call allowlist.

Residual risk: allowlisted classes still run their ``__setstate__`` (``BUILD`` opcode) and
``__new__``. See README_GANTRYLAB.md for the full threat model.
"""

from __future__ import annotations

import _compat_pickle
import builtins
import codecs
import collections
import copyreg
import importlib
import io
import pickle
import types
from typing import Any

__all__ = [
    "DisallowedGlobal",
    "RestrictedUnpickler",
    "restricted_pickle_module",
    "safe_loads",
]


class DisallowedGlobal(pickle.UnpicklingError):
    """Raised when a pickle references a global that is not allowlisted."""


SAFE_BUILTINS = frozenset(
    {
        "set",
        "frozenset",
        "slice",
        "dict",
        "list",
        "tuple",
        "int",
        "float",
        "bool",
        "str",
        "bytes",
        "bytearray",
        "complex",
        "range",
        "object",
        "NoneType",
        "Ellipsis",
    }
)
SAFE_COLLECTIONS = frozenset({"OrderedDict", "defaultdict", "deque", "Counter"})
SAFE_NUMPY = {
    "numpy": frozenset({"ndarray", "dtype"}),
    "numpy.core.multiarray": frozenset({"_reconstruct", "scalar"}),
    "numpy._core.multiarray": frozenset({"_reconstruct", "scalar"}),
    "numpy.core.numeric": frozenset({"_frombuffer"}),
    "numpy._core.numeric": frozenset({"_frombuffer"}),
}
SAFE_TORCH_UTILS = frozenset(
    {"_rebuild_tensor_v2", "_rebuild_tensor", "_rebuild_parameter", "_rebuild_parameter_with_state"}
)
TORCH_TOP_LEVEL = frozenset({"Size", "device", "Tensor"})
ULTRALYTICS_DENY_MODULE_PREFIXES = (
    "ultralytics.nn.autobackend",  # loads/downloads weights in __init__
    "ultralytics.nn.text_model",  # downloads CLIP weights in __init__
)
ULTRALYTICS_UTILS_CLASS_MODULES = ("ultralytics.utils.loss", "ultralytics.utils.tal")
ULTRALYTICS_EXTRA = {("ultralytics.utils", "IterableSimpleNamespace")}
PATHLIB_MAP = {
    "Path": "PurePath",
    "PosixPath": "PurePosixPath",
    "WindowsPath": "PureWindowsPath",
    "PurePath": "PurePath",
    "PurePosixPath": "PurePosixPath",
    "PureWindowsPath": "PureWindowsPath",
}


def _deny(module: str, name: str, why: str = "not in allowlist") -> DisallowedGlobal:
    return DisallowedGlobal(f"Disallowed pickle global {module}.{name}: {why}")


def _import_attr(module: str, name: str) -> Any:
    mod = importlib.import_module(module)
    obj = mod
    for part in name.split("."):
        if part.startswith("__") and part.endswith("__"):
            raise _deny(module, name, "dunder attribute")
        obj = getattr(obj, part)
    return obj


def _is_nn_module_class(obj: Any) -> bool:
    import torch

    return isinstance(obj, type) and (issubclass(obj, torch.nn.Module) or issubclass(obj, torch.nn.Parameter))


def resolve_global(module: str, name: str) -> Any:
    """Return the allowlisted object for ``module.name`` or raise ``DisallowedGlobal``.

    No module outside the allowlisted namespaces is ever imported.
    """
    if not isinstance(module, str) or not isinstance(name, str):
        raise _deny(str(module), str(name), "non-string global")
    if (module, name) in _compat_pickle.NAME_MAPPING:
        module, name = _compat_pickle.NAME_MAPPING[(module, name)]
    module = _compat_pickle.IMPORT_MAPPING.get(module, module)
    if module == "__builtin__":
        module = "builtins"

    if module == "builtins":
        if name in SAFE_BUILTINS:
            if name == "NoneType":
                return type(None)
            return getattr(builtins, name)
        raise _deny(module, name)
    if module == "collections":
        if name in SAFE_COLLECTIONS:
            return getattr(collections, name)
        raise _deny(module, name)
    if module == "copyreg":
        if name == "_reconstructor":
            return _safe_reconstructor
        if name in ("__newobj__", "__newobj_ex__"):
            return getattr(copyreg, name)
        raise _deny(module, name)
    if module == "_codecs" and name == "encode":
        # Protocol 2 serialises bytes as _codecs.encode(str, "latin1").
        return codecs.encode
    if module == "argparse" and name == "Namespace":
        import argparse

        return argparse.Namespace
    if module == "types" and name == "SimpleNamespace":
        return types.SimpleNamespace
    if module == "pathlib" and name in PATHLIB_MAP:
        import pathlib

        return getattr(pathlib, PATHLIB_MAP[name])
    if module in SAFE_NUMPY:
        if name in SAFE_NUMPY[module]:
            return _import_attr(module, name)
        raise _deny(module, name)
    if module == "numpy.dtypes" and name.endswith("DType") and name.isidentifier():
        obj = _import_attr(module, name)
        if isinstance(obj, type):
            return obj
        raise _deny(module, name)

    if module == "torch" or module.startswith("torch."):
        return _resolve_torch(module, name)
    if module.startswith("ultralytics."):
        return _resolve_ultralytics(module, name)
    raise _deny(module, name)


def _resolve_torch(module: str, name: str) -> Any:
    import torch

    if module == "torch":
        if name in TORCH_TOP_LEVEL:
            return getattr(torch, name)
        obj = getattr(torch, name, None)
        if isinstance(obj, (torch.dtype, torch.layout, torch.memory_format)):
            return obj
        raise _deny(module, name)
    if module == "torch._utils":
        if name in SAFE_TORCH_UTILS:
            return getattr(torch._utils, name)
        raise _deny(module, name)
    if module == "torch._tensor" and name == "_rebuild_from_type_v2":
        return _safe_rebuild_from_type_v2
    if module == "torch.nn.parameter" and name in ("Parameter", "Buffer", "UninitializedParameter"):
        return _import_attr(module, name)
    if module.startswith("torch.nn.modules."):
        obj = _import_attr(module, name)
        if _is_nn_module_class(obj):
            return obj
        raise _deny(module, name, "only nn.Module classes are allowed")
    raise _deny(module, name)


def _resolve_ultralytics(module: str, name: str) -> Any:
    if any(module == p or module.startswith(p + ".") for p in ULTRALYTICS_DENY_MODULE_PREFIXES):
        raise _deny(module, name, "module explicitly denied")
    if (module, name) in ULTRALYTICS_EXTRA:
        return _import_attr(module, name)
    if module.startswith("ultralytics.nn."):
        obj = _import_attr(module, name)
        if _is_nn_module_class(obj):
            return obj
        raise _deny(module, name, "only nn.Module classes are allowed")
    if any(module == p or module.startswith(p + ".") for p in ULTRALYTICS_UTILS_CLASS_MODULES):
        obj = _import_attr(module, name)
        if isinstance(obj, type):
            return obj
        raise _deny(module, name, "only classes are allowed")
    raise _deny(module, name)


def _safe_callables() -> set[Any]:
    """Callables the REDUCE / INST / OBJ opcodes may invoke."""
    import argparse
    import pathlib

    out: set[Any] = {getattr(builtins, n) for n in SAFE_BUILTINS if n not in ("NoneType", "Ellipsis", "object")}
    out |= {getattr(collections, n) for n in SAFE_COLLECTIONS}
    out |= {_safe_reconstructor, copyreg.__newobj__, copyreg.__newobj_ex__, codecs.encode}
    out |= {argparse.Namespace, types.SimpleNamespace}
    out |= {getattr(pathlib, n) for n in set(PATHLIB_MAP.values())}
    try:
        import numpy

        core = getattr(numpy, "_core", None) or numpy.core
        out |= {core.multiarray._reconstruct, core.multiarray.scalar, numpy.dtype}
        if hasattr(core.numeric, "_frombuffer"):
            out.add(core.numeric._frombuffer)
    except Exception:  # pragma: no cover - numpy always present with torch
        pass
    try:
        import torch

        out |= {getattr(torch._utils, n) for n in SAFE_TORCH_UTILS if hasattr(torch._utils, n)}
        out |= {_safe_rebuild_from_type_v2, torch.Size, torch.device}
    except Exception:
        pass
    try:
        from ultralytics.utils import IterableSimpleNamespace

        out.add(IterableSimpleNamespace)
    except Exception:
        pass
    return out


_SAFE_CALLABLES: set[Any] | None = None


def _check_callable(func: Any) -> None:
    global _SAFE_CALLABLES
    if _SAFE_CALLABLES is None:
        _SAFE_CALLABLES = _safe_callables()
    try:
        ok = func in _SAFE_CALLABLES
    except TypeError:
        ok = False
    if not ok:
        label = getattr(func, "__qualname__", None) or type(func).__name__
        mod = getattr(func, "__module__", "?")
        raise DisallowedGlobal(f"Disallowed pickle call {mod}.{label}: not in call allowlist")


def _safe_reconstructor(cls: Any, base: Any, state: Any) -> Any:
    if base is not object:
        _check_callable(base)
    return copyreg._reconstructor(cls, base, state)


def _safe_rebuild_from_type_v2(func: Any, new_type: Any, args: Any, state: Any) -> Any:
    import torch

    _check_callable(func)
    if not (isinstance(new_type, type) and issubclass(new_type, torch.Tensor)):
        raise DisallowedGlobal("Disallowed tensor subclass in _rebuild_from_type_v2")
    return torch._tensor._rebuild_from_type_v2(func, new_type, args, state)


class RestrictedUnpickler(pickle._Unpickler):  # type: ignore[name-defined]
    """Pure-Python unpickler with allowlisted globals and allowlisted calls."""

    dispatch = dict(pickle._Unpickler.dispatch)  # type: ignore[attr-defined]

    def find_class(self, module: str, name: str) -> Any:  # noqa: D401
        return resolve_global(module, name)

    def load_reduce(self) -> None:
        stack = self.stack
        args = stack.pop()
        func = stack[-1]
        _check_callable(func)
        stack[-1] = func(*args)

    dispatch[pickle.REDUCE[0]] = load_reduce

    def _instantiate(self, klass: Any, args: Any) -> None:
        _check_callable(klass)
        super()._instantiate(klass, args)


def safe_loads(data: bytes) -> Any:
    return RestrictedUnpickler(io.BytesIO(data)).load()


def _load(file: Any, **kwargs: Any) -> Any:
    kwargs.pop("encoding", None)
    return RestrictedUnpickler(file, **kwargs).load()


restricted_pickle_module = types.ModuleType("gantrylab_restricted_pickle")
restricted_pickle_module.Unpickler = RestrictedUnpickler  # type: ignore[attr-defined]
restricted_pickle_module.load = _load  # type: ignore[attr-defined]
restricted_pickle_module.loads = safe_loads  # type: ignore[attr-defined]
restricted_pickle_module.UnpicklingError = pickle.UnpicklingError  # type: ignore[attr-defined]
restricted_pickle_module.Pickler = pickle.Pickler  # type: ignore[attr-defined]
restricted_pickle_module.dump = pickle.dump  # type: ignore[attr-defined]
restricted_pickle_module.dumps = pickle.dumps  # type: ignore[attr-defined]
restricted_pickle_module.HIGHEST_PROTOCOL = pickle.HIGHEST_PROTOCOL  # type: ignore[attr-defined]
