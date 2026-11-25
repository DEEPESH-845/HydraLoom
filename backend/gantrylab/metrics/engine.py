"""Detection metrics engine (pure numpy). This module is the source of truth for every number.

Input frames are plain dicts::

    {
      "file": "000001.png", "width": 640, "height": 480,
      "conditions": {...},
      "gt":    [{"class": "MINE", "bbox": [x1, y1, x2, y2], "attrs": {...}}],
      "preds": [{"class": "MINE", "bbox": [x1, y1, x2, y2], "conf": 0.91}],
    }

Conventions (documented in docs/API_V1.md):

* Matching is COCO style: per frame and per class, predictions are visited in descending
  confidence order and each takes the unmatched ground truth with the highest IoU >= threshold.
* AP uses COCO 101-point interpolation over the monotone precision envelope.
* Precision is ``None`` when there are no predictions, recall is ``None`` when there is no
  ground truth, AP is ``None`` for classes without ground truth (excluded from mAP).
* The confusion matrix is indexed ``[gt_class][pred_class]`` with an extra ``background`` index.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from .buckets import (
    DISTANCE_EDGES,
    NUMERIC_EDGES,
    OCCLUSION_EDGES,
    SIZE_EDGES,
    Bucket,
    bucket_from_edges,
    condition_bucket,
    dynamic_numeric_edges,
    occlusion_value,
)

IOU_THRESHOLDS = np.round(np.linspace(0.5, 0.95, 10), 2)
REC_THRESHOLDS = np.linspace(0.0, 1.0, 101)
CONFUSION_IOU = 0.45
MIN_SUPPORT = 5
FAILURE_CAP = 200
HIST_BINS = np.round(np.linspace(0.0, 1.0, 11), 2)


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Pairwise IoU between (N,4) and (M,4) xyxy arrays. Degenerate boxes give IoU 0."""
    a = np.asarray(a, dtype=np.float64).reshape(-1, 4)
    b = np.asarray(b, dtype=np.float64).reshape(-1, 4)
    if a.shape[0] == 0 or b.shape[0] == 0:
        return np.zeros((a.shape[0], b.shape[0]))
    x1 = np.maximum(a[:, None, 0], b[None, :, 0])
    y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2])
    y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_a = np.clip(a[:, 2] - a[:, 0], 0, None) * np.clip(a[:, 3] - a[:, 1], 0, None)
    area_b = np.clip(b[:, 2] - b[:, 0], 0, None) * np.clip(b[:, 3] - b[:, 1], 0, None)
    union = area_a[:, None] + area_b[None, :] - inter
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(union > 0, inter / union, 0.0)
    return out


def box_area(b: list[float]) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def xywh_to_xyxy(b: list[float]) -> list[float]:
    x, y, w, h = b
    return [x, y, x + w, y + h]


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def match_class_in_frame(
    gt_boxes: np.ndarray,
    gt_ignore: np.ndarray,
    pred_boxes: np.ndarray,
    pred_scores: np.ndarray,
    iou_thr: float,
    pred_out_of_range: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """COCO greedy matching for one class in one frame at one IoU threshold.

    Returns (pred_gt_index[-1 if unmatched], pred_ignore[bool], order) where ``order`` is the
    descending-confidence visiting order (stable) and outputs are indexed in the ORIGINAL
    prediction order.
    """
    n_p = pred_boxes.shape[0]
    n_g = gt_boxes.shape[0]
    match = np.full(n_p, -1, dtype=np.int64)
    ignore = np.zeros(n_p, dtype=bool)
    order = np.argsort(-pred_scores, kind="mergesort")
    if n_g:
        ious = iou_matrix(pred_boxes, gt_boxes)
        gt_order = np.argsort(gt_ignore.astype(np.int8), kind="mergesort")  # non-ignored first
        gt_taken = np.zeros(n_g, dtype=bool)
        for d in order:
            best = min(iou_thr, 1 - 1e-10)
            m = -1
            for g in gt_order:
                if gt_taken[g]:
                    continue
                if m > -1 and not gt_ignore[m] and gt_ignore[g]:
                    break
                if ious[d, g] < best:
                    continue
                best = ious[d, g]
                m = g
            if m == -1:
                continue
            gt_taken[m] = True
            match[d] = m
            ignore[d] = bool(gt_ignore[m])
    if pred_out_of_range is not None:
        ignore |= (match == -1) & pred_out_of_range
    return match, ignore, order


@dataclass
class ClassRecords:
    scores: list[np.ndarray] = field(default_factory=list)
    tp: list[np.ndarray] = field(default_factory=list)  # (T, n) per frame chunk
    ignore: list[np.ndarray] = field(default_factory=list)
    frame: list[np.ndarray] = field(default_factory=list)
    pred_index: list[np.ndarray] = field(default_factory=list)
    gt_index: list[np.ndarray] = field(default_factory=list)  # (T, n) matched GT index in frame, -1 if none

    def concat(self, n_t: int) -> tuple[np.ndarray, ...]:
        if not self.scores:
            z = np.zeros(0)
            zi = np.zeros(0, dtype=np.int64)
            return (z, np.zeros((n_t, 0), bool), np.zeros((n_t, 0), bool), zi, zi,
                    np.zeros((n_t, 0), dtype=np.int64))
        return (
            np.concatenate(self.scores),
            np.concatenate(self.tp, axis=1),
            np.concatenate(self.ignore, axis=1),
            np.concatenate(self.frame),
            np.concatenate(self.pred_index),
            np.concatenate(self.gt_index, axis=1),
        )


@dataclass
class MatchTable:
    """Per-class prediction match records over a set of frames."""

    classes: list[str]
    iou_thresholds: np.ndarray
    scores: dict[str, np.ndarray]
    tp: dict[str, np.ndarray]
    ignore: dict[str, np.ndarray]
    frame: dict[str, np.ndarray]
    pred_index: dict[str, np.ndarray]
    gt_index: dict[str, np.ndarray]  # (T, n) matched GT index within the frame, -1 if unmatched
    npos_per_frame: dict[str, np.ndarray]  # (n_frames,) non-ignored GT counts

    def at_threshold(self, ti: int) -> "MatchTable":
        return MatchTable(
            classes=self.classes,
            iou_thresholds=self.iou_thresholds[ti : ti + 1],
            scores=self.scores,
            tp={c: self.tp[c][ti : ti + 1] for c in self.classes},
            ignore={c: self.ignore[c][ti : ti + 1] for c in self.classes},
            frame=self.frame,
            pred_index=self.pred_index,
            gt_index={c: self.gt_index[c][ti : ti + 1] for c in self.classes},
            npos_per_frame=self.npos_per_frame,
        )

    def subset(self, frame_mask: np.ndarray) -> "MatchTable":
        sel = {c: frame_mask[self.frame[c]] if self.frame[c].size else np.zeros(0, bool) for c in self.classes}
        return MatchTable(
            classes=self.classes,
            iou_thresholds=self.iou_thresholds,
            scores={c: self.scores[c][sel[c]] for c in self.classes},
            tp={c: self.tp[c][:, sel[c]] for c in self.classes},
            ignore={c: self.ignore[c][:, sel[c]] for c in self.classes},
            frame={c: self.frame[c][sel[c]] for c in self.classes},
            pred_index={c: self.pred_index[c][sel[c]] for c in self.classes},
            gt_index={c: self.gt_index[c][:, sel[c]] for c in self.classes},
            npos_per_frame={c: np.where(frame_mask, self.npos_per_frame[c], 0) for c in self.classes},
        )

    def npos(self, c: str) -> int:
        return int(self.npos_per_frame[c].sum())


GtIgnoreFn = Callable[[dict, dict], bool]
PredOutFn = Callable[[dict, dict], bool]


def build_match_table(
    frames: list[dict],
    classes: list[str],
    iou_thresholds: np.ndarray = IOU_THRESHOLDS,
    gt_ignore_fn: GtIgnoreFn | None = None,
    pred_out_of_range_fn: PredOutFn | None = None,
) -> MatchTable:
    n_t = len(iou_thresholds)
    recs = {c: ClassRecords() for c in classes}
    npos = {c: np.zeros(len(frames), dtype=np.int64) for c in classes}
    for fi, fr in enumerate(frames):
        gts = fr.get("gt", [])
        preds = fr.get("preds", [])
        gt_by_c: dict[str, list[int]] = defaultdict(list)
        pr_by_c: dict[str, list[int]] = defaultdict(list)
        for gi, g in enumerate(gts):
            gt_by_c[g["class"]].append(gi)
        for pi, p in enumerate(preds):
            pr_by_c[p["class"]].append(pi)
        for c in classes:
            gidx = gt_by_c.get(c, [])
            pidx = pr_by_c.get(c, [])
            g_ign = np.array([bool(gt_ignore_fn(gts[i], fr)) if gt_ignore_fn else False for i in gidx], dtype=bool)
            npos[c][fi] = int((~g_ign).sum()) if gidx else 0
            if not pidx:
                continue
            g_boxes = np.array([gts[i]["bbox"] for i in gidx], dtype=np.float64).reshape(-1, 4)
            p_boxes = np.array([preds[i]["bbox"] for i in pidx], dtype=np.float64).reshape(-1, 4)
            p_scores = np.array([preds[i]["conf"] for i in pidx], dtype=np.float64)
            p_oor = (
                np.array([bool(pred_out_of_range_fn(preds[i], fr)) for i in pidx], dtype=bool)
                if pred_out_of_range_fn
                else None
            )
            tp = np.zeros((n_t, len(pidx)), dtype=bool)
            ig = np.zeros((n_t, len(pidx)), dtype=bool)
            gix = np.full((n_t, len(pidx)), -1, dtype=np.int64)
            gidx_arr = np.array(gidx, dtype=np.int64)
            for ti, thr in enumerate(iou_thresholds):
                m, ign, _ = match_class_in_frame(g_boxes, g_ign, p_boxes, p_scores, float(thr), p_oor)
                tp[ti] = (m >= 0) & ~ign
                ig[ti] = ign
                if gidx_arr.size:
                    gix[ti] = np.where(m >= 0, gidx_arr[np.clip(m, 0, None)], -1)
            r = recs[c]
            r.scores.append(p_scores)
            r.tp.append(tp)
            r.ignore.append(ig)
            r.frame.append(np.full(len(pidx), fi, dtype=np.int64))
            r.pred_index.append(np.array(pidx, dtype=np.int64))
            r.gt_index.append(gix)
    cat = {c: recs[c].concat(n_t) for c in classes}
    return MatchTable(
        classes=list(classes),
        iou_thresholds=np.asarray(iou_thresholds),
        scores={c: cat[c][0] for c in classes},
        tp={c: cat[c][1] for c in classes},
        ignore={c: cat[c][2] for c in classes},
        frame={c: cat[c][3] for c in classes},
        pred_index={c: cat[c][4] for c in classes},
        gt_index={c: cat[c][5] for c in classes},
        npos_per_frame=npos,
    )


# ---------------------------------------------------------------------------
# AP / PR
# ---------------------------------------------------------------------------


def ap_101(scores: np.ndarray, tp: np.ndarray, ignore: np.ndarray, npos: int) -> tuple[float | None, np.ndarray]:
    """COCO 101-point interpolated AP for one class and one IoU threshold.

    Returns (AP or None when npos == 0, interpolated precision at the 101 recall thresholds).
    """
    q = np.zeros(len(REC_THRESHOLDS))
    if npos == 0:
        return None, q
    keep = ~ignore
    s = scores[keep]
    t = tp[keep]
    if s.size == 0:
        return 0.0, q
    order = np.argsort(-s, kind="mergesort")
    t = t[order]
    tps = np.cumsum(t).astype(np.float64)
    fps = np.cumsum(~t).astype(np.float64)
    rc = tps / npos
    pr = tps / np.maximum(tps + fps, np.finfo(np.float64).eps)
    pr = np.maximum.accumulate(pr[::-1])[::-1]
    inds = np.searchsorted(rc, REC_THRESHOLDS, side="left")
    valid = inds < len(pr)
    q[valid] = pr[inds[valid]]
    return float(q.mean()), q


def _ratio(num: float, den: float) -> float | None:
    return float(num) / float(den) if den > 0 else None


def _f1(p: float | None, r: float | None) -> float | None:
    if p is None or r is None:
        return None
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)


def counts_at_conf(table: MatchTable, c: str, conf: float, ti: int = 0) -> tuple[int, int, int]:
    s = table.scores[c]
    keep = (s >= conf) & ~table.ignore[c][ti]
    tp = int((table.tp[c][ti] & keep).sum())
    fp = int((~table.tp[c][ti] & keep).sum())
    fn = table.npos(c) - tp
    return tp, fp, fn


def summarise(table: MatchTable, conf: float, with_coco: bool = True) -> dict[str, Any]:
    """Per-class and overall P/R/F1 at ``conf`` (IoU 0.5) plus AP50 and AP50:95."""
    per_class: dict[str, dict] = {}
    ap50s, ap5095s = [], []
    tot_tp = tot_fp = tot_fn = 0
    n_t = len(table.iou_thresholds)
    i50 = int(np.argmin(np.abs(table.iou_thresholds - 0.5)))
    for c in table.classes:
        npos = table.npos(c)
        tp, fp, fn = counts_at_conf(table, c, conf, i50)
        tot_tp += tp
        tot_fp += fp
        tot_fn += fn
        p = _ratio(tp, tp + fp)
        r = _ratio(tp, npos)
        ap50, _ = ap_101(table.scores[c], table.tp[c][i50], table.ignore[c][i50], npos)
        ap5095 = None
        if with_coco and n_t > 1 and npos > 0:
            vals = [ap_101(table.scores[c], table.tp[c][ti], table.ignore[c][ti], npos)[0] for ti in range(n_t)]
            ap5095 = float(np.mean(vals))
        if ap50 is not None:
            ap50s.append(ap50)
        if ap5095 is not None:
            ap5095s.append(ap5095)
        per_class[c] = {
            "support": npos,
            "n_pred": int(((table.scores[c] >= conf) & ~table.ignore[c][i50]).sum()),
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precision": p,
            "recall": r,
            "f1": _f1(p, r),
            "ap50": ap50,
            "ap50_95": ap5095,
        }
    n_gt = tot_tp + tot_fn
    p = _ratio(tot_tp, tot_tp + tot_fp)
    r = _ratio(tot_tp, n_gt)
    return {
        "per_class": per_class,
        "overall": {
            "n_gt": n_gt,
            "tp": tot_tp,
            "fp": tot_fp,
            "fn": tot_fn,
            "precision": p,
            "recall": r,
            "f1": _f1(p, r),
            "map50": float(np.mean(ap50s)) if ap50s else None,
            "map50_95": float(np.mean(ap5095s)) if (with_coco and ap5095s) else None,
            "n_classes_evaluated": len(ap50s),
        },
    }


def pr_curves(table: MatchTable) -> dict[str, Any]:
    """PR curve per class (101-point interpolated, IoU 0.5) and a micro confidence sweep."""
    i50 = int(np.argmin(np.abs(table.iou_thresholds - 0.5)))
    per_class = {}
    for c in table.classes:
        npos = table.npos(c)
        ap, q = ap_101(table.scores[c], table.tp[c][i50], table.ignore[c][i50], npos)
        if ap is None:
            continue
        per_class[c] = {"recall": REC_THRESHOLDS.round(2).tolist(), "precision": q.round(4).tolist(), "ap50": ap}
    thresholds = np.round(np.linspace(0.0, 1.0, 101), 2)
    sweep_p, sweep_r, sweep_f1 = [], [], []
    total_pos = sum(table.npos(c) for c in table.classes)
    all_s = np.concatenate([table.scores[c][~table.ignore[c][i50]] for c in table.classes]) if table.classes else np.zeros(0)
    all_t = np.concatenate([table.tp[c][i50][~table.ignore[c][i50]] for c in table.classes]) if table.classes else np.zeros(0, bool)
    for thr in thresholds:
        k = all_s >= thr
        tp = int(all_t[k].sum())
        fp = int((~all_t[k]).sum())
        p = _ratio(tp, tp + fp)
        r = _ratio(tp, total_pos)
        sweep_p.append(p)
        sweep_r.append(r)
        sweep_f1.append(_f1(p, r))
    best_i = None
    best_f1 = -1.0
    for i, f in enumerate(sweep_f1):
        if f is not None and f > best_f1 + 1e-12:
            best_f1 = f
            best_i = i
    best = None
    if best_i is not None:
        best = {
            "conf": float(thresholds[best_i]),
            "f1": sweep_f1[best_i],
            "precision": sweep_p[best_i],
            "recall": sweep_r[best_i],
        }
    return {
        "per_class": per_class,
        "conf_sweep": {
            "thresholds": thresholds.tolist(),
            "precision": sweep_p,
            "recall": sweep_r,
            "f1": sweep_f1,
        },
        "best_f1": best,
        "iou_threshold": 0.5,
    }


# ---------------------------------------------------------------------------
# Confusion matrix and failure lists
# ---------------------------------------------------------------------------


def confusion_and_failures(
    frames: list[dict],
    classes: list[str],
    table50: MatchTable,
    conf: float,
    cap: int = FAILURE_CAP,
) -> dict[str, Any]:
    """Confusion matrix ``[gt][pred]`` with background, FP / FN lists and confidence histograms.

    Same-class matches use IoU >= 0.5 (from ``table50``).
    Unmatched predictions with IoU >= 0.45 to an unmatched GT of another class are class confusions.
    """
    idx = {c: i for i, c in enumerate(classes)}
    n = len(classes)
    bg = n
    cm = np.zeros((n + 1, n + 1), dtype=np.int64)
    fps: list[dict] = []
    fns: list[dict] = []
    fp_types: dict[str, int] = defaultdict(int)
    fn_types: dict[str, int] = defaultdict(int)
    hist_tp = np.zeros(len(HIST_BINS) - 1, dtype=np.int64)
    hist_fp = np.zeros(len(HIST_BINS) - 1, dtype=np.int64)
    tp_below_conf = 0
    confused_pairs: dict[tuple[str, str], int] = defaultdict(int)

    # (frame, pred_index) -> (tp at IoU 0.5, matched GT index) for every prediction.
    lookup: dict[tuple[int, int], tuple[bool, int]] = {}
    for c in classes:
        for f, pi, t, g in zip(table50.frame[c], table50.pred_index[c], table50.tp[c][0], table50.gt_index[c][0]):
            lookup[(int(f), int(pi))] = (bool(t), int(g))

    for fi, fr in enumerate(frames):
        gts = fr.get("gt", [])
        preds = fr.get("preds", [])
        for pi, p in enumerate(preds):
            is_tp = lookup.get((fi, pi), (False, -1))[0]
            b = int(np.clip(np.searchsorted(HIST_BINS, p["conf"], side="right") - 1, 0, len(HIST_BINS) - 2))
            if is_tp:
                hist_tp[b] += 1
                if p["conf"] < conf:
                    tp_below_conf += 1
            else:
                hist_fp[b] += 1
        kept = [pi for pi, p in enumerate(preds) if p["conf"] >= conf]
        # Greedy matching visits higher confidence first, so the matches of predictions above the
        # threshold are identical to matching only those predictions.
        tp_kept = [pi for pi in kept if lookup.get((fi, pi), (False, -1))[0]]
        gt_matched_at_conf = np.zeros(len(gts), dtype=bool)
        for pi in tp_kept:
            gt_matched_at_conf[lookup[(fi, pi)][1]] = True
        for pi in tp_kept:
            ci = idx.get(preds[pi]["class"])
            if ci is not None:
                cm[ci, ci] += 1
        unmatched_preds = sorted([pi for pi in kept if not lookup.get((fi, pi), (False, -1))[0]],
                                 key=lambda i: -preds[i]["conf"])
        gt_boxes = np.array([g["bbox"] for g in gts], dtype=np.float64).reshape(-1, 4)
        consumed = gt_matched_at_conf.copy()
        for pi in unmatched_preds:
            p = preds[pi]
            ious = iou_matrix(np.array([p["bbox"]]), gt_boxes)[0] if len(gts) else np.zeros(0)
            same = np.array([g["class"] == p["class"] for g in gts], dtype=bool)
            ftype = "background"
            gt_class = None
            best_iou = float(ious.max()) if ious.size else 0.0
            other = (~same) & (~consumed) & (ious >= CONFUSION_IOU)
            if ious.size and (same & (ious >= 0.5)).any():
                ftype = "duplicate"
            elif other.any():
                gk = int(np.argmax(np.where(other, ious, -1)))
                consumed[gk] = True
                gt_class = gts[gk]["class"]
                ftype = "class_confusion"
                if gt_class in idx and p["class"] in idx:
                    cm[idx[gt_class], idx[p["class"]]] += 1
                confused_pairs[(gt_class, p["class"])] += 1
            elif ious.size and (same & (ious >= 0.1)).any():
                ftype = "localization"
            if ftype != "class_confusion" and p["class"] in idx:
                cm[bg, idx[p["class"]]] += 1
            fp_types[ftype] += 1
            if len(fps) < cap:
                fps.append({
                    "file": fr.get("file"),
                    "class_name": p["class"],
                    "bbox_xyxy": [round(float(v), 2) for v in p["bbox"]],
                    "conf": round(float(p["conf"]), 4),
                    "type": ftype,
                    "gt_class": gt_class,
                    "best_iou": round(best_iou, 3),
                    "conditions": fr.get("conditions", {}),
                })
        for gi, g in enumerate(gts):
            if gt_matched_at_conf[gi]:
                continue
            if consumed[gi]:
                reason = "misclassified"
            else:
                ci = idx.get(g["class"])
                if ci is not None:
                    cm[ci, bg] += 1
                reason = "missed"
                same_preds = [p for p in preds if p["class"] == g["class"]]
                if same_preds:
                    ious = iou_matrix(np.array([g["bbox"]]), np.array([p["bbox"] for p in same_preds]))[0]
                    above = [p["conf"] >= conf for p in same_preds]
                    if any(i >= 0.5 for i, a in zip(ious, above) if not a):
                        reason = "below_conf_threshold"
                    elif any(0.1 <= i < 0.5 for i, a in zip(ious, above) if a):
                        reason = "mislocalized"
            fn_types[reason] += 1
            if len(fns) < cap:
                attrs = g.get("attrs", {})
                fns.append({
                    "file": fr.get("file"),
                    "class_name": g["class"],
                    "bbox_xyxy": [round(float(v), 2) for v in g["bbox"]],
                    "reason": reason,
                    "object_id": attrs.get("object_id"),
                    "distance_m": attrs.get("distance_m"),
                    "visible_fraction": attrs.get("visible_fraction"),
                    "occluded_fraction": attrs.get("occluded_fraction"),
                    "area_px": attrs.get("area_px"),
                    "conditions": fr.get("conditions", {}),
                })

    labels = [*classes, "background"]
    pairs = sorted(
        ({"gt_class": a, "pred_class": b, "count": n_} for (a, b), n_ in confused_pairs.items()),
        key=lambda d: (-d["count"], d["gt_class"], d["pred_class"]),
    )
    return {
        "confusion_matrix": {"labels": labels, "matrix": cm.tolist(), "axes": "rows=ground truth, cols=prediction",
                             "iou_same_class": 0.5, "iou_confusion": CONFUSION_IOU, "conf": conf},
        "false_positives": fps,
        "false_negatives": fns,
        "fp_types": dict(fp_types),
        "fn_types": dict(fn_types),
        "confused_pairs": pairs,
        "confidence_histogram": {
            "bins": HIST_BINS.tolist(),
            "tp": hist_tp.tolist(),
            "fp": hist_fp.tolist(),
            "iou_threshold": 0.5,
        },
        "tp_below_conf_threshold": tp_below_conf,
        "failure_cap": cap,
    }


# ---------------------------------------------------------------------------
# Slices
# ---------------------------------------------------------------------------


def _slice_entry(key: str, bucket: Bucket, kind: str, n_frames: int, s: dict, metric_scope: str) -> dict:
    ov = s["overall"]
    entry = {
        "key": key,
        "bucket": bucket.label,
        "order": bucket.order,
        "lo": bucket.lo,
        "hi": None if bucket.hi is None or bucket.hi == float("inf") else bucket.hi,
        "kind": kind,
        "scope": metric_scope,
        "n_frames": n_frames,
        "n_gt": ov["n_gt"],
        "tp": ov["tp"],
        "fp": ov["fp"] if metric_scope != "recall_only" else None,
        "fn": ov["fn"],
        "recall": ov["recall"],
        "precision": ov["precision"] if metric_scope != "recall_only" else None,
        "f1": ov["f1"] if metric_scope != "recall_only" else None,
        "ap50": ov["map50"] if (metric_scope == "full" and ov["n_gt"] > 0) else None,
        "low_support": ov["n_gt"] < MIN_SUPPORT,
        "id": f"slice:{key}:{bucket.label}",
    }
    return entry


def condition_slices(frames: list[dict], classes: list[str], table50: MatchTable, conf: float) -> list[dict]:
    keys: list[str] = sorted({k for fr in frames for k in (fr.get("conditions") or {}).keys()})
    dyn: dict[str, list] = {}
    for k in keys:
        if k in NUMERIC_EDGES or k == "current_dir_deg":
            continue
        vals = [(fr.get("conditions") or {}).get(k) for fr in frames]
        nums = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if nums:
            dyn[k] = dynamic_numeric_edges(nums)
    out: list[dict] = []
    for k in keys:
        groups: dict[str, tuple[Bucket, list[int]]] = {}
        for fi, fr in enumerate(frames):
            b = condition_bucket(k, (fr.get("conditions") or {}).get(k), dyn)
            if b is None:
                continue
            groups.setdefault(b.label, (b, []))[1].append(fi)
        for label, (b, fidx) in sorted(groups.items(), key=lambda kv: (kv[1][0].order, kv[0])):
            mask = np.zeros(len(frames), dtype=bool)
            mask[fidx] = True
            s = summarise(table50.subset(mask), conf, with_coco=False)
            out.append(_slice_entry(k, b, "condition", len(fidx), s, "full"))
    return out


def condition_cells(frames: list[dict], table50: MatchTable, conf: float) -> list[dict]:
    """Joint turbidity x lighting counts. Marginal slices cannot say which model wins in dark AND silty water."""
    groups: dict[tuple[str, str], list[int]] = {}
    for fi, fr in enumerate(frames):
        cond = fr.get("conditions") or {}
        t = condition_bucket("turbidity", cond.get("turbidity"))
        li = condition_bucket("lighting", cond.get("lighting"))
        if t is not None and li is not None:
            groups.setdefault((t.label, li.label), []).append(fi)
    out: list[dict] = []
    for (t, li), fidx in sorted(groups.items()):
        mask = np.zeros(len(frames), dtype=bool)
        mask[fidx] = True
        ov = summarise(table50.subset(mask), conf, with_coco=False)["overall"]
        out.append({"turbidity": t, "lighting": li, "n_frames": len(fidx), "n_gt": ov["n_gt"], "tp": ov["tp"],
                    "fp": ov["fp"], "fn": ov["fn"]})
    return out


def attribute_slices(frames: list[dict], classes: list[str], conf: float) -> list[dict]:
    """Object-attribute slices.

    * size: COCO area-range semantics (GT outside range ignored, unmatched predictions outside
      range ignored), so precision and AP50 are meaningful.
    * distance and occlusion: GT outside the bucket is ignored; predictions carry no distance or
      occlusion, so only recall is reported (precision would be undefined or misleading).
    """
    out: list[dict] = []

    def gt_area(g: dict) -> float:
        a = g.get("attrs", {}).get("area_px")
        return float(a) if isinstance(a, (int, float)) and a > 0 else box_area(g["bbox"])

    specs: list[tuple[str, list, Callable[[dict], float | None], str]] = [
        ("object_size", SIZE_EDGES, gt_area, "full"),
        ("distance_m", DISTANCE_EDGES, lambda g: g.get("attrs", {}).get("distance_m"), "recall_only"),
        ("occlusion", OCCLUSION_EDGES, lambda g: occlusion_value(g.get("attrs", {})), "recall_only"),
    ]
    for key, edges, getter, scope in specs:
        present = [getter(g) for fr in frames for g in fr.get("gt", [])]
        if not any(isinstance(v, (int, float)) for v in present):
            continue
        for i, (lo, hi, label) in enumerate(edges):
            b = Bucket(label, i, lo, hi)

            def gt_ignore(g: dict, _fr: dict, lo: float = lo, hi: float = hi, getter: Callable = getter) -> bool:
                v = getter(g)
                if not isinstance(v, (int, float)):
                    return True
                return not (lo <= float(v) < hi)

            pred_oor = None
            if key == "object_size":
                def pred_oor(p: dict, _fr: dict, lo: float = lo, hi: float = hi) -> bool:  # noqa: E306
                    a = box_area(p["bbox"])
                    return not (lo <= a < hi)
            else:
                def pred_oor(p: dict, _fr: dict) -> bool:  # noqa: E306
                    return True
            t = build_match_table(frames, classes, np.array([0.5]), gt_ignore, pred_oor)
            s = summarise(t, conf, with_coco=False)
            if s["overall"]["n_gt"] == 0:
                continue
            n_frames = int(sum(1 for fr in frames if any(not gt_ignore(g, fr) for g in fr.get("gt", []))))
            out.append(_slice_entry(key, b, "attribute", n_frames, s, scope))
    return out


def rank_slices(slices: list[dict], min_support: int = MIN_SUPPORT, top: int = 3) -> dict[str, Any]:
    """Best and worst slices with minimum support. Keys with a single bucket are skipped."""
    by_key: dict[str, int] = defaultdict(int)
    for s in slices:
        by_key[s["key"]] += 1
    eligible = []
    excluded = 0
    for s in slices:
        metric = "f1" if s.get("f1") is not None else "recall"
        val = s.get(metric)
        if by_key[s["key"]] < 2 or val is None:
            continue
        if s["n_gt"] < min_support:
            excluded += 1
            continue
        eligible.append({**{k: s[k] for k in ("id", "key", "bucket", "kind", "n_frames", "n_gt")},
                         "metric": metric, "value": val})
    ordered = sorted(eligible, key=lambda e: (e["value"], -e["n_gt"], e["id"]))
    return {
        "min_support": min_support,
        "n_eligible": len(eligible),
        "n_excluded_low_support": excluded,
        "worst": ordered[:top],
        "best": list(reversed(ordered[-top:])) if ordered else [],
    }


def sensitivity(slices: list[dict], min_support: int = MIN_SUPPORT) -> list[dict]:
    """Least-squares slope of recall versus bucket midpoint for ordinal numeric condition keys."""
    out = []
    by_key: dict[str, list[dict]] = defaultdict(list)
    for s in slices:
        if s["kind"] == "condition" and s.get("lo") is not None and s["recall"] is not None and s["n_gt"] >= min_support:
            by_key[s["key"]].append(s)
    for key, items in sorted(by_key.items()):
        if len(items) < 2:
            continue
        xs = []
        for s in items:
            if key == "current_dir_deg":
                xs = []
                break
            hi = s["hi"]
            xs.append((s["lo"] + hi) / 2 if hi is not None else s["lo"])
        if not xs:
            continue
        x = np.array(xs, dtype=np.float64)
        y = np.array([s["recall"] for s in items], dtype=np.float64)
        if np.ptp(x) == 0:
            continue
        slope, intercept = np.polyfit(x, y, 1)
        out.append({
            "key": key,
            "metric": "recall",
            "slope_per_unit": float(slope),
            "intercept": float(intercept),
            "n_buckets": len(items),
            "recall_range": [float(y.min()), float(y.max())],
            "delta_recall": float(y.max() - y.min()),
            "buckets": [{"bucket": s["bucket"], "x": float(xx), "recall": s["recall"], "n_gt": s["n_gt"]}
                        for s, xx in zip(items, x)],
            "id": f"sensitivity:{key}",
            "note": "slope from bucket midpoints (upper open bucket uses its lower edge); association, not causation",
        })
    return out


# ---------------------------------------------------------------------------
# Top level
# ---------------------------------------------------------------------------


def evaluate(frames: list[dict], classes: list[str], conf: float) -> dict[str, Any]:
    """Run the full metrics pipeline over mapped frames."""
    table = build_match_table(frames, classes, IOU_THRESHOLDS)
    table50 = table.at_threshold(0)
    summary = summarise(table, conf, with_coco=True)
    curves = pr_curves(table)
    cf = confusion_and_failures(frames, classes, table50, conf)
    cslices = condition_slices(frames, classes, table50, conf)
    aslices = attribute_slices(frames, classes, conf)
    slices = cslices + aslices
    n_pred_total = sum(len(fr.get("preds", [])) for fr in frames)
    return {
        "conf_threshold": conf,
        "iou_thresholds": [float(x) for x in IOU_THRESHOLDS],
        "n_frames": len(frames),
        "n_frames_empty_gt": sum(1 for fr in frames if not fr.get("gt")),
        "n_predictions_total": n_pred_total,
        "overall": summary["overall"],
        "per_class": summary["per_class"],
        "pr": curves,
        **cf,
        "slices": slices,
        "condition_cells": condition_cells(frames, table50, conf),
        "slice_ranking": rank_slices(slices),
        "sensitivity": sensitivity(cslices),
    }
