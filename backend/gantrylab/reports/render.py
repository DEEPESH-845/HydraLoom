"""Self-contained, print-friendly HTML export of an engineering report."""

from __future__ import annotations

import html
from typing import Any

CSS = """
:root { --fg:#14212b; --muted:#5b6b78; --line:#d5dde3; --accent:#0b6e8a; --warn:#9a3412; --bg:#ffffff; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 2px solid var(--line); }
h3 { font-size: 14px; margin: 16px 0 6px; }
p { margin: 6px 0; }
.meta { color: var(--muted); font-size: 12px; }
.banner { border: 2px solid var(--warn); color: var(--warn); padding: 10px 14px; font-weight: 700; margin: 12px 0; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin: 12px 0; }
.kpi { border: 1px solid var(--line); padding: 8px 10px; }
.kpi b { display: block; font-size: 18px; }
.kpi span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12.5px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: #f3f6f8; font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.refs { color: var(--muted); font-size: 11px; }
.tag { display: inline-block; padding: 0 6px; border: 1px solid var(--line); font-size: 11px; }
ul { margin: 6px 0; padding-left: 20px; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
@media print {
  body { font-size: 11px; }
  main { max-width: none; padding: 0; }
  h2 { break-after: avoid; }
  table, .kpis, li { break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
}
"""


def e(v: Any) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, float):
        return f"{v:.3f}"
    return html.escape(str(v))


def _refs(refs: list[str]) -> str:
    return f'<div class="refs">evidence: {", ".join(html.escape(r) for r in refs)}</div>' if refs else ""


def _section(title: str, sec: dict) -> str:
    return f"<h2>{e(title)}</h2><p>{e(sec['narrative'])}</p>{_refs(sec.get('evidence_refs', []))}"


def render_html(r: dict) -> str:
    es = r["executive_summary"]
    hm = es["headline_metrics"]
    parts: list[str] = []
    parts.append(f"<h1>Engineering report - {e(es['model'])}</h1>")
    parts.append(f'<div class="meta">Report {e(r["id"])} for run {e(r["run_id"])} - created {e(r["created_at"])} - '
                 f'provider {e(r["provider"])} ({e(r["provider_model"])})'
                 f'{" - FALLBACK: " + e(r["fallback_reason"]) if r["fallback"] else ""} - evidence hash '
                 f'<code>{e(r["evidence_hash"][:16])}</code></div>')
    if r.get("banner"):
        parts.append(f'<div class="banner">{e(r["banner"])}</div>')
    parts.append("<h2>Executive summary</h2>")
    parts.append(f"<p><b>Tested:</b> {e(es['what_was_tested'])}</p>")
    parts.append(f"<p><b>Environments:</b> {e(', '.join(es['environments']) or 'not specified')}</p>")
    parts.append('<div class="kpis">' + "".join(
        f'<div class="kpi"><span>{e(k)}</span><b>{e(v)}</b></div>' for k, v in hm.items()) + "</div>")
    parts.append(f"<p>{e(es['overall'])}</p><ul>")
    for k in es["key_findings"]:
        parts.append(f"<li>{e(k['text'])}{_refs(k['evidence_refs'])}</li>")
    parts.append("</ul>")

    pb = r["performance_breakdown"]
    parts.append(_section("Performance breakdown", pb))
    per_class = pb["data"].get("per_class", {})
    if per_class:
        parts.append("<table><tr><th>Class</th><th>Support</th><th>P</th><th>R</th><th>F1</th><th>AP50</th>"
                     "<th>AP50:95</th></tr>")
        for c, m in per_class.items():
            parts.append(f"<tr><td>{e(c)}</td><td class=num>{e(m['support'])}</td><td class=num>{e(m['precision'])}</td>"
                         f"<td class=num>{e(m['recall'])}</td><td class=num>{e(m['f1'])}</td>"
                         f"<td class=num>{e(m['ap50'])}</td><td class=num>{e(m['ap50_95'])}</td></tr>")
        parts.append("</table>")

    parts.append(_section("Environmental sensitivity", r["environmental_sensitivity"]))
    sens = r["environmental_sensitivity"]["data"].get("spreads", [])
    if sens:
        parts.append("<table><tr><th>Key</th><th>Best bucket</th><th>Worst bucket</th><th>Recall gap</th>"
                     "<th>Slope / unit</th></tr>")
        for s in sens:
            parts.append(f"<tr><td>{e(s['key'])}</td><td>{e(s['best']['bucket'])} ({e(s['best']['recall'])}, n={e(s['best']['n_gt'])})</td>"
                         f"<td>{e(s['worst']['bucket'])} ({e(s['worst']['recall'])}, n={e(s['worst']['n_gt'])})</td>"
                         f"<td class=num>{e(s['delta_recall'])}</td><td class=num>{e(s.get('slope_per_unit'))}</td></tr>")
        parts.append("</table>")

    parts.append(_section("Failure analysis", r["failure_analysis"]))
    parts.append(_section("Best and worst conditions", r["conditions_narrative"]))
    for title, rows in (("Best conditions", r["best_conditions"]), ("Worst conditions", r["worst_conditions"])):
        if rows:
            parts.append(f"<h3>{title}</h3><table><tr><th>Slice</th><th>Metric</th><th>Value</th><th>n_gt</th>"
                         "<th>Frames</th></tr>")
            for c in rows:
                parts.append(f"<tr><td>{e(c['key'])} = {e(c['bucket'])}</td><td>{e(c['metric'])}</td>"
                             f"<td class=num>{e(c['value'])}</td><td class=num>{e(c['n_gt'])}</td>"
                             f"<td class=num>{e(c['n_frames'])}</td></tr>")
            parts.append("</table>")

    parts.append(_section("Hardware suitability", r["hardware_suitability"]))
    hw = r["hardware_suitability"]["data"].get("profiles", [])
    if hw:
        parts.append("<table><tr><th>Profile</th><th>Kind</th><th>p50 ms</th><th>FPS</th><th>Budget FPS</th>"
                     "<th>Meets</th><th>Method</th></tr>")
        for h in hw:
            parts.append(f"<tr><td>{e(h['name'])}</td><td><span class=tag>{e(h['kind'])}</span></td>"
                         f"<td class=num>{e(h['latency_ms_p50'])}</td><td class=num>{e(h['fps'])}</td>"
                         f"<td class=num>{e(h['budget_fps_required'])}</td><td>{e(h['meets_budget'])}</td>"
                         f"<td>{e(h['method'])}</td></tr>")
        parts.append("</table>")

    parts.append("<h2>Recommendations</h2><ol>")
    for rec in sorted(r["recommendations"], key=lambda x: x["priority"]):
        parts.append(f"<li><b>{e(rec['action'])}</b><br>{e(rec['rationale'])}{_refs(rec['evidence_refs'])}</li>")
    parts.append("</ol>")
    nx = r["next_experiment"]
    parts.append("<h2>Next experiment</h2>")
    parts.append(f"<p>{e(nx['rationale'])}</p><table><tr><th>Environment</th><th>Parameters</th></tr><tr><td>"
                 + "<br>".join(f"{e(k)}: {e(v)}" for k, v in nx["environment"].items()) + "</td><td>"
                 + "<br>".join(f"{e(k)}: {e(v)}" for k, v in nx["parameters"].items()) + "</td></tr></table>")
    parts.append("<h2>Configuration suggestions</h2>")
    if r["config_suggestions"]:
        parts.append("<table><tr><th>File / key</th><th>Original</th><th>Suggested</th><th>Reason</th>"
                     "<th>Benefit / trade-offs</th><th>Confidence</th></tr>")
        for s in r["config_suggestions"]:
            parts.append(f"<tr><td><code>{e(s['file'])}</code><br><code>{e(s['key'])}</code></td>"
                         f"<td>{e(s['original'])}<br><span class=refs>{e(s['original_source'])}</span></td>"
                         f"<td>{e(s['suggested'])}</td><td>{e(s['reason'])}{_refs(s['evidence'])}</td>"
                         f"<td>{e(s['expected_benefit'])}<br><i>{e(s['tradeoffs'])}</i></td>"
                         f"<td>{e(s['confidence'])}</td></tr>")
        parts.append("</table>")
    else:
        parts.append("<p>No configuration change is supported by the evidence from this run.</p>")
    parts.append("<h2>Disclaimers</h2><ul>" + "".join(f"<li>{e(d)}</li>" for d in r["disclaimers"]) + "</ul>")
    title = f"GANTRYLAB report {r['id']}"
    return ("<!doctype html><html lang=en><head><meta charset=utf-8>"
            "<meta name=viewport content='width=device-width, initial-scale=1'>"
            f"<title>{e(title)}</title><style>{CSS}</style></head><body><main>"
            + "".join(parts) + "</main></body></html>")
