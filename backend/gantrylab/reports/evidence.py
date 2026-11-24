"""Evidence payload and deterministic analysis.

The evidence is the only input a report (deterministic or LLM) may reason over.
Every claim in a report must cite evidence item ids (``evidence_refs``).
Numbers in reports are copied from here, never from LLM output.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from ..metrics.engine import MIN_SUPPORT
from ..storage import canonical_hash

HARSHER_WHEN_HIGHER = {"turbidity", "ntu", "current_speed_mps", "depth_m", "vehicle_speed_mps", "motion_blur_px"}
FAILURE_EXAMPLES = 12


def _r(v: Any, nd: int = 4) -> Any:
    if isinstance(v, float):
        return round(v, nd)
    if isinstance(v, dict):
        return {k: _r(x, nd) for k, x in v.items()}
    if isinstance(v, list):
        return [_r(x, nd) for x in v]
    return v


def _aggregate_failures(items: list[dict], kind: str) -> dict[str, Any]:
    by_class = Counter(i["class_name"] for i in items)
    by_type = Counter(i.get("type") or i.get("reason") for i in items)
    by_env = Counter(str((i.get("conditions") or {}).get("environment", "unknown")) for i in items)
    examples = []
    for i in items[:FAILURE_EXAMPLES]:
        cond = i.get("conditions") or {}
        cond_txt = ", ".join(f"{k}={cond[k]}" for k in sorted(cond)[:8])
        if kind == "fp":
            examples.append(f"{i['file']}: predicted {i['class_name']} conf={i['conf']} type={i['type']}"
                            f"{' (gt ' + i['gt_class'] + ')' if i.get('gt_class') else ''} [{cond_txt}]")
        else:
            examples.append(f"{i['file']}: missed {i['class_name']} reason={i['reason']} distance_m={i.get('distance_m')} "
                            f"occluded={i.get('occluded_fraction')} [{cond_txt}]")
    return {"n_listed": len(items), "by_class": dict(by_class), "by_type": dict(by_type),
            "by_environment": dict(by_env), "examples": examples}


def build_evidence(run: dict, metrics: dict, dataset: dict, model: dict, include_failures: bool) -> dict[str, Any]:
    items: dict[str, Any] = {}
    cfg = run["config"]
    items["overall"] = {**metrics["overall"], "conf_threshold": metrics["conf_threshold"],
                        "n_frames": metrics["n_frames"], "n_predictions_total": metrics["n_predictions_total"],
                        "inference_conf_floor": 0.001}
    for c, m in metrics["per_class"].items():
        items[f"class:{c}"] = m
    for s in metrics["slices"]:
        items[s["id"]] = {k: s[k] for k in ("key", "bucket", "kind", "scope", "n_frames", "n_gt", "recall",
                                            "precision", "f1", "ap50", "low_support", "lo", "hi")}
    items["ranking"] = metrics["slice_ranking"]
    for s in metrics["sensitivity"]:
        items[s["id"]] = {k: s[k] for k in ("key", "slope_per_unit", "n_buckets", "recall_range", "delta_recall",
                                            "buckets", "note")}
    for p in metrics["confused_pairs"][:10]:
        items[f"confusion:{p['gt_class']}->{p['pred_class']}"] = p
    items["fp_types"] = metrics["fp_types"]
    items["fn_types"] = metrics["fn_types"]
    items["pr:best_f1"] = metrics["pr"]["best_f1"]
    items["threshold"] = {"conf_threshold": metrics["conf_threshold"],
                          "tp_below_conf_threshold": metrics["tp_below_conf_threshold"]}
    items["latency"] = {k: metrics["latency"][k] for k in ("kind", "n_frames", "n_warmup_excluded", "total_ms",
                                                         "inference_ms", "fps_from_mean_latency", "wall_fps")}
    items["resources"] = {k: v for k, v in metrics["resources"].items() if k != "notes"}
    for b in metrics["hardware_profiles"]:
        items[f"hardware:{b['profile']}"] = b
    items["run:adapter"] = {"adapter": run["adapter"], "mock": bool(run["mock"]), "conf": cfg["conf"],
                            "iou": cfg["iou"], "imgsz": cfg["imgsz"], "device": cfg["device"]}
    items["run:class_map"] = {"resolved": run.get("resolved_class_map", {}),
                              "unmapped_model_classes": run.get("unmapped_model_classes", []),
                              "dataset_classes": dataset["classes"]}
    items["dataset"] = {"name": dataset["name"], "n_frames": dataset["n_frames"], "classes": dataset["classes"],
                        "class_counts": dataset["class_counts"], "conditions": dataset["conditions"],
                        "seed": dataset.get("seed")}
    if include_failures:
        items["failures:false_positives"] = _aggregate_failures(metrics["false_positives"], "fp")
        items["failures:false_negatives"] = _aggregate_failures(metrics["false_negatives"], "fn")

    analysis = analyse(metrics, run, dataset)
    for k, v in analysis.items():
        items[f"analysis:{k}"] = v

    evidence = {
        "schema": "gantrylab.evidence/1",
        "run": {
            "id": run["id"],
            "adapter": run["adapter"],
            "mock": run["mock"],
            "config": {k: cfg[k] for k in ("conf", "iou", "imgsz", "max_det", "device", "compute_profile", "budget_fps")},
            "model": {k: model.get(k) for k in ("name", "version", "sha256", "format")}
            | {k: (model.get("inspection") or {}).get(k) for k in ("task", "parameters", "gflops", "nc", "imgsz")},
            "dataset": {"id": dataset["id"], "name": dataset["name"], "manifest_sha256": dataset["manifest_sha256"]},
        },
        "min_support": MIN_SUPPORT,
        "items": _r(items),
    }
    evidence["hash"] = canonical_hash({k: v for k, v in evidence.items() if k != "hash"})
    return evidence


def analyse(metrics: dict, run: dict, dataset: dict) -> dict[str, Any]:
    """Deterministic findings over the metrics. No narrative, only structured values with refs."""
    out: dict[str, Any] = {}
    per_class = metrics["per_class"]
    supported = [(c, m) for c, m in per_class.items() if m["support"] >= MIN_SUPPORT and m["recall"] is not None]
    out["most_missed_classes"] = [
        {"class": c, "recall": m["recall"], "fn": m["fn"], "support": m["support"], "ref": f"class:{c}"}
        for c, m in sorted(supported, key=lambda cm: (cm[1]["recall"], -cm[1]["fn"]))[:3]
    ]
    out["low_support_classes"] = sorted(c for c, m in per_class.items() if 0 < m["support"] < MIN_SUPPORT)
    out["classes_without_gt"] = sorted(c for c, m in per_class.items() if m["support"] == 0)
    out["confused_pairs"] = [
        {**p, "ref": f"confusion:{p['gt_class']}->{p['pred_class']}"} for p in metrics["confused_pairs"][:3]
    ]

    # Spread of recall per condition key across eligible buckets (supports categorical keys too).
    by_key: dict[str, list[dict]] = defaultdict(list)
    for s in metrics["slices"]:
        if s["recall"] is not None and s["n_gt"] >= MIN_SUPPORT:
            by_key[s["key"]].append(s)
    sens = {s["key"]: s for s in metrics["sensitivity"]}
    spreads = []
    for key, ss in by_key.items():
        if len(ss) < 2:
            continue
        worst = min(ss, key=lambda s: (s["recall"], -s["n_gt"]))
        best = max(ss, key=lambda s: (s["recall"], s["n_gt"]))
        entry = {
            "key": key,
            "kind": ss[0]["kind"],
            "delta_recall": best["recall"] - worst["recall"],
            "worst": {"bucket": worst["bucket"], "recall": worst["recall"], "n_gt": worst["n_gt"], "ref": worst["id"]},
            "best": {"bucket": best["bucket"], "recall": best["recall"], "n_gt": best["n_gt"], "ref": best["id"]},
        }
        if key in sens:
            entry["slope_per_unit"] = sens[key]["slope_per_unit"]
            entry["sensitivity_ref"] = sens[key]["id"]
            if key in HARSHER_WHEN_HIGHER:
                entry["direction"] = "degrades as value increases" if sens[key]["slope_per_unit"] < 0 else "no degradation with increasing value"
            elif key == "lighting":
                entry["direction"] = "degrades as lighting decreases" if sens[key]["slope_per_unit"] > 0 else "no degradation with darker scenes"
        spreads.append(entry)
    spreads.sort(key=lambda e: -e["delta_recall"])
    out["condition_spreads"] = spreads
    cond_spreads = [e for e in spreads if e["kind"] == "condition"]
    out["most_degrading_condition"] = cond_spreads[0] if cond_spreads else None
    attr_spreads = [e for e in spreads if e["kind"] == "attribute"]
    out["most_degrading_object_attribute"] = attr_spreads[0] if attr_spreads else None

    best_f1 = metrics["pr"]["best_f1"]
    ov = metrics["overall"]
    out["threshold_analysis"] = {
        "configured_conf": metrics["conf_threshold"],
        "f1_at_configured_conf": ov["f1"],
        "best_f1_conf": best_f1["conf"] if best_f1 else None,
        "best_f1": best_f1["f1"] if best_f1 else None,
        "tp_below_conf_threshold": metrics["tp_below_conf_threshold"],
        "refs": ["pr:best_f1", "overall", "threshold"],
    }
    hw = []
    for b in metrics["hardware_profiles"]:
        hw.append({"profile": b["profile"], "kind": b["kind"], "latency_ms_p50": b["latency_ms_p50"], "fps": b["fps"],
                   "budget_fps_required": b["budget_fps_required"], "meets_budget": b["meets_budget"],
                   "ref": f"hardware:{b['profile']}"})
    out["hardware_suitability"] = hw
    envs = (dataset.get("conditions") or {}).get("environment", {}).get("values") or []
    out["environments"] = envs
    out["mock"] = bool(run["mock"])
    return out
