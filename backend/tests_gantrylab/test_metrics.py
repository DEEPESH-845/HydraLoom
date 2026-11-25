"""Metrics engine reference cases computed by hand."""

from __future__ import annotations

import numpy as np
import pytest

from gantrylab.metrics.engine import (
    ap_101,
    build_match_table,
    evaluate,
    iou_matrix,
    rank_slices,
)


def fr(gt=(), preds=(), conditions=None, file="f.png"):
    """Build an engine frame. ``gt`` items are (class, xyxy) or (class, xyxy, attrs)."""
    return {
        "file": file, "width": 100, "height": 100, "conditions": conditions or {},
        "gt": [{"class": g[0], "bbox": list(g[1]), "attrs": dict(g[2]) if len(g) > 2 else {}} for g in gt],
        "preds": [{"class": c, "bbox": list(b), "conf": s} for c, b, s in preds],
    }


def test_iou_edge_cases():
    a = np.array([[0, 0, 10, 10]])
    assert iou_matrix(a, a)[0, 0] == pytest.approx(1.0)
    assert iou_matrix(a, np.array([[20, 20, 30, 30]]))[0, 0] == 0.0
    assert iou_matrix(a, np.array([[10, 0, 20, 10]]))[0, 0] == 0.0  # touching edge
    assert iou_matrix(a, np.array([[5, 0, 15, 10]]))[0, 0] == pytest.approx(1 / 3)
    assert iou_matrix(a, np.array([[0, 0, 10, 20]]))[0, 0] == pytest.approx(0.5)
    assert iou_matrix(np.array([[5, 5, 5, 5]]), a)[0, 0] == 0.0  # degenerate zero-area box
    assert iou_matrix(np.zeros((0, 4)), a).shape == (0, 1)


def test_perfect_predictions():
    frames = [
        fr(gt=[("A", (0, 0, 10, 10)), ("B", (20, 20, 40, 40))],
           preds=[("A", (0, 0, 10, 10), 0.9), ("B", (20, 20, 40, 40), 0.8)], file="1.png"),
        fr(gt=[("A", (50, 50, 70, 70))], preds=[("A", (50, 50, 70, 70), 0.95)], file="2.png"),
    ]
    m = evaluate(frames, ["A", "B"], conf=0.25)
    ov = m["overall"]
    assert (ov["precision"], ov["recall"], ov["f1"]) == (1.0, 1.0, 1.0)
    assert ov["map50"] == pytest.approx(1.0)
    assert ov["map50_95"] == pytest.approx(1.0)
    assert m["per_class"]["A"]["ap50"] == pytest.approx(1.0)
    assert m["confusion_matrix"]["matrix"] == [[2, 0, 0], [0, 1, 0], [0, 0, 0]]
    assert m["false_positives"] == [] and m["false_negatives"] == []


def test_tiny_ap_by_hand():
    # GT g1, g2. Predictions by confidence: TP (0.9), FP (0.8), TP (0.7).
    # Cumulative precision 1, 1/2, 2/3 -> envelope 1, 2/3, 2/3; recall 0.5, 0.5, 1.0.
    # 101-point: recall thresholds 0.00..0.50 (51 points) -> 1.0; 0.51..1.00 (50 points) -> 2/3.
    # AP = (51 * 1 + 50 * 2/3) / 101 = 253/303.
    frames = [fr(gt=[("A", (0, 0, 10, 10)), ("A", (20, 20, 30, 30))],
                 preds=[("A", (0, 0, 10, 10), 0.9), ("A", (50, 50, 60, 60), 0.8), ("A", (20, 20, 30, 30), 0.7)])]
    m = evaluate(frames, ["A"], conf=0.75)
    assert m["per_class"]["A"]["ap50"] == pytest.approx(253 / 303)
    # At conf 0.75 only the first two predictions count.
    assert m["overall"]["tp"] == 1 and m["overall"]["fp"] == 1 and m["overall"]["fn"] == 1
    assert m["overall"]["precision"] == pytest.approx(0.5)
    assert m["overall"]["recall"] == pytest.approx(0.5)
    m2 = evaluate(frames, ["A"], conf=0.5)
    assert m2["overall"]["precision"] == pytest.approx(2 / 3)
    assert m2["overall"]["recall"] == pytest.approx(1.0)
    assert m2["overall"]["f1"] == pytest.approx(0.8)


def test_ap_101_direct():
    ap, q = ap_101(np.array([0.9, 0.8, 0.7]), np.array([True, False, True]), np.zeros(3, bool), 2)
    assert ap == pytest.approx(253 / 303)
    assert q[50] == pytest.approx(1.0) and q[51] == pytest.approx(2 / 3)
    assert ap_101(np.zeros(0), np.zeros(0, bool), np.zeros(0, bool), 3)[0] == 0.0
    assert ap_101(np.array([0.5]), np.array([False]), np.zeros(1, bool), 0)[0] is None


def test_ap5095_partial_iou():
    # IoU 0.72: TP at thresholds 0.50..0.70 (5 of 10) => AP50:95 = 0.5.
    gt = (0, 0, 100, 100)
    pred = (0, 0, 100, 72)  # IoU = 7200 / 10000 = 0.72
    m = evaluate([fr(gt=[("A", gt)], preds=[("A", pred, 0.9)])], ["A"], conf=0.25)
    assert m["per_class"]["A"]["ap50"] == pytest.approx(1.0)
    assert m["per_class"]["A"]["ap50_95"] == pytest.approx(0.5)


def test_iou_threshold_is_inclusive():
    frames = [fr(gt=[("A", (0, 0, 10, 10))], preds=[("A", (0, 0, 10, 20), 0.9)])]  # IoU exactly 0.5
    t = build_match_table(frames, ["A"], np.array([0.5, 0.55]))
    assert t.tp["A"][0].tolist() == [True]
    assert t.tp["A"][1].tolist() == [False]


def test_greedy_by_confidence():
    # One GT. High-confidence prediction has IoU 0.6, low-confidence prediction has IoU 0.9.
    gt = (0, 0, 100, 100)
    hi = ("A", (0, 0, 100, 60), 0.9)  # IoU 0.6
    lo = ("A", (0, 0, 100, 90), 0.6)  # IoU 0.9
    t = build_match_table([fr(gt=[("A", gt)], preds=[hi, lo])], ["A"], np.array([0.5, 0.75]))
    # At 0.5 the higher-confidence prediction takes the GT (COCO greedy), the other is a duplicate FP.
    assert t.tp["A"][0].tolist() == [True, False]
    # At 0.75 the high-confidence prediction cannot match, so the low-confidence one does.
    assert t.tp["A"][1].tolist() == [False, True]
    m = evaluate([fr(gt=[("A", gt)], preds=[hi, lo])], ["A"], conf=0.25)
    assert m["fp_types"] == {"duplicate": 1}


def test_class_confusion_and_background():
    frames = [
        # GT A, predicted as B with IoU 1 -> confusion A->B, FN for A, FP for B.
        fr(gt=[("A", (0, 0, 10, 10))], preds=[("B", (0, 0, 10, 10), 0.9)], file="1.png"),
        # GT A with a B prediction at IoU 1/3 -> background FP for B and a missed A.
        fr(gt=[("A", (0, 0, 10, 10))], preds=[("B", (5, 0, 15, 10), 0.9)], file="2.png"),
        # Prediction with no GT at all -> background FP.
        fr(gt=[], preds=[("A", (60, 60, 80, 80), 0.7)], file="3.png"),
    ]
    m = evaluate(frames, ["A", "B"], conf=0.25)
    cm = m["confusion_matrix"]["matrix"]
    labels = m["confusion_matrix"]["labels"]
    assert labels == ["A", "B", "background"]
    assert cm[0][1] == 1  # A predicted as B
    assert cm[0][2] == 1  # A missed (background column)
    assert cm[2][1] == 1  # background predicted as B
    assert cm[2][0] == 1  # background predicted as A
    assert m["per_class"]["A"]["fn"] == 2 and m["per_class"]["B"]["fp"] == 2
    assert m["overall"]["precision"] == 0.0 and m["overall"]["recall"] == 0.0 and m["overall"]["f1"] == 0.0
    assert m["fp_types"] == {"class_confusion": 1, "background": 2}
    assert m["fn_types"] == {"misclassified": 1, "missed": 1}
    assert m["confused_pairs"] == [{"gt_class": "A", "pred_class": "B", "count": 1}]


def test_confusion_threshold_045():
    gt = (0, 0, 100, 100)
    pred = ("B", (0, 0, 100, 47), 0.9)  # IoU 0.47 with GT A: >= 0.45 -> confusion
    m = evaluate([fr(gt=[("A", gt)], preds=[pred])], ["A", "B"], conf=0.25)
    assert m["confusion_matrix"]["matrix"][0][1] == 1
    pred2 = ("B", (0, 0, 100, 44), 0.9)  # IoU 0.44 -> background
    m2 = evaluate([fr(gt=[("A", gt)], preds=[pred2])], ["A", "B"], conf=0.25)
    assert m2["confusion_matrix"]["matrix"][0][1] == 0
    assert m2["confusion_matrix"]["matrix"][2][1] == 1


def test_empty_frames():
    m = evaluate([fr(), fr(file="2.png")], ["A"], conf=0.25)
    ov = m["overall"]
    assert ov["n_gt"] == 0 and ov["precision"] is None and ov["recall"] is None and ov["map50"] is None
    assert m["per_class"]["A"]["ap50"] is None
    m2 = evaluate([fr(preds=[("A", (0, 0, 5, 5), 0.9)])], ["A"], conf=0.25)
    assert m2["overall"]["precision"] == 0.0 and m2["overall"]["recall"] is None
    assert m2["n_frames_empty_gt"] == 1


def test_class_without_gt_excluded_from_map():
    frames = [fr(gt=[("A", (0, 0, 10, 10))], preds=[("A", (0, 0, 10, 10), 0.9), ("B", (50, 50, 60, 60), 0.9)])]
    m = evaluate(frames, ["A", "B"], conf=0.25)
    assert m["per_class"]["B"]["ap50"] is None
    assert m["overall"]["map50"] == pytest.approx(1.0)
    assert m["overall"]["n_classes_evaluated"] == 1


def test_missed_class_ap_zero_and_below_conf_reason():
    frames = [fr(gt=[("A", (0, 0, 10, 10))], preds=[("A", (0, 0, 10, 10), 0.1)])]
    m = evaluate(frames, ["A"], conf=0.25)
    assert m["per_class"]["A"]["recall"] == 0.0
    assert m["per_class"]["A"]["ap50"] == pytest.approx(1.0)  # AP is threshold free
    assert m["fn_types"] == {"below_conf_threshold": 1}
    assert m["tp_below_conf_threshold"] == 1
    m2 = evaluate([fr(gt=[("A", (0, 0, 10, 10))])], ["A"], conf=0.25)
    assert m2["per_class"]["A"]["ap50"] == 0.0


def test_best_f1_threshold():
    frames = [fr(gt=[("A", (0, 0, 10, 10)), ("A", (20, 20, 30, 30))],
                 preds=[("A", (0, 0, 10, 10), 0.9), ("A", (20, 20, 30, 30), 0.6), ("A", (50, 50, 60, 60), 0.3)])]
    m = evaluate(frames, ["A"], conf=0.25)
    best = m["pr"]["best_f1"]
    # Thresholds in (0.30, 0.60] keep both TPs and drop the FP: F1 = 1.0. The first such sweep point is 0.31.
    assert best["f1"] == pytest.approx(1.0)
    assert best["conf"] == pytest.approx(0.31)


def test_condition_slices_and_ranking_support():
    frames = []
    for i in range(10):
        clear = i < 5
        cond = {"turbidity": 0.05 if clear else 0.8, "environment": "harbor"}
        gts = [("A", (0, 0, 10, 10)), ("A", (20, 20, 30, 30))]
        preds = [("A", (0, 0, 10, 10), 0.9), ("A", (20, 20, 30, 30), 0.9)] if clear else [("A", (0, 0, 10, 10), 0.9)]
        frames.append(fr(gt=gts, preds=preds, conditions=cond, file=f"{i}.png"))
    m = evaluate(frames, ["A"], conf=0.25)
    sl = {s["id"]: s for s in m["slices"]}
    assert sl["slice:turbidity:clear"]["recall"] == pytest.approx(1.0)
    assert sl["slice:turbidity:clear"]["n_gt"] == 10 and sl["slice:turbidity:clear"]["n_frames"] == 5
    assert sl["slice:turbidity:heavy"]["recall"] == pytest.approx(0.5)
    assert sl["slice:environment:harbor"]["n_frames"] == 10
    rk = m["slice_ranking"]
    assert rk["worst"][0]["id"] == "slice:turbidity:heavy"
    assert all(e["key"] != "environment" for e in rk["worst"])  # single-bucket keys are not ranked
    sens = {s["key"]: s for s in m["sensitivity"]}
    assert sens["turbidity"]["slope_per_unit"] < 0
    # Ranking respects minimum support.
    r = rank_slices([{**sl["slice:turbidity:clear"], "n_gt": 3}, sl["slice:turbidity:heavy"]], min_support=5)
    assert r["n_excluded_low_support"] == 1 and len(r["worst"]) == 1


def test_size_slice_coco_ignore_semantics():
    small_gt = ("A", (0, 0, 10, 10))  # area 100 < 32^2
    large_gt = ("A", (0, 0, 200, 200))  # area 40000 > 96^2
    frames = [fr(gt=[small_gt, large_gt], preds=[("A", (0, 0, 200, 200), 0.9), ("A", (300, 300, 305, 305), 0.8)])]
    m = evaluate(frames, ["A"], conf=0.25)
    sl = {s["id"]: s for s in m["slices"]}
    small = sl["slice:object_size:small"]
    large = sl["slice:object_size:large"]
    assert small["recall"] == 0.0 and small["n_gt"] == 1
    assert small["fp"] == 1  # the small unmatched prediction counts against the small range
    assert large["recall"] == 1.0 and large["precision"] == 1.0  # small FP ignored in the large range


def test_condition_cells_are_joint_and_add_up():
    hit = dict(gt=[("A", (0, 0, 10, 10))], preds=[("A", (0, 0, 10, 10), 0.9)])
    miss = dict(gt=[("A", (0, 0, 10, 10))], preds=[("A", (50, 50, 60, 60), 0.9)])
    frames = [
        fr(**hit, conditions={"turbidity": 0.05, "lighting": 0.8}),
        fr(**miss, conditions={"turbidity": 0.05, "lighting": 0.2}),
        fr(**miss, conditions={"turbidity": 0.65, "lighting": 0.8}),
        fr(**hit, conditions={"turbidity": 0.65}),  # no lighting recorded: in no joint cell
    ]
    cells = {(c["turbidity"], c["lighting"]): c for c in evaluate(frames, ["A"], conf=0.25)["condition_cells"]}
    assert set(cells) == {("clear", "bright"), ("clear", "dark"), ("heavy", "bright")}
    assert (cells["clear", "bright"]["tp"], cells["clear", "bright"]["fp"], cells["clear", "bright"]["fn"]) == (1, 0, 0)
    assert (cells["clear", "dark"]["tp"], cells["clear", "dark"]["fp"], cells["clear", "dark"]["fn"]) == (0, 1, 1)
    assert sum(c["n_gt"] for c in cells.values()) == 3
