"""Report orchestration: evidence -> deterministic analysis -> narrative (LLM or rules) -> verified report."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import yaml
from fastapi import HTTPException

from ..adapters import MOCK_BANNER
from ..config import Settings
from ..llm import ProviderError, select_provider
from ..metrics.engine import MIN_SUPPORT
from ..schemas import (
    AskRequest,
    AskResponse,
    EngineeringReport,
    PatchResponse,
    ReportCreate,
    ReportSummary,
)
from ..services.datasets import DatasetStore
from ..services.models import ModelRegistry
from ..services.runs import RunManager
from ..storage import is_safe_id, make_read_only, new_id, read_json, utcnow, write_json_atomic
from .evidence import build_evidence
from .narrative import (
    LLMNarrative,
    deterministic_narrative,
    deterministic_recommendations,
    extract_json,
    fmt,
    llm_narrative,
    times,
    unverified_numbers,
    evidence_numbers,
    verify_and_repair,
)
from .patches import apply_suggestions, unified_diff
from .render import render_html
from .suggestions import PATCHABLE_FILES, build_suggestions

log = logging.getLogger("gantrylab.reports")

DISCLAIMERS = [
    "Results come from synthetic imagery rendered by the GANTRYLAB digital twin; real-world performance may differ.",
    f"Slices with fewer than {MIN_SUPPORT} ground-truth objects are excluded from best / worst rankings.",
    "Condition effects are associations observed in this dataset, not proven causes.",
    "Estimated hardware figures come from a labelled throughput model and are not measurements.",
    "Configuration suggestions are hypotheses to test. No weights were changed and no improvement is claimed.",
    "All numbers in this report are copied from the metrics engine; narrative text is verified against the evidence.",
]


def next_experiment(ev: dict, suggestions: list[dict], run: dict) -> dict:
    it = ev["items"]
    env: dict[str, Any] = {}
    envs = it["analysis:environments"]
    mdc = it["analysis:most_degrading_condition"]
    refs: list[str] = []
    if mdc:
        env[mdc["key"]] = f"focus on '{mdc['worst']['bucket']}' (worst bucket) and keep '{mdc['best']['bucket']}' as control"
        refs += [mdc["worst"]["ref"], mdc["best"]["ref"]]
    if envs:
        env["environment"] = envs[0] if len(envs) == 1 else envs
    worst_attr = it["analysis:most_degrading_object_attribute"]
    if worst_attr:
        env[worst_attr["key"]] = f"oversample '{worst_attr['worst']['bucket']}' objects"
        refs.append(worst_attr["worst"]["ref"])
    if not env:
        env["note"] = "extend to harsher conditions (higher turbidity, lower lighting, stronger current)"
    params: dict[str, Any] = {}
    for s in suggestions:
        if s["file"] == "inference.yaml" and s["patchable"]:
            params[s["key"]] = s["suggested"]
    params.setdefault("conf", run["config"]["conf"])
    params["n_frames_min"] = max(200, 2 * int(it["overall"]["n_frames"]))
    params["seed"] = "new seed (different from the dataset seed)"
    rationale = (
        "Re-test the weakest condition with enough frames to reach the minimum support in each bucket, "
        "keeping the best bucket as a control, and apply the inference changes suggested by the evidence."
    )
    if mdc:
        rationale = (f"{mdc['key']} shows the largest recall gap ({fmt(mdc['best']['recall'])} versus "
                     f"{fmt(mdc['worst']['recall'])}); repeat it with more frames and the suggested inference settings "
                     "to confirm the effect.")
    return {"environment": env, "parameters": params, "rationale": rationale, "evidence_refs": refs}


class ReportService:
    def __init__(self, settings: Settings, runs: RunManager, models: ModelRegistry, datasets: DatasetStore) -> None:
        self.settings = settings
        self.runs = runs
        self.models = models
        self.datasets = datasets

    # -- storage -------------------------------------------------------------

    def _path(self, rid: str) -> Path:
        if not is_safe_id(rid) or not rid.startswith("rep_"):
            raise HTTPException(status_code=404, detail="report not found")
        p = self.settings.reports_dir / f"{rid}.json"
        if not p.exists():
            raise HTTPException(status_code=404, detail="report not found")
        return p

    def get(self, rid: str) -> dict:
        return read_json(self._path(rid))

    def evidence(self, rid: str) -> dict:
        self._path(rid)
        return read_json(self.settings.reports_dir / rid / "evidence.json")

    def list(self, run_id: str | None = None) -> list[ReportSummary]:
        out = []
        if self.settings.reports_dir.exists():
            for p in self.settings.reports_dir.glob("rep_*.json"):
                r = read_json(p)
                if run_id and r["run_id"] != run_id:
                    continue
                out.append(ReportSummary(id=r["id"], run_id=r["run_id"], created_at=r["created_at"],
                                         provider=r["provider"], fallback=r["fallback"], mock=r["mock"]))
        out.sort(key=lambda s: (s.created_at, s.id), reverse=True)
        return out

    def html(self, rid: str) -> str:
        return render_html(self.get(rid))

    # -- create --------------------------------------------------------------

    def create(self, run_id: str, body: ReportCreate) -> dict:
        run = self.runs.get_raw(run_id)
        if run["status"] != "complete":
            raise HTTPException(status_code=409, detail=f"run is {run['status']}; reports need a complete run")
        metrics = self.runs.metrics(run_id)
        dataset = self.datasets.get(run["dataset"]["id"]).model_dump(by_alias=True)
        model = self.models.get_raw(run["model"]["id"])
        ev = build_evidence(run, metrics, dataset, model, body.include_failure_examples)
        suggestions, sg_notes = build_suggestions(metrics, run, {}, body.user_files)
        nx = next_experiment(ev, suggestions, run)
        det = deterministic_narrative(ev, suggestions, nx)
        provider, note = select_provider(body.provider, self.settings.llm_provider)
        fallback = bool(note) and (body.provider or self.settings.llm_provider) not in (None, "", "auto", "deterministic")
        fallback_reason = note if fallback else None
        provider_name, provider_model = provider.name, provider.model
        narrative = det
        number_check: dict[str, Any] = {"checked": True, "replaced": [], "attempts": 0, "note": note}
        if not provider.deterministic:
            recs = deterministic_recommendations(ev, suggestions)
            try:
                raw_n, attempts = llm_narrative(provider, ev, recs, suggestions, nx, self.settings.llm_timeout_s)
                narrative, nc = verify_and_repair(raw_n, det, ev, extra_allowed=[])
                number_check.update(nc, attempts=attempts)
            except ProviderError as exc:
                fallback, fallback_reason = True, f"{provider.name} failed: {exc}"
                narrative = det
            except Exception as exc:  # noqa: BLE001 - any provider bug must not break the report
                log.warning("provider %s crashed: %s", provider.name, type(exc).__name__)
                fallback, fallback_reason = True, f"{provider.name} failed: {type(exc).__name__}"
                narrative = det
            if fallback:
                provider_name, provider_model = "deterministic", det_model()
                number_check = {"checked": True, "replaced": [], "attempts": 0, "note": "deterministic fallback"}
        if sg_notes:
            number_check["user_file_notes"] = sg_notes

        rationales = narrative.config_suggestion_rationales
        for s in suggestions:
            s["rationale"] = rationales.get(s["id"])
        report = self._assemble(run, metrics, dataset, model, ev, narrative, suggestions, nx)
        rid = new_id("rep")
        report.update(
            id=rid,
            run_id=run_id,
            created_at=utcnow(),
            provider=provider_name,
            provider_model=provider_model,
            fallback=fallback,
            fallback_reason=fallback_reason,
            mock=bool(run["mock"]),
            banner=MOCK_BANNER if run["mock"] else None,
            evidence_hash=ev["hash"],
            number_check=number_check,
            user_files_provided=sorted((body.user_files or {}).keys()),
        )
        validated = EngineeringReport.model_validate(report).model_dump(mode="json")
        rdir = self.settings.reports_dir / rid
        (rdir / "inputs").mkdir(parents=True)
        for name, text in (body.user_files or {}).items():
            p = rdir / "inputs" / name
            p.write_text(text, encoding="utf-8", newline="")
            make_read_only(p)
        write_json_atomic(rdir / "evidence.json", ev)
        write_json_atomic(self.settings.reports_dir / f"{rid}.json", validated)
        return validated

    def _assemble(self, run: dict, metrics: dict, dataset: dict, model: dict, ev: dict, n: LLMNarrative,
                  suggestions: list[dict], nx: dict) -> dict:
        it = ev["items"]
        ov = metrics["overall"]
        insp = model.get("inspection") or {}
        envs = it["analysis:environments"]
        rk = metrics["slice_ranking"]

        def cond(e: dict) -> dict:
            return {"slice_id": e["id"], "key": e["key"], "bucket": e["bucket"], "metric": e["metric"],
                    "value": e["value"], "n_gt": e["n_gt"], "n_frames": e["n_frames"]}

        def refs_for(prefixes: tuple[str, ...]) -> list[str]:
            return _uniq([k for k in it if k.startswith(prefixes)])[:12]

        return {
            "executive_summary": {
                "what_was_tested": (
                    f"{model['name']} v{model['version']} ({model['format']}, task {insp.get('task')}) evaluated with the "
                    f"{run['adapter']} adapter on synthetic dataset '{dataset['name']}' ({dataset['n_frames']} frames, "
                    f"{len(dataset['classes'])} classes) at conf {run['config']['conf']}, NMS IoU {run['config']['iou']}, "
                    f"imgsz {run['config']['imgsz']}."
                ),
                "model": f"{model['name']} v{model['version']} (sha256 {model['sha256'][:12]})",
                "environments": [str(e) for e in envs],
                "overall": n.overall,
                "key_findings": [f.model_dump() for f in n.key_findings],
                "headline_metrics": {
                    "precision": ov["precision"], "recall": ov["recall"], "f1": ov["f1"], "map50": ov["map50"],
                    "map50_95": ov["map50_95"], "n_gt": ov["n_gt"], "n_frames": metrics["n_frames"],
                    "conf": metrics["conf_threshold"],
                },
            },
            "performance_breakdown": {"narrative": n.performance_breakdown,
                                      "evidence_refs": ["overall", *refs_for(("class:",))],
                                      "data": {"overall": ov, "per_class": metrics["per_class"],
                                               "best_f1": metrics["pr"]["best_f1"]}},
            "environmental_sensitivity": {"narrative": n.environmental_sensitivity,
                                          "evidence_refs": refs_for(("sensitivity:",)) or ["analysis:condition_spreads"],
                                          "data": {"sensitivity": metrics["sensitivity"],
                                                   "spreads": it["analysis:condition_spreads"]}},
            "failure_analysis": {"narrative": n.failure_analysis,
                                 "evidence_refs": ["fp_types", "fn_types", "threshold", *refs_for(("confusion:", "failures:"))],
                                 "data": {"fp_types": metrics["fp_types"], "fn_types": metrics["fn_types"],
                                          "confused_pairs": metrics["confused_pairs"][:10],
                                          "tp_below_conf_threshold": metrics["tp_below_conf_threshold"],
                                          "false_positives": it.get("failures:false_positives"),
                                          "false_negatives": it.get("failures:false_negatives")}},
            "best_conditions": [cond(e) for e in rk["best"]],
            "worst_conditions": [cond(e) for e in rk["worst"]],
            "conditions_narrative": {"narrative": n.conditions, "evidence_refs": ["ranking"],
                                     "data": {"min_support": rk["min_support"],
                                              "n_excluded_low_support": rk["n_excluded_low_support"]}},
            "hardware_suitability": {"narrative": n.hardware_suitability, "evidence_refs": refs_for(("hardware:",)),
                                     "data": {"profiles": metrics["hardware_profiles"], "selected": metrics["hardware"],
                                              "latency": it["latency"]}},
            "recommendations": [r.model_dump() for r in sorted(n.recommendations, key=lambda r: r.priority)],
            "next_experiment": {"environment": nx["environment"], "parameters": nx["parameters"],
                                "rationale": n.next_experiment_rationale, "evidence_refs": _uniq(nx["evidence_refs"])},
            "config_suggestions": suggestions,
            "disclaimers": ([MOCK_BANNER] if run["mock"] else []) + DISCLAIMERS,
        }

    # -- patches -------------------------------------------------------------

    def patch(self, rid: str, file: str) -> PatchResponse:
        if file not in PATCHABLE_FILES:
            raise HTTPException(status_code=404, detail=f"unknown file; choose one of {list(PATCHABLE_FILES)}")
        report = self.get(rid)
        src = self.settings.reports_dir / rid / "inputs" / file
        original = src.read_text(encoding="utf-8") if src.exists() else ""
        sgs = [s for s in report["config_suggestions"] if s["file"] == file and s["patchable"]]
        patched, applied, failed = original, [], None
        if sgs:
            try:
                patched, applied = apply_suggestions(original, sgs)
            except (yaml.YAMLError, ValueError, RecursionError) as exc:
                failed = type(exc).__name__
        note = ("Patched COPY generated from the stored original; the original upload is unchanged. "
                "Suggestions are hypotheses to test and do not imply improved weights.")
        if not src.exists():
            note += " No original file was supplied, so the copy contains only the suggested keys."
        if failed:
            note += f" The original could not be patched line by line ({failed}); apply the suggestions by hand."
        if not sgs:
            note += " No suggestions apply to this file."
        return PatchResponse(report_id=rid, file=file, original_source="user_file" if src.exists() else "empty",
                             original=original, patched=patched, diff=unified_diff(original, patched, file),
                             applied_suggestions=applied, note=note)

    # -- follow-up questions -------------------------------------------------

    def ask(self, rid: str, body: AskRequest) -> AskResponse:
        report = self.get(rid)
        ev = self.evidence(rid)
        det = deterministic_answer(body.question, ev, report)
        provider, note = select_provider(body.provider, self.settings.llm_provider)
        requested = body.provider or self.settings.llm_provider
        fallback = bool(note) and requested not in (None, "", "auto", "deterministic")
        reason = note if fallback else None
        if not provider.deterministic:
            try:
                ans = llm_answer(provider, body.question, ev, self.settings.llm_timeout_s)
                return AskResponse(report_id=rid, question=body.question, provider=provider.name, fallback=False,
                                   fallback_reason=None, mock=report["mock"], **ans)
            except (ProviderError, ValueError) as exc:
                fallback, reason = True, f"{provider.name} failed: {exc}"[:500]
            except Exception as exc:  # noqa: BLE001
                fallback, reason = True, f"{provider.name} failed: {type(exc).__name__}"
        return AskResponse(report_id=rid, question=body.question, provider="deterministic", fallback=fallback,
                           fallback_reason=reason, mock=report["mock"], **det)


def det_model() -> str:
    return "gantrylab-rules-1"


ASK_SYSTEM = """You answer follow-up questions about an object-detector evaluation using ONLY the EVIDENCE JSON.
Every number must be copied from the evidence. Cite evidence item ids (keys of EVIDENCE.items).
If the evidence cannot answer the question, say so. If the run is a mock evaluation, say so.
Return exactly one JSON object: {"answer": str, "evidence_refs": [str], "uncertainty": str}"""


def llm_answer(provider: Any, question: str, ev: dict, timeout_s: float) -> dict:
    import json

    user = "EVIDENCE:\n" + json.dumps(ev, separators=(",", ":"), default=str) + "\n\nQUESTION:\n" + question
    last = ""
    for attempt in range(2):
        text = provider.complete(ASK_SYSTEM, user if attempt == 0 else user + f"\n\nPrevious output invalid: {last}",
                                 timeout_s)
        try:
            data = extract_json(text)
            answer = str(data["answer"])[:4000]
            refs = _uniq([r for r in data.get("evidence_refs", []) if isinstance(r, str) and r in ev["items"]])
            unc = str(data.get("uncertainty", "")).strip()[:1000]
            if not refs:
                raise ValueError("no valid evidence_refs")
            if not unc:
                raise ValueError("missing uncertainty")
            bad = unverified_numbers(answer, evidence_numbers(ev))
            if bad:
                raise ValueError(f"numbers not in evidence: {bad[:5]}")
            return {"answer": answer, "evidence_refs": refs, "uncertainty": unc}
        except (ValueError, KeyError, TypeError) as exc:
            last = str(exc)[:300]
    raise ValueError(f"invalid answer after retry: {last}")


INTENTS: list[tuple[str, re.Pattern]] = [
    ("hardware", re.compile(r"\b(hardware|pi|raspberry|rpi\d?|fps|latency|real[- ]?time|budget|deploy|gpu|cpu)\b", re.I)),
    ("confusion", re.compile(r"\b(confus|mistak|misclass|mix(ed)? up)\w*", re.I)),
    # condition before config: "Which environmental parameter caused the largest degradation?" asks about a condition
    ("condition", re.compile(r"\b(condition|degrad|turbid|lighting|light|current|depth|environment|blur|visib|water|harbou?r|river|reef|lake|ocean|deep)\w*", re.I)),
    ("config", re.compile(r"\b(config|configuration|next|experiment|try|change|threshold|parameter|hyp|augment|setting|tune)\w*", re.I)),
    ("class", re.compile(r"\b(class|classes|object type|miss|missed|fail|failed|worst|lowest recall)\w*", re.I)),
    ("best", re.compile(r"\b(best|strongest|easiest)\b", re.I)),
]


def _support_uncertainty(n_gt: int | None, mock: bool) -> str:
    base = f"Based on n_gt={n_gt} ground-truth objects" if n_gt is not None else "Based on the aggregated evidence"
    msg = (f"{base}; slices below {MIN_SUPPORT} objects are excluded. Synthetic data; differences are associations, "
           "not proven causes, and no confidence interval was computed.")
    if n_gt is not None and n_gt < 30:
        msg += " Sample is small, so treat this as indicative only."
    if mock:
        msg = MOCK_BANNER + ". " + msg
    return msg


def _uniq(refs: list[str]) -> list[str]:
    """Evidence references in first-seen order, each once."""
    return list(dict.fromkeys(refs))


def deterministic_answer(question: str, ev: dict, report: dict) -> dict:
    ans = _deterministic_answer(question, ev, report)
    ans["evidence_refs"] = _uniq(ans["evidence_refs"])
    return ans


def _deterministic_answer(question: str, ev: dict, report: dict) -> dict:
    it = ev["items"]
    mock = bool(it["run:adapter"]["mock"])
    intent = next((name for name, pat in INTENTS if pat.search(question)), None)
    if intent == "condition":
        m = it["analysis:most_degrading_condition"]
        if m:
            txt = (f"{m['key']} degraded detection the most: recall {fmt(m['best']['recall'])} in "
                   f"'{m['best']['bucket']}' (n_gt={m['best']['n_gt']}) versus {fmt(m['worst']['recall'])} in "
                   f"'{m['worst']['bucket']}' (n_gt={m['worst']['n_gt']}).")
            if m.get("slope_per_unit") is not None:
                txt += f" The fitted slope is {fmt(m['slope_per_unit'])} recall per unit of {m['key']}."
            refs = [m["worst"]["ref"], m["best"]["ref"]] + ([m["sensitivity_ref"]] if m.get("sensitivity_ref") else [])
            return {"answer": txt, "evidence_refs": refs,
                    "uncertainty": _support_uncertainty(min(m["worst"]["n_gt"], m["best"]["n_gt"]), mock)}
        return {"answer": f"No condition had two buckets with at least {MIN_SUPPORT} objects, so no degradation can "
                          "be attributed to a condition from this run.", "evidence_refs": ["ranking"],
                "uncertainty": _support_uncertainty(None, mock)}
    if intent == "best":
        rk = it["ranking"]
        if rk["best"]:
            b = rk["best"][0]
            return {"answer": f"The best-performing slice is {b['key']}='{b['bucket']}' with {b['metric']} "
                              f"{fmt(b['value'])} over {b['n_gt']} objects.",
                    "evidence_refs": [b["id"], "ranking"], "uncertainty": _support_uncertainty(b["n_gt"], mock)}
    if intent == "confusion":
        cp = it["analysis:confused_pairs"]
        if cp:
            p = cp[0]
            return {"answer": f"The most frequent confusion is {p['gt_class']} predicted as {p['pred_class']} "
                              f"({times(p['count'])} at the configured threshold).",
                    "evidence_refs": [p["ref"]], "uncertainty": _support_uncertainty(p["count"], mock)}
        return {"answer": "No class confusions were recorded at the configured threshold.",
                "evidence_refs": ["fp_types"], "uncertainty": _support_uncertainty(None, mock)}
    if intent == "class":
        mm = it["analysis:most_missed_classes"]
        if mm:
            c = mm[0]
            others = ", ".join(f"{x['class']} ({fmt(x['recall'])})" for x in mm[1:])
            txt = (f"{c['class']} failed most often: recall {fmt(c['recall'])}, {c['fn']} misses of {c['support']} objects."
                   + (f" Next lowest recall: {others}." if others else ""))
            return {"answer": txt, "evidence_refs": [x["ref"] for x in mm],
                    "uncertainty": _support_uncertainty(c["support"], mock)}
        return {"answer": f"No class had at least {MIN_SUPPORT} ground-truth objects, so per-class failure cannot be "
                          "ranked reliably.", "evidence_refs": ["overall"], "uncertainty": _support_uncertainty(None, mock)}
    if intent == "config":
        sg = report.get("config_suggestions", [])
        nx = report["next_experiment"]
        lines = [f"{s['file']} {s['key']}: {s['original']} -> {s['suggested']} ({s['confidence']} confidence)" for s in sg[:5]]
        txt = ("Next experiment: " + "; ".join(f"{k}={v}" for k, v in nx["environment"].items())
               + ". Parameters: " + ", ".join(f"{k}={v}" for k, v in nx["parameters"].items()) + ".")
        if lines:
            txt += " Suggested config changes to test: " + "; ".join(lines) + "."
        refs = sorted({r for s in sg[:5] for r in s["evidence"] if r in it} | {r for r in nx.get("evidence_refs", []) if r in it})
        return {"answer": txt, "evidence_refs": refs or ["overall"],
                "uncertainty": _support_uncertainty(it["overall"]["n_gt"], mock)
                + " Suggestions are hypotheses; none is a measured improvement."}
    if intent == "hardware":
        parts, refs = [], []
        for h in it["analysis:hardware_suitability"]:
            if h["latency_ms_p50"] is not None:
                parts.append(f"{h['profile']} ({h['kind']}): {fmt(h['latency_ms_p50'], 1)} ms p50, {fmt(h['fps'], 1)} FPS, "
                             f"{'meets' if h['meets_budget'] else 'misses'} {fmt(h['budget_fps_required'], 1)} FPS")
                refs.append(h["ref"])
        txt = "; ".join(parts) + "." if parts else "No latency figures are available for this run."
        return {"answer": txt, "evidence_refs": refs or ["latency"],
                "uncertainty": "Measured values apply to this host only. Estimated profiles come from an assumption-based "
                               "GFLOPs model and must be replaced by on-device measurement."
                               + (f" {MOCK_BANNER}." if mock else "")}
    ov = it["overall"]
    return {"answer": (f"Overall precision {fmt(ov['precision'])}, recall {fmt(ov['recall'])}, mAP@50 {fmt(ov['map50'])}. "
                       "I can answer which condition degraded performance most, which class failed, which classes "
                       "were confused, hardware suitability, and which configuration to test next."),
            "evidence_refs": ["overall"], "uncertainty": "The question did not match a known topic; this is a general "
                                                         "summary." + (f" {MOCK_BANNER}." if mock else "")}

