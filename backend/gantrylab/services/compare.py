"""Side-by-side comparison of completed runs."""

from __future__ import annotations

from fastapi import HTTPException

from ..metrics.engine import MIN_SUPPORT
from ..schemas import CompareResponse
from .runs import RunManager


def _d(a: float | None, b: float | None) -> dict:
    return {"a": a, "b": b, "delta": (b - a) if a is not None and b is not None else None}


def compare_runs(runs: RunManager, ids: list[str]) -> CompareResponse:
    if len(ids) != 2:
        raise HTTPException(status_code=400, detail="pass exactly two run ids: ?runs=a,b")
    raws = [runs.get_raw(i) for i in ids]
    for r in raws:
        if r["status"] != "complete":
            raise HTTPException(status_code=409, detail=f"run {r['id']} is {r['status']}")
    ms = [runs.metrics(i) for i in ids]
    a, b = ms
    same_model = raws[0]["model"]["sha256"] == raws[1]["model"]["sha256"]
    same_data = raws[0]["dataset"]["manifest_sha256"] == raws[1]["dataset"]["manifest_sha256"]
    ctype = ("repeat" if same_model and same_data else "environments" if same_model else
             "models" if same_data else "models_and_environments")
    notes = []
    if raws[0]["mock"] or raws[1]["mock"]:
        notes.append("At least one run used the MOCK ADAPTER - not a real model evaluation.")
    if raws[0]["config"] != raws[1]["config"]:
        notes.append("Run configs differ; deltas mix model or data effects with config effects.")
    notes.append("delta = b - a. Slices with n_gt below the minimum support are flagged low_support.")
    overall = {k: _d(a["overall"][k], b["overall"][k]) for k in ("precision", "recall", "f1", "map50", "map50_95")}
    overall["latency_ms_p50"] = _d(a["latency"]["total_ms"]["p50"], b["latency"]["total_ms"]["p50"])
    classes = sorted(set(a["per_class"]) | set(b["per_class"]))
    per_class = {}
    for c in classes:
        ca, cb = a["per_class"].get(c, {}), b["per_class"].get(c, {})
        per_class[c] = {k: _d(ca.get(k), cb.get(k)) for k in ("precision", "recall", "f1", "ap50", "ap50_95")}
    sa = {s["id"]: s for s in a["slices"]}
    sb = {s["id"]: s for s in b["slices"]}
    slice_deltas = []
    for sid in sorted(set(sa) | set(sb)):
        x, y = sa.get(sid), sb.get(sid)
        ref = x or y
        assert ref is not None
        ngt_a = x["n_gt"] if x else None
        ngt_b = y["n_gt"] if y else None
        slice_deltas.append({
            "id": sid, "key": ref["key"], "bucket": ref["bucket"], "n_gt_a": ngt_a, "n_gt_b": ngt_b,
            "recall": _d(x and x["recall"], y and y["recall"]),
            "precision": _d(x and x["precision"], y and y["precision"]),
            "f1": _d(x and x["f1"], y and y["f1"]),
            "low_support": (ngt_a or 0) < MIN_SUPPORT or (ngt_b or 0) < MIN_SUPPORT,
        })
    run_entries = []
    for r, m in zip(raws, ms):
        run_entries.append({"run_id": r["id"], "model": r["model"], "dataset": r["dataset"], "adapter": r["adapter"],
                            "mock": r["mock"], "overall": m["overall"], "latency_ms_p50": m["latency"]["total_ms"]["p50"],
                            "hardware": m["hardware"]})
    return CompareResponse.model_validate({"runs": run_entries, "comparison_type": ctype, "overall_deltas": overall,
                                           "per_class_deltas": per_class, "slice_deltas": slice_deltas, "notes": notes})
