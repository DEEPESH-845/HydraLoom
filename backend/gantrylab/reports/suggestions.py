"""Deterministic, evidence-grounded configuration suggestions (rules engine).

Every suggestion cites evidence item ids. An LLM may only add ``rationale`` text.
Suggestions describe what to test next; they never claim improved weights.
"""

from __future__ import annotations

import math
from typing import Any

import yaml

from ..metrics.engine import MIN_SUPPORT

# Ultralytics training defaults (ultralytics/cfg/default.yaml) used when no hyp.yaml is supplied.
ULTRALYTICS_DEFAULTS: dict[str, Any] = {
    "hsv_h": 0.015,
    "hsv_s": 0.7,
    "hsv_v": 0.4,
    "degrees": 0.0,
    "mosaic": 1.0,
    "mixup": 0.0,
    "copy_paste": 0.0,
    "cls": 0.5,
    "imgsz": 640,
}
PATCHABLE_FILES = ("data.yaml", "hyp.yaml", "inference.yaml")


def parse_user_files(user_files: dict[str, str] | None) -> tuple[dict[str, dict], list[str]]:
    parsed: dict[str, dict] = {}
    notes: list[str] = []
    for name, text in (user_files or {}).items():
        try:
            doc = yaml.safe_load(text) if text.strip() else {}
        except yaml.YAMLError as exc:
            notes.append(f"{name}: could not parse YAML ({type(exc).__name__}); defaults were used")
            continue
        if doc is None:
            doc = {}
        if not isinstance(doc, dict):
            notes.append(f"{name}: top level is not a mapping; defaults were used")
            continue
        parsed[name] = doc
    return parsed, notes


def _conf_level(n: int) -> str:
    return "high" if n >= 50 else ("medium" if n >= MIN_SUPPORT * 2 else "low")


def _round32(x: float) -> int:
    return int(math.ceil(x / 32.0) * 32)


class _Builder:
    def __init__(self, user: dict[str, dict], run_cfg: dict) -> None:
        self.user = user
        self.run_cfg = run_cfg
        self.items: list[dict] = []

    def original(self, file: str, key: str) -> tuple[Any, str]:
        doc = self.user.get(file)
        if doc is not None and key in doc:
            return doc[key], "user_file"
        if file == "inference.yaml" and key in self.run_cfg:
            return self.run_cfg[key], "run_config"
        if file == "hyp.yaml" and key in ULTRALYTICS_DEFAULTS:
            return ULTRALYTICS_DEFAULTS[key], "ultralytics_default"
        return None, "not_applicable"

    def add(self, file: str, key: str, suggested: Any, reason: str, evidence: list[str], benefit: str,
            tradeoffs: str, confidence: str, patchable: bool = True) -> None:
        orig, src = self.original(file, key) if patchable else (None, "not_applicable")
        if patchable and orig == suggested:
            return
        self.items.append({
            "id": f"sg-{len(self.items) + 1:02d}",
            "file": file,
            "key": key,
            "original": orig,
            "original_source": src,
            "suggested": suggested,
            "reason": reason,
            "evidence": list(dict.fromkeys(evidence)),
            "expected_benefit": benefit,
            "tradeoffs": tradeoffs,
            "confidence": confidence,
            "patchable": patchable and file in PATCHABLE_FILES,
            "rationale": None,
        })


def _slice(metrics: dict, sid: str) -> dict | None:
    for s in metrics["slices"]:
        if s["id"] == sid:
            return s
    return None


def _key_slices(metrics: dict, key: str) -> list[dict]:
    return [s for s in metrics["slices"] if s["key"] == key and s["recall"] is not None and s["n_gt"] >= MIN_SUPPORT]


def _gap(metrics: dict, key: str) -> tuple[dict, dict, float] | None:
    ss = _key_slices(metrics, key)
    if len(ss) < 2:
        return None
    worst = min(ss, key=lambda s: s["recall"])
    best = max(ss, key=lambda s: s["recall"])
    return worst, best, best["recall"] - worst["recall"]


def build_suggestions(metrics: dict, run: dict, analysis: dict, user_files: dict[str, str] | None) -> tuple[list[dict], list[str]]:
    user, notes = parse_user_files(user_files)
    cfg = run["config"]
    b = _Builder(user, {k: cfg[k] for k in ("conf", "iou", "imgsz", "max_det")})
    ov = metrics["overall"]
    n_gt = ov["n_gt"]

    # 1. Confidence threshold from the PR curve (threshold maximising F1).
    best = metrics["pr"]["best_f1"]
    if best and ov["f1"] is not None and abs(best["conf"] - cfg["conf"]) >= 0.05 and best["f1"] - ov["f1"] >= 0.01:
        b.add("inference.yaml", "conf", best["conf"],
              f"The confidence sweep peaks at F1={best['f1']:.3f} at conf={best['conf']:.2f}; the run used "
              f"conf={cfg['conf']:.2f} with F1={ov['f1']:.3f}.",
              ["pr:best_f1", "overall"],
              f"F1 on this synthetic dataset rises from {ov['f1']:.3f} to {best['f1']:.3f} at the same IoU 0.5 matching.",
              "Lower thresholds raise recall and false positives; higher thresholds do the opposite. "
              "Tuned on one dataset; re-check on held-out conditions.",
              _conf_level(n_gt))

    # 2. NMS IoU when duplicates dominate false positives.
    fp_types = metrics["fp_types"]
    fp_total = sum(fp_types.values())
    dup = fp_types.get("duplicate", 0)
    if dup >= 3 and fp_total and dup / fp_total >= 0.15:
        new_iou = round(max(0.45, cfg["iou"] - 0.15), 2)
        b.add("inference.yaml", "iou", new_iou,
              f"{dup} of {fp_total} false positives are duplicates of an already matched object.",
              ["fp_types"], "Fewer duplicate boxes per object, raising precision.",
              "A lower NMS IoU can suppress true detections of overlapping objects (clustered debris, pilings).",
              _conf_level(dup))

    # 3. Input resolution when small objects are missed.
    small = _slice(metrics, "slice:object_size:small")
    larger = [s for s in (_slice(metrics, "slice:object_size:medium"), _slice(metrics, "slice:object_size:large"))
              if s and s["recall"] is not None and s["n_gt"] >= MIN_SUPPORT]
    if small and small["recall"] is not None and small["n_gt"] >= MIN_SUPPORT and small["recall"] < 0.5 and larger:
        ref = max(larger, key=lambda s: s["recall"])
        if ref["recall"] - small["recall"] >= 0.2:
            new_sz = min(1280, _round32(cfg["imgsz"] * 1.5))
            refs = [small["id"], ref["id"]]
            reason = (f"Small-object recall is {small['recall']:.3f} (n_gt={small['n_gt']}) versus "
                      f"{ref['recall']:.3f} for {ref['bucket']} objects (n_gt={ref['n_gt']}).")
            b.add("inference.yaml", "imgsz", new_sz, reason, refs,
                  "More pixels per small object at inference time.",
                  "Latency grows roughly with imgsz squared; re-check the compute budget.", _conf_level(small["n_gt"]))
            b.add("hyp.yaml", "imgsz", new_sz, reason, refs,
                  "Training at the inference resolution keeps small-object features consistent.",
                  "Longer training time and more GPU memory.", _conf_level(small["n_gt"]))

    # 4. Lighting: brightness augmentation and scene lighting.
    g = _gap(metrics, "lighting")
    if g and g[2] >= 0.15:
        worst, bestl, gap = g
        refs = [worst["id"], bestl["id"]] + (["sensitivity:lighting"] if any(s["key"] == "lighting" for s in metrics["sensitivity"]) else [])
        b.add("hyp.yaml", "hsv_v", 0.6,
              f"Recall in '{worst['bucket']}' lighting is {worst['recall']:.3f} versus {bestl['recall']:.3f} in "
              f"'{bestl['bucket']}' (gap {gap:.3f}).", refs,
              "Wider brightness augmentation exposes the model to darker scenes during training.",
              "Too much brightness jitter can reduce accuracy in well-lit scenes.", _conf_level(worst["n_gt"]))
        if bestl.get("lo") is not None:
            b.add("lighting", "lighting", f">= {bestl['lo']:g}",
                  f"Detection is strongest in the '{bestl['bucket']}' lighting bucket.", refs,
                  "Operating with more illumination should move conditions toward the best-performing bucket.",
                  "More light increases backscatter in turbid water; validate jointly with turbidity.",
                  "low", patchable=False)

    # 5. Turbidity: colour / saturation augmentation and a haze augmentation note.
    g = _gap(metrics, "turbidity")
    if g and g[2] >= 0.15:
        worst, bestt, gap = g
        refs = [worst["id"], bestt["id"]] + (["sensitivity:turbidity"] if any(s["key"] == "turbidity" for s in metrics["sensitivity"]) else [])
        b.add("hyp.yaml", "hsv_s", 0.9,
              f"Recall drops from {bestt['recall']:.3f} ('{bestt['bucket']}') to {worst['recall']:.3f} "
              f"('{worst['bucket']}') turbidity.", refs,
              "Stronger saturation augmentation approximates the colour loss of turbid water.",
              "Does not model scattering or haze; pair with a haze augmentation.", _conf_level(worst["n_gt"]))
        b.add("training_notes", "augmentation.haze", "add haze / low-contrast augmentation (for example albumentations "
              "RandomFog or a custom backscatter model) with p=0.2",
              "Ultralytics hyperparameters cannot express turbidity directly.", refs,
              "Training data closer to turbid test conditions.", "Custom augmentation code to maintain.",
              "low", patchable=False)

    # 6. Motion: blur augmentation note and vehicle speed.
    for key in ("motion_blur_px", "vehicle_speed_mps"):
        g = _gap(metrics, key)
        if g and g[2] >= 0.15:
            worst, bestm, gap = g
            b.add("training_notes", f"augmentation.blur ({key})", "enable blur augmentation (albumentations Blur / "
                  "MotionBlur, p=0.1-0.2)",
                  f"Recall is {worst['recall']:.3f} at {key}='{worst['bucket']}' versus {bestm['recall']:.3f} at "
                  f"'{bestm['bucket']}'.", [worst["id"], bestm["id"]],
                  "Model sees motion-blurred objects during training.", "Can soften fine detail in sharp frames.",
                  "low", patchable=False)
            if key == "vehicle_speed_mps" and bestm.get("hi") is not None:
                b.add("camera", "vehicle_speed_mps", f"<= {bestm['hi']:g}",
                      f"Best recall occurs in the '{bestm['bucket']}' speed bucket.", [worst["id"], bestm["id"]],
                      "Less motion blur; or shorten exposure time at the same speed.",
                      "Slower survey coverage.", "low", patchable=False)
            break

    # 7. Current: small rotation augmentation for vehicle roll / pitch.
    g = _gap(metrics, "current_speed_mps")
    if g and g[2] >= 0.15:
        worst, bestc, gap = g
        b.add("hyp.yaml", "degrees", 5.0,
              f"Recall is {worst['recall']:.3f} in '{worst['bucket']}' current versus {bestc['recall']:.3f} in "
              f"'{bestc['bucket']}'; strong current induces vehicle roll and pitch.", [worst["id"], bestc["id"]],
              "Rotation augmentation covers tilted camera views.",
              "The link between current and camera tilt is an assumption; verify with attitude logs.", "low")

    # 8. Occlusion: mixup for partially hidden objects.
    g = _gap(metrics, "occlusion")
    if g and g[2] >= 0.2 and g[0]["recall"] < 0.5:
        worst, besto, gap = g
        b.add("hyp.yaml", "mixup", 0.1,
              f"Recall for '{worst['bucket']}' occlusion is {worst['recall']:.3f} (n_gt={worst['n_gt']}) versus "
              f"{besto['recall']:.3f} for '{besto['bucket']}'.", [worst["id"], besto["id"]],
              "Blended training images expose partially visible objects.",
              "Mixup can slow convergence; keep it small.", _conf_level(worst["n_gt"]))

    # 9. Class confusion: raise classification loss gain.
    pairs = metrics["confused_pairs"]
    n_conf = sum(p["count"] for p in pairs)
    if n_conf >= 3 and ov["tp"] and n_conf / max(1, ov["tp"]) >= 0.05:
        refs = [f"confusion:{p['gt_class']}->{p['pred_class']}" for p in pairs[:3]]
        b.add("hyp.yaml", "cls", 1.0,
              f"{n_conf} detections were assigned the wrong class (top pair: {pairs[0]['gt_class']} predicted as "
              f"{pairs[0]['pred_class']}, {pairs[0]['count']} times).", refs,
              "Higher classification loss weight emphasises separating confused classes.",
              "Can reduce box-regression quality; consider more training examples of the confused pair first.",
              _conf_level(n_conf))

    # 10. Class coverage: dataset classes the model does not know.
    uncovered = [c for c in run["dataset"]["classes"] if c not in {v for v in run.get("resolved_class_map", {}).values() if v}]
    if uncovered:
        names = list(run["dataset"]["classes"])
        b.add("data.yaml", "names", {i: c for i, c in enumerate(names)},
              f"The model has no class mapped to {uncovered}; those objects cannot be detected.", ["run:class_map"],
              "A model trained with these class names could be evaluated on every object in this dataset.",
              "Requires collecting labelled data and training a new model; this suggestion does not provide weights.",
              "high")
        b.add("data.yaml", "nc", len(names), "Number of classes must match names.", ["run:class_map"],
              "Consistent dataset definition.", "None.", "high")

    # 11. Class balance: under-represented classes (data collection note).
    counts = {c: m["support"] for c, m in metrics["per_class"].items() if m["support"] > 0}
    if len(counts) >= 2:
        hi_c, lo_c = max(counts, key=counts.get), min(counts, key=counts.get)
        if counts[hi_c] >= 4 * counts[lo_c]:
            b.add("data_collection", f"class_balance.{lo_c}", f"collect or oversample {lo_c} (currently "
                  f"{counts[lo_c]} vs {counts[hi_c]} for {hi_c})",
                  f"Class support is imbalanced ({lo_c}: {counts[lo_c]}, {hi_c}: {counts[hi_c]}).",
                  [f"class:{lo_c}", f"class:{hi_c}"],
                  "More reliable per-class metrics and better training balance.",
                  "More synthetic scenes to render.", "medium", patchable=False)

    # 12. Distance: approach closer when far objects are missed.
    g = _gap(metrics, "distance_m")
    if g and g[2] >= 0.2:
        worst, bestd, gap = g
        if worst.get("lo") is not None and bestd.get("hi") is not None and worst["lo"] >= bestd["hi"]:
            b.add("camera", "standoff_distance_m", f"<= {bestd['hi']:g}",
                  f"Recall at '{worst['bucket']}' is {worst['recall']:.3f} versus {bestd['recall']:.3f} at "
                  f"'{bestd['bucket']}'.", [worst["id"], bestd["id"]],
                  "Objects appear larger and less attenuated at shorter range.",
                  "Shorter standoff narrows the field of view and raises collision risk.", "low", patchable=False)
    return b.items, notes
