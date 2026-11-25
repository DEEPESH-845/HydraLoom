"""Narrative generation: deterministic templates, LLM prompting, validation, repair and number checks."""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from ..adapters import MOCK_BANNER
from ..llm import LLMProvider, ProviderError
from ..metrics.engine import MIN_SUPPORT

NUM_RE = re.compile(r"(?<![A-Za-z0-9_.])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])")


class NarrativeFinding(BaseModel):
    text: str = Field(min_length=1, max_length=800)
    evidence_refs: list[str] = Field(default_factory=list, max_length=10)


class NarrativeRec(BaseModel):
    priority: int = Field(ge=1, le=10)
    action: str = Field(min_length=1, max_length=400)
    rationale: str = Field(min_length=1, max_length=1200)
    evidence_refs: list[str] = Field(default_factory=list, max_length=10)


class LLMNarrative(BaseModel):
    overall: str = Field(min_length=1, max_length=2000)
    key_findings: list[NarrativeFinding] = Field(min_length=1, max_length=8)
    performance_breakdown: str = Field(min_length=1, max_length=3000)
    environmental_sensitivity: str = Field(min_length=1, max_length=3000)
    failure_analysis: str = Field(min_length=1, max_length=3000)
    conditions: str = Field(min_length=1, max_length=3000)
    hardware_suitability: str = Field(min_length=1, max_length=3000)
    recommendations: list[NarrativeRec] = Field(min_length=1, max_length=8)
    next_experiment_rationale: str = Field(min_length=1, max_length=2000)
    config_suggestion_rationales: dict[str, str] = Field(default_factory=dict)


NARRATIVE_FIELDS = ("overall", "performance_breakdown", "environmental_sensitivity", "failure_analysis", "conditions",
                    "hardware_suitability", "next_experiment_rationale")


def fmt(v: Any, nd: int = 3) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def _join_capped(parts: list[str], sep: str, limit: int) -> str:
    """Join whole parts up to ``limit`` characters so that long class lists fit the narrative schema."""
    n = used = 0
    while n < len(parts) and used + len(parts[n]) <= limit:
        used += len(parts[n]) + len(sep)
        n += 1
    return sep.join(parts[:n] + ([f"{len(parts) - n} more"] if n < len(parts) else []))


def times(n: int) -> str:
    return f"{n} time" if n == 1 else f"{n} times"


# ---------------------------------------------------------------------------
# Deterministic narrative
# ---------------------------------------------------------------------------


def deterministic_recommendations(ev: dict, suggestions: list[dict]) -> list[dict]:
    it = ev["items"]
    recs: list[dict] = []

    def add(action: str, rationale: str, refs: list[str]) -> None:
        recs.append({"priority": len(recs) + 1, "action": action, "rationale": rationale,
                     "evidence_refs": list(dict.fromkeys(r for r in refs if r in it))})

    if it["run:adapter"]["mock"]:
        add("Repeat this evaluation with the real model adapter.",
            "This run used the mock adapter, so its metrics describe simulated detections, not the model.",
            ["run:adapter"])
    cm = it["run:class_map"]
    uncovered = [c for c in cm["dataset_classes"] if c not in {v for v in cm["resolved"].values() if v}]
    if uncovered:
        add(f"Provide a class_map or a model trained on {_join_capped(uncovered, ', ', 300)}.",
            f"{len(uncovered)} dataset classes have no mapped model class, so every object of those classes is a miss.",
            ["run:class_map"])
    mdc = it["analysis:most_degrading_condition"]
    if mdc and mdc["delta_recall"] >= 0.1:
        add(f"Add training data and augmentation for {mdc['key']} = '{mdc['worst']['bucket']}'.",
            f"Recall falls from {fmt(mdc['best']['recall'])} ('{mdc['best']['bucket']}', n_gt={mdc['best']['n_gt']}) to "
            f"{fmt(mdc['worst']['recall'])} ('{mdc['worst']['bucket']}', n_gt={mdc['worst']['n_gt']}).",
            [mdc["worst"]["ref"], mdc["best"]["ref"], mdc.get("sensitivity_ref", "")])
    mm = it["analysis:most_missed_classes"]
    if mm and mm[0]["recall"] is not None and mm[0]["recall"] < 0.8:
        c = mm[0]
        add(f"Collect harder examples of {c['class']} (the most-missed class).",
            f"{c['class']} recall is {fmt(c['recall'])} with {c['fn']} misses out of {c['support']} objects.",
            [c["ref"]])
    ta = it["analysis:threshold_analysis"]
    conf_sg = next((s for s in suggestions if s["file"] == "inference.yaml" and s["key"] == "conf"), None)
    if conf_sg:
        add(f"Test conf={fmt(conf_sg['suggested'], 2)} instead of {fmt(ta['configured_conf'], 2)}.",
            f"The confidence sweep peaks at F1={fmt(ta['best_f1'])}; F1 at the configured threshold is "
            f"{fmt(ta['f1_at_configured_conf'])}.", ["pr:best_f1", "overall"])
    cp = it["analysis:confused_pairs"]
    if cp:
        p = cp[0]
        add(f"Review labels and add contrasting examples for {p['gt_class']} versus {p['pred_class']}.",
            f"{p['gt_class']} was predicted as {p['pred_class']} {times(p['count'])}.", [p["ref"]])
    for h in it["analysis:hardware_suitability"]:
        if h["kind"] == "estimated" and h["meets_budget"] is False:
            add(f"Measure on a real {h['profile']} and reduce cost (smaller model, lower imgsz or an accelerator).",
                f"Estimated p50 latency {fmt(h['latency_ms_p50'], 1)} ms gives {fmt(h['fps'], 2)} FPS against a "
                f"{fmt(h['budget_fps_required'], 1)} FPS budget (estimate, not a measurement).", [h["ref"]])
            break
    if not recs:
        add("Extend the test to harsher conditions and more frames.",
            f"No condition bucket with at least {MIN_SUPPORT} objects showed a recall gap of 0.1 or more.",
            ["ranking", "overall"])
    return recs[:8]


def deterministic_narrative(ev: dict, suggestions: list[dict], next_exp: dict) -> LLMNarrative:
    it = ev["items"]
    ov = it["overall"]
    run = ev["run"]
    mock = it["run:adapter"]["mock"]
    prefix = f"{MOCK_BANNER}. " if mock else ""
    overall = (
        f"{prefix}At conf={fmt(ov['conf_threshold'], 2)} and IoU 0.5 the model reached precision {fmt(ov['precision'])}, "
        f"recall {fmt(ov['recall'])} and F1 {fmt(ov['f1'])} over {ov['n_gt']} ground-truth objects in {ov['n_frames']} "
        f"frames. mAP@50 is {fmt(ov['map50'])} and mAP@50:95 is {fmt(ov['map50_95'])}."
    )
    findings: list[dict] = [{"text": f"Overall recall {fmt(ov['recall'])} and precision {fmt(ov['precision'])} "
                                     f"(TP={ov['tp']}, FP={ov['fp']}, FN={ov['fn']}).", "evidence_refs": ["overall"]}]
    mdc = it["analysis:most_degrading_condition"]
    if mdc:
        findings.append({"text": f"Largest condition effect: {mdc['key']} (recall {fmt(mdc['best']['recall'])} in "
                                 f"'{mdc['best']['bucket']}' versus {fmt(mdc['worst']['recall'])} in "
                                 f"'{mdc['worst']['bucket']}').",
                         "evidence_refs": [mdc["worst"]["ref"], mdc["best"]["ref"]]})
    mm = it["analysis:most_missed_classes"]
    if mm:
        findings.append({"text": f"Most-missed class: {mm[0]['class']} (recall {fmt(mm[0]['recall'])}, "
                                 f"{mm[0]['fn']} misses of {mm[0]['support']}).", "evidence_refs": [mm[0]["ref"]]})
    cp = it["analysis:confused_pairs"]
    if cp:
        findings.append({"text": f"Most frequent confusion: {cp[0]['gt_class']} predicted as {cp[0]['pred_class']} "
                                 f"({times(cp[0]['count'])}).", "evidence_refs": [cp[0]["ref"]]})
    if mock:
        findings.insert(0, {"text": MOCK_BANNER + ": detections were simulated from ground truth.",
                            "evidence_refs": ["run:adapter"]})

    pc_lines = []
    for k, v in it.items():
        if k.startswith("class:") and v["support"] > 0:
            pc_lines.append(f"{k[6:]}: P={fmt(v['precision'])}, R={fmt(v['recall'])}, AP50={fmt(v['ap50'])} "
                            f"(support {v['support']})")
    perf = (overall.replace(prefix, "") + " Per class: " + _join_capped(pc_lines, "; ", 2000) + "." if pc_lines else
            overall.replace(prefix, "") + " No class had ground truth.")
    low = it["analysis:low_support_classes"]
    if low:
        perf += f" Classes with fewer than {MIN_SUPPORT} objects ({_join_capped(low, ', ', 500)}) have unreliable per-class metrics."

    spreads = it["analysis:condition_spreads"]
    if spreads:
        parts = []
        for e in spreads[:4]:
            s = (f"{e['key']}: recall {fmt(e['best']['recall'])} ('{e['best']['bucket']}', n_gt={e['best']['n_gt']}) to "
                 f"{fmt(e['worst']['recall'])} ('{e['worst']['bucket']}', n_gt={e['worst']['n_gt']})")
            if e.get("slope_per_unit") is not None:
                s += f", slope {fmt(e['slope_per_unit'])} recall per unit"
            parts.append(s)
        env = ("Recall varies across condition buckets with at least " + str(MIN_SUPPORT) + " objects: "
               + "; ".join(parts) + ". These are associations in synthetic data, not proven causes.")
    else:
        env = (f"No condition key had two or more buckets with at least {MIN_SUPPORT} ground-truth objects, "
               "so environmental sensitivity cannot be assessed from this run.")

    fp_t = it["fp_types"]
    fn_t = it["fn_types"]
    fail = (f"False positives by type: {', '.join(f'{k}={v}' for k, v in sorted(fp_t.items())) or 'none'}. "
            f"False negatives by reason: {', '.join(f'{k}={v}' for k, v in sorted(fn_t.items())) or 'none'}.")
    th = it["threshold"]
    if th["tp_below_conf_threshold"]:
        fail += (f" {th['tp_below_conf_threshold']} correct detections scored below the conf threshold "
                 f"{fmt(th['conf_threshold'], 2)}.")

    rk = it["ranking"]
    if rk["worst"]:
        w = rk["worst"][0]
        b = rk["best"][0]
        cond = (f"Best slice: {b['key']}='{b['bucket']}' ({b['metric']} {fmt(b['value'])}, n_gt={b['n_gt']}). "
                f"Worst slice: {w['key']}='{w['bucket']}' ({w['metric']} {fmt(w['value'])}, n_gt={w['n_gt']}). "
                f"{rk['n_excluded_low_support']} slices were excluded for having fewer than {rk['min_support']} objects.")
    else:
        cond = f"No slice met the minimum support of {rk['min_support']} objects, so no best or worst condition is claimed."

    hw_parts = []
    for h in it["analysis:hardware_suitability"]:
        if h["latency_ms_p50"] is None:
            continue
        verdict = "meets" if h["meets_budget"] else "misses"
        hw_parts.append(f"{h['profile']} ({h['kind']}): p50 {fmt(h['latency_ms_p50'], 1)} ms, {fmt(h['fps'], 1)} FPS, "
                        f"{verdict} the {fmt(h['budget_fps_required'], 1)} FPS budget")
    hw = ("; ".join(hw_parts) + ". Estimated profiles are not measurements." if hw_parts else
          "No latency figures are available for this run" + (" (mock adapter)." if mock else "."))

    rationales = {s["id"]: s["reason"] for s in suggestions}
    return LLMNarrative(
        overall=overall,
        key_findings=[NarrativeFinding(**f) for f in findings[:8]],
        performance_breakdown=perf,
        environmental_sensitivity=env,
        failure_analysis=fail,
        conditions=cond,
        hardware_suitability=hw,
        recommendations=[NarrativeRec(**r) for r in deterministic_recommendations(ev, suggestions)],
        next_experiment_rationale=next_exp["rationale"],
        config_suggestion_rationales=rationales,
    )


# ---------------------------------------------------------------------------
# LLM narrative
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a senior perception test engineer writing an engineering report about an object detector evaluated on synthetic underwater imagery from a digital twin.

You receive EVIDENCE produced by a metrics engine. Rules:
1. Use only the evidence. Do not speculate beyond it.
2. Every number you write must be copied from the evidence (you may round to at most 3 decimals). Never compute or invent new numbers.
3. Cite evidence item ids (keys of EVIDENCE.items) in every evidence_refs list.
4. Never claim the model was retrained, fine-tuned or improved; suggestions are hypotheses to test.
5. If EVIDENCE.items["run:adapter"].mock is true, state clearly that this is a mock evaluation, not a real model evaluation.
6. Mention support (n_gt) when you discuss a slice, and do not over-claim from small samples.
7. Output exactly one JSON object and nothing else (no markdown fences) with these keys:
{"overall": str, "key_findings": [{"text": str, "evidence_refs": [str]}], "performance_breakdown": str, "environmental_sensitivity": str, "failure_analysis": str, "conditions": str, "hardware_suitability": str, "recommendations": [{"priority": int 1-10, "action": str, "rationale": str, "evidence_refs": [str]}], "next_experiment_rationale": str, "config_suggestion_rationales": {"<suggestion id>": str}}"""


def build_user_prompt(ev: dict, recs: list[dict], suggestions: list[dict], next_exp: dict) -> str:
    sg = [{k: s[k] for k in ("id", "file", "key", "original", "suggested", "reason", "evidence")} for s in suggestions]
    return (
        "EVIDENCE:\n" + json.dumps(ev, separators=(",", ":"), default=str)
        + "\n\nCANDIDATE_RECOMMENDATIONS (deterministic; you may reorder, merge and reword, keep evidence_refs valid):\n"
        + json.dumps(recs, separators=(",", ":"))
        + "\n\nCONFIG_SUGGESTIONS (write a one or two sentence rationale per id; do not change values):\n"
        + json.dumps(sg, separators=(",", ":"), default=str)
        + "\n\nNEXT_EXPERIMENT (write its rationale):\n" + json.dumps(next_exp, separators=(",", ":"), default=str)
    )


def extract_json(text: str) -> Any:
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```\s*$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object found")
    return json.loads(t[start : end + 1])


def llm_narrative(provider: LLMProvider, ev: dict, recs: list[dict], suggestions: list[dict], next_exp: dict,
                  timeout_s: float) -> tuple[LLMNarrative, int]:
    """Call the provider, validate against ``LLMNarrative``; one repair retry. Raises ProviderError on failure."""
    user = build_user_prompt(ev, recs, suggestions, next_exp)
    last_err = ""
    for attempt in range(2):
        prompt = user if attempt == 0 else (
            user + f"\n\nYour previous output was invalid: {last_err[:500]}. Return only the corrected JSON object.")
        text = provider.complete(SYSTEM_PROMPT, prompt, timeout_s)
        try:
            return LLMNarrative.model_validate(extract_json(text)), attempt + 1
        except (ValueError, ValidationError) as exc:
            last_err = str(exc)
    raise ProviderError(f"invalid JSON from provider after retry: {last_err[:300]}")


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def evidence_numbers(obj: Any, out: list[float] | None = None) -> list[float]:
    out = [] if out is None else out
    if isinstance(obj, bool):
        return out
    if isinstance(obj, (int, float)):
        out.append(float(obj))
    elif isinstance(obj, str):
        out.extend(float(m) for m in NUM_RE.findall(obj))
    elif isinstance(obj, dict):
        for k, v in obj.items():
            evidence_numbers(k, out)
            evidence_numbers(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            evidence_numbers(v, out)
    return out


def unverified_numbers(text: str, allowed: list[float]) -> list[str]:
    bad = []
    for tok in NUM_RE.findall(text):
        x = float(tok)
        if x.is_integer() and 0 <= x <= 10:
            continue
        dec = len(tok.split(".", 1)[1]) if "." in tok else 0
        tol = 0.5 * 10 ** (-dec) + 1e-9
        if not any(abs(x - v) <= tol or abs(x - 100 * v) <= tol for v in allowed):
            bad.append(tok)
    return bad


def verify_and_repair(n: LLMNarrative, det: LLMNarrative, ev: dict, extra_allowed: list[float]) -> tuple[LLMNarrative, dict]:
    """Drop invalid evidence refs; replace any field containing numbers absent from the evidence."""
    items = ev["items"]
    allowed = evidence_numbers(ev) + list(extra_allowed)
    replaced: list[dict] = []
    data = n.model_dump()
    detd = det.model_dump()
    for f in NARRATIVE_FIELDS:
        bad = unverified_numbers(data[f], allowed)
        if bad:
            replaced.append({"field": f, "unverified": bad[:10]})
            data[f] = detd[f]
    kf = []
    for i, k in enumerate(data["key_findings"]):
        k["evidence_refs"] = [r for r in k["evidence_refs"] if r in items]
        bad = unverified_numbers(k["text"], allowed)
        if bad or not k["evidence_refs"]:
            replaced.append({"field": f"key_findings[{i}]", "unverified": bad[:10],
                             "missing_refs": not k["evidence_refs"]})
            continue
        kf.append(k)
    data["key_findings"] = kf or detd["key_findings"]
    recs = []
    for i, r in enumerate(data["recommendations"]):
        r["evidence_refs"] = [x for x in r["evidence_refs"] if x in items]
        bad = unverified_numbers(r["action"] + " " + r["rationale"], allowed)
        if bad or not r["evidence_refs"]:
            replaced.append({"field": f"recommendations[{i}]", "unverified": bad[:10],
                             "missing_refs": not r["evidence_refs"]})
            continue
        recs.append(r)
    data["recommendations"] = recs or detd["recommendations"]
    rats = {}
    for sid, txt in data["config_suggestion_rationales"].items():
        if sid in detd["config_suggestion_rationales"] and not unverified_numbers(txt, allowed):
            rats[sid] = txt[:1000]
    data["config_suggestion_rationales"] = rats
    return LLMNarrative.model_validate(data), {"checked": True, "replaced": replaced,
                                               "n_allowed_numbers": len(allowed)}
