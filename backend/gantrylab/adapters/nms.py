"""YOLOv8 output decoding and non-maximum suppression in pure numpy."""

from __future__ import annotations

import numpy as np


def box_iou_one_to_many(box: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    """IoU between one xyxy box and an (N, 4) array of xyxy boxes."""
    x1 = np.maximum(box[0], boxes[:, 0])
    y1 = np.maximum(box[1], boxes[:, 1])
    x2 = np.minimum(box[2], boxes[:, 2])
    y2 = np.minimum(box[3], boxes[:, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    a = max(0.0, (box[2] - box[0])) * max(0.0, (box[3] - box[1]))
    b = np.clip(boxes[:, 2] - boxes[:, 0], 0, None) * np.clip(boxes[:, 3] - boxes[:, 1], 0, None)
    union = a + b - inter
    return np.where(union > 0, inter / np.where(union > 0, union, 1), 0.0)


def nms(boxes: np.ndarray, scores: np.ndarray, iou_thres: float) -> np.ndarray:
    """Greedy NMS. Returns kept indices sorted by descending score."""
    if boxes.shape[0] == 0:
        return np.zeros((0,), dtype=np.int64)
    order = np.argsort(-scores, kind="stable")
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        ious = box_iou_one_to_many(boxes[i], boxes[order[1:]])
        order = order[1:][ious <= iou_thres]
    return np.asarray(keep, dtype=np.int64)


def decode_yolov8(
    output: np.ndarray,
    conf_thres: float,
    iou_thres: float,
    max_det: int,
    max_wh: float = 7680.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Decode a YOLOv8 detect head output of shape (1, 4+nc, N) or (1, N, 4+nc).

    Returns (boxes_xyxy[K,4], scores[K], class_ids[K]) in network-input pixel space.
    Class-aware NMS uses the per-class coordinate offset trick.
    """
    out = np.asarray(output)
    if out.ndim == 3:
        out = out[0]
    if out.ndim != 2:
        raise ValueError(f"unexpected YOLO output shape {np.asarray(output).shape}")
    # Channels are the small dimension (4 + nc); anchors are the large one.
    if out.shape[0] < out.shape[1]:
        out = out.T
    if out.shape[1] < 5:
        raise ValueError("YOLO output has fewer than 5 channels")
    cxcywh = out[:, :4].astype(np.float32)
    cls_scores = out[:, 4:].astype(np.float32)
    class_ids = np.argmax(cls_scores, axis=1)
    scores = cls_scores[np.arange(cls_scores.shape[0]), class_ids]
    mask = scores >= conf_thres
    cxcywh, scores, class_ids = cxcywh[mask], scores[mask], class_ids[mask]
    if scores.size == 0:
        return np.zeros((0, 4), np.float32), np.zeros((0,), np.float32), np.zeros((0,), np.int64)
    boxes = np.empty_like(cxcywh)
    boxes[:, 0] = cxcywh[:, 0] - cxcywh[:, 2] / 2
    boxes[:, 1] = cxcywh[:, 1] - cxcywh[:, 3] / 2
    boxes[:, 2] = cxcywh[:, 0] + cxcywh[:, 2] / 2
    boxes[:, 3] = cxcywh[:, 1] + cxcywh[:, 3] / 2
    # Pre-NMS cap like Ultralytics (max_nms = 30000).
    if scores.size > 30000:
        top = np.argsort(-scores, kind="stable")[:30000]
        boxes, scores, class_ids = boxes[top], scores[top], class_ids[top]
    offset = class_ids.astype(np.float32)[:, None] * max_wh
    keep = nms(boxes + offset, scores, iou_thres)[:max_det]
    return boxes[keep], scores[keep], class_ids[keep].astype(np.int64)


def letterbox(img: np.ndarray, new_size: int, color: int = 114) -> tuple[np.ndarray, float, tuple[float, float]]:
    """Resize keeping aspect ratio and pad to a square ``new_size`` canvas.

    ``img`` is HWC uint8 RGB. Returns (canvas, gain, (pad_x, pad_y)).
    """
    from PIL import Image

    h, w = img.shape[:2]
    gain = min(new_size / h, new_size / w)
    nw, nh = int(round(w * gain)), int(round(h * gain))
    resized = np.asarray(Image.fromarray(img).resize((nw, nh), Image.BILINEAR))
    canvas = np.full((new_size, new_size, 3), color, dtype=np.uint8)
    px = (new_size - nw) / 2
    py = (new_size - nh) / 2
    left, top = int(round(px - 0.1)), int(round(py - 0.1))
    canvas[top : top + nh, left : left + nw] = resized
    return canvas, gain, (left, top)
