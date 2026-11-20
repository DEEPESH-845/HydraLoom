"""Patched COPIES of user config files plus unified diffs. Originals are never modified."""

from __future__ import annotations

import difflib
import re
from typing import Any

import yaml

TOP_KEY_RE = r"^{key}\s*:"


def _dump_kv(key: str, value: Any, sid: str) -> list[str]:
    text = yaml.safe_dump({key: value}, sort_keys=False, allow_unicode=True, default_flow_style=False).rstrip("\n")
    lines = text.split("\n")
    lines[0] = f"{lines[0]}  # gantrylab {sid}"
    return lines


def apply_suggestions(original: str, suggestions: list[dict]) -> tuple[str, list[str]]:
    """Replace or append top-level keys line by line, preserving comments and unrelated content."""
    lines = original.splitlines()
    applied: list[str] = []
    for sg in suggestions:
        key = sg["key"]
        new_lines = _dump_kv(key, sg["suggested"], sg["id"])
        pat = re.compile(TOP_KEY_RE.format(key=re.escape(key)))
        start = next((i for i, ln in enumerate(lines) if pat.match(ln)), None)
        if start is None:
            lines.extend(new_lines)
        else:
            end = start + 1
            while end < len(lines) and (lines[end].startswith((" ", "\t", "-")) or not lines[end].strip()):
                if not lines[end].strip():
                    # Stop at a blank line followed by a new top-level key or end of file.
                    nxt = next((j for j in range(end + 1, len(lines)) if lines[j].strip()), None)
                    if nxt is None or not lines[nxt].startswith((" ", "\t", "-")):
                        break
                end += 1
            lines[start:end] = new_lines
        applied.append(sg["id"])
    text = "\n".join(lines) + "\n"
    doc = yaml.safe_load(text) or {}
    for sg in suggestions:
        if not isinstance(doc, dict) or doc.get(sg["key"]) != sg["suggested"]:
            raise ValueError(f"patch verification failed for {sg['key']}")
    return text, applied


def unified_diff(original: str, patched: str, file: str) -> str:
    return "".join(difflib.unified_diff(
        original.splitlines(keepends=True) if original else [],
        patched.splitlines(keepends=True),
        fromfile=f"a/{file}",
        tofile=f"b/{file}",
    ))
