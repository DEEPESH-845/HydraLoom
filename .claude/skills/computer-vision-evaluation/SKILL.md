---
name: computer-vision-evaluation
description: How GANTRYLAB evaluates uploaded detection models (YOLO .pt, ONNX) against synthetic ground truth, computes metrics and writes AI engineering reports. Use before touching backend/gantrylab, the dataset capture, the Model Lab or the Reports pages.
---

# Computer vision evaluation

Contract: `docs/API_V1.md`. Architecture: `docs/ARCHITECTURE.md` section 5.

## Non-negotiables

- Uploaded `.pt` files are untrusted pickles.
  They are only ever loaded in the sandbox worker subprocess with the restricted unpickler; never in the API process, never with `weights_only=False` and the default pickle module.
- Originals are stored by SHA-256 and are read-only; patches and suggestions are separate copies.
- Ground truth comes from geometry: the instance-ID render pass of the same camera, never from detections or hand-drawn boxes.
- The analytical detector (lab and field engines) is never labelled YOLO or presented as a model evaluation.
- Mock-adapter runs are flagged `mock: true` and every view and report says "MOCK ADAPTER - not a real model evaluation".
- The metrics engine is the source of truth; the LLM writes narrative over structured evidence and its numbers are overwritten from the evidence.
- Keep measured (this host), estimated (other devices, with assumptions) and simulated values in separate fields.
- Do not send model weights, images or private datasets to an external LLM.

## Checks

```bash
cd backend && .venv/Scripts/python -m pytest tests_gantrylab -q
```
