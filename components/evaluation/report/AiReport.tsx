"use client";

import clsx from "clsx";
import { Download, FileJson, FileText, Printer, Sparkles, Upload } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { api, isApiError, urls, type ApiError } from "@/lib/api/client";
import { useResource } from "@/lib/api/hooks";
import type { ConditionEntry, EngineeringReport, HealthResponse, LlmProvider, PatchFile, Section } from "@/lib/api/types";
import { PATCH_FILES } from "@/lib/api/types";
import { CopyButton, ErrorNote, Evidence, fmt, fmtDate, fmtValue, inputCls, MockBanner, shortSha, SkeletonRows } from "../ui";

const PROVIDERS: { id: LlmProvider; label: string; note: string }[] = [
  { id: "auto", label: "Auto", note: "first configured: Anthropic, OpenAI, Ollama, else deterministic" },
  { id: "anthropic", label: "Anthropic", note: "Messages API" },
  { id: "openai", label: "OpenAI", note: "chat completions" },
  { id: "ollama", label: "Ollama", note: "local model" },
  { id: "deterministic", label: "Deterministic", note: "rules only, no LLM" },
];

const MAX_USER_FILE = 256 * 1024;

export function ReportGenerator({ runId, health, onCreated }: { runId: string; health: HealthResponse | undefined; onCreated: (r: EngineeringReport) => void }) {
  const uid = useId();
  const [provider, setProvider] = useState<LlmProvider>("auto");
  const [includeFailures, setIncludeFailures] = useState(true);
  const [files, setFiles] = useState<Partial<Record<PatchFile, string>>>({});
  const [openFile, setOpenFile] = useState<PatchFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const configured = health?.llm_providers ?? {};

  const oversize = PATCH_FILES.filter((f) => new Blob([files[f] ?? ""]).size > MAX_USER_FILE);

  const generate = async () => {
    setError(null);
    setBusy(true);
    try {
      const user_files = Object.fromEntries(Object.entries(files).filter(([, v]) => v && v.trim())) as Partial<Record<PatchFile, string>>;
      const rep = await api.createReport(runId, { provider, include_failure_examples: includeFailures, user_files: Object.keys(user_files).length ? user_files : null });
      onCreated(rep);
    } catch (e) {
      if (isApiError(e)) setError(e);
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (f: PatchFile, file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_USER_FILE) {
      setLocalErr(`${file.name} is larger than 256 KiB.`);
      return;
    }
    setLocalErr(null);
    const text = await file.text();
    setFiles((s) => ({ ...s, [f]: text }));
    setOpenFile(f);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="report-generator">
      <fieldset>
        <legend className="label mb-1.5">Narrative provider</legend>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map((p) => {
            const isConfigured = p.id === "auto" || p.id === "deterministic" ? true : !!configured[p.id];
            const on = provider === p.id;
            return (
              <label
                key={p.id}
                title={p.note}
                className={clsx(
                  "flex cursor-pointer items-center gap-2 border px-2.5 py-1.5 transition-colors duration-100",
                  on ? "border-teal bg-teal/5" : "border-line hover:border-line-strong",
                  !isConfigured && "cursor-not-allowed opacity-50",
                )}
              >
                <input type="radio" name={`${uid}-provider`} className="accent-teal" checked={on} disabled={!isConfigured} onChange={() => setProvider(p.id)} />
                <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-text">{p.label}</span>
                {p.id !== "auto" && (
                  <span className={clsx("font-mono text-[9px] uppercase", isConfigured ? "text-teal" : "text-dim")}>{isConfigured ? (p.id === "deterministic" ? "built in" : "configured") : "not configured"}</span>
                )}
              </label>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-dim">
          The metrics engine is the source of truth. LLM numbers that do not appear in the evidence are replaced with the deterministic text, and invalid evidence references are removed.
        </p>
      </fieldset>

      <label className="flex cursor-pointer items-start gap-2 border border-line px-3 py-2">
        <input type="checkbox" className="mt-0.5 accent-teal" checked={includeFailures} onChange={(e) => setIncludeFailures(e.target.checked)} data-testid="include-failures" />
        <span className="flex flex-col gap-0.5">
          <span className="text-[12px] text-text">Include failure examples (aggregated only)</span>
          <span className="text-[11px] leading-snug text-muted">
            Adds failure counts and up to 12 one-line text examples to the evidence. No images, no model weights and no dataset files are sent to any provider.
          </span>
        </span>
      </label>

      <div>
        <div className="label mb-1.5">Training and inference files (optional)</div>
        <p className="mb-2 text-[11px] text-muted">Paste or load your YAML. Suggestions are patched into a separate copy; the text you provide is stored read-only and never rewritten.</p>
        <div className="flex flex-wrap gap-1.5">
          {PATCH_FILES.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setOpenFile(openFile === f ? null : f)}
              aria-expanded={openFile === f}
              className={clsx("btn !py-1", openFile === f && "btn-active")}
            >
              {f}
              {files[f]?.trim() ? <span className="ml-1.5 text-teal">*</span> : null}
            </button>
          ))}
        </div>
        {openFile && (
          <div className="mt-2 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`${uid}-${openFile}`} className="label">
                {openFile} contents
              </label>
              <label className="btn inline-flex cursor-pointer items-center gap-1.5 !py-1">
                <Upload size={12} /> Load file
                <input type="file" accept=".yaml,.yml,text/yaml,text/plain" className="sr-only" onChange={(e) => loadFile(openFile, e.target.files?.[0])} />
              </label>
            </div>
            <textarea
              id={`${uid}-${openFile}`}
              className={clsx(inputCls, "min-h-[120px] resize-y leading-relaxed")}
              spellCheck={false}
              placeholder={openFile === "hyp.yaml" ? "lr0: 0.01\nhsv_v: 0.4\nmixup: 0.0" : openFile === "inference.yaml" ? "conf: 0.25\niou: 0.7\nimgsz: 640" : "path: .\ntrain: images\nval: images\nnames: [...]"}
              value={files[openFile] ?? ""}
              onChange={(e) => setFiles((s) => ({ ...s, [openFile]: e.target.value }))}
            />
          </div>
        )}
        {(localErr || oversize.length > 0) && <p className="mt-1.5 text-[11px] text-danger">{localErr ?? `${oversize.join(", ")} exceeds 256 KiB.`}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary inline-flex items-center gap-1.5" onClick={generate} disabled={busy || oversize.length > 0} data-testid="generate-report">
          <Sparkles size={13} /> {busy ? "Generating" : "Generate report"}
        </button>
        {busy && <span className="text-[11px] text-muted">An LLM provider can take up to a minute; the deterministic provider answers at once.</span>}
      </div>
      {error && <ErrorNote error={error} />}
    </div>
  );
}

function Narrative({ title, section, children }: { title: string; section?: Section; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-line pt-4">
      <h3 className="label text-text">{title}</h3>
      {section && <p className="max-w-[90ch] whitespace-pre-line text-[13px] leading-relaxed text-text/90">{section.narrative}</p>}
      {children}
      {section && <Evidence refs={section.evidence_refs} />}
    </section>
  );
}

function ConditionTable({ rows, tone }: { rows: ConditionEntry[]; tone: "best" | "worst" }) {
  if (!rows.length) return <p className="text-[12px] text-dim">No slice met the minimum support.</p>;
  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="border-b border-line">
          <th className="label px-2 py-1 text-left font-normal">Condition</th>
          <th className="label px-2 py-1 text-right font-normal">Metric</th>
          <th className="label px-2 py-1 text-right font-normal">Value</th>
          <th className="label px-2 py-1 text-right font-normal">n_gt</th>
          <th className="label px-2 py-1 text-right font-normal">Frames</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.slice_id} className="border-b border-line/60">
            <td className="px-2 py-1">
              <span className={clsx("mr-2 inline-block h-1.5 w-1.5 rounded-full", tone === "best" ? "bg-teal" : "bg-amber")} aria-hidden />
              <span className="value text-text">
                {r.key} = {r.bucket}
              </span>
            </td>
            <td className="value px-2 py-1 text-right text-muted">{r.metric}</td>
            <td className="value px-2 py-1 text-right text-text">{fmt(r.value)}</td>
            <td className="value px-2 py-1 text-right text-muted">{r.n_gt}</td>
            <td className="value px-2 py-1 text-right text-muted">{r.n_frames}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReportView({ report }: { report: EngineeringReport }) {
  const es = report.executive_summary;
  const replaced = report.number_check.replaced ?? [];
  const ne = report.next_experiment;
  return (
    <article className="flex flex-col gap-4" data-testid="report-view" aria-label="AI engineering report">
      {report.mock && <MockBanner text={report.banner} />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-line bg-ground/40 px-3 py-2 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="label text-[9px]">Provider</span>
          <span className="value text-text" data-testid="report-provider">
            {report.provider}
          </span>
          {report.provider_model && <span className="value text-muted">({report.provider_model})</span>}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="label text-[9px]">Fallback</span>
          <span className={clsx("value", report.fallback ? "text-amber" : "text-text")}>{report.fallback ? "yes" : "no"}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="label text-[9px]">Mock</span>
          <span className={clsx("value", report.mock ? "text-danger" : "text-text")}>{report.mock ? "yes" : "no"}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="label text-[9px]">Evidence</span>
          <span className="value truncate text-muted" title={report.evidence_hash}>
            sha256 {shortSha(report.evidence_hash, 16)}
          </span>
          <CopyButton text={report.evidence_hash} label="Copy evidence hash" compact />
        </span>
        <span className="flex items-center gap-1.5">
          <span className="label text-[9px]">Numbers checked</span>
          <span className="value text-text">{report.number_check.checked ? `${replaced.length} replaced` : "no"}</span>
        </span>
        <span className="value text-dim">
          {report.id} · {fmtDate(report.created_at)}
        </span>
      </div>
      {report.fallback && report.fallback_reason && <p className="border-l-2 border-amber bg-amber/5 px-3 py-1.5 text-[11px] text-muted">Fallback reason: {report.fallback_reason}</p>}

      <section className="flex flex-col gap-2">
        <h3 className="label text-text">Executive summary</h3>
        <p className="max-w-[90ch] text-[13px] leading-relaxed text-muted">{es.what_was_tested}</p>
        <p className="max-w-[90ch] text-[14px] leading-relaxed text-text" data-testid="exec-overall">
          {es.overall}
        </p>
        <ul className="flex flex-col gap-2">
          {es.key_findings.map((k, i) => (
            <li key={i} className="border-l-2 border-line-strong pl-3">
              <p className="text-[13px] leading-relaxed text-text/90">{k.text}</p>
              <Evidence refs={k.evidence_refs} />
            </li>
          ))}
        </ul>
        {es.environments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="label mr-1 text-[9px]">Environments</span>
            {es.environments.map((e) => (
              <span key={e} className="sim-tag !text-text">
                {e.toUpperCase()}
              </span>
            ))}
          </div>
        )}
      </section>

      <Narrative title="Performance breakdown" section={report.performance_breakdown} />
      <Narrative title="Environmental sensitivity" section={report.environmental_sensitivity} />
      <Narrative title="Failure analysis" section={report.failure_analysis} />
      <Narrative title="Best and worst conditions" section={report.conditions_narrative}>
        <div className="grid grid-cols-2 gap-4 max-[899px]:grid-cols-1">
          <div>
            <div className="label mb-1 text-teal">Best</div>
            <ConditionTable rows={report.best_conditions} tone="best" />
          </div>
          <div>
            <div className="label mb-1 text-amber">Worst</div>
            <ConditionTable rows={report.worst_conditions} tone="worst" />
          </div>
        </div>
      </Narrative>
      <Narrative title="Hardware suitability" section={report.hardware_suitability} />

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="label text-text">Prioritised recommendations</h3>
        <ol className="flex flex-col gap-2" data-testid="recommendations">
          {report.recommendations
            .slice()
            .sort((a, b) => a.priority - b.priority)
            .map((r, i) => (
              <li key={i} className="grid grid-cols-[28px_1fr] gap-2">
                <span className="value flex h-6 w-6 items-center justify-center border border-line-strong text-[11px] text-text">{r.priority}</span>
                <div>
                  <p className="text-[13px] text-text">{r.action}</p>
                  <p className="text-[12px] leading-relaxed text-muted">{r.rationale}</p>
                  <Evidence refs={r.evidence_refs} />
                </div>
              </li>
            ))}
        </ol>
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="label text-text">Next experiment</h3>
        <div className="grid grid-cols-2 gap-3 max-[759px]:grid-cols-1">
          <KeyValues title="Environment" obj={ne.environment} />
          <KeyValues title="Parameters" obj={ne.parameters} />
        </div>
        <p className="max-w-[90ch] text-[12px] leading-relaxed text-muted">{ne.rationale}</p>
        <Evidence refs={ne.evidence_refs} />
      </section>

      <ConfigSuggestions report={report} />

      {report.disclaimers.length > 0 && (
        <section className="border-t border-line pt-4">
          <h3 className="label mb-1.5 text-text">Disclaimers</h3>
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-snug text-dim">
            {report.disclaimers.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function KeyValues({ title, obj }: { title: string; obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  return (
    <div className="border border-line px-3 py-2">
      <div className="label mb-1 text-[9px]">{title}</div>
      {entries.length ? (
        <dl className="flex flex-col gap-1">
          {entries.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[minmax(90px,35%)_1fr] gap-2 text-[12px]">
              <dt className="value text-muted">{k}</dt>
              <dd className="value break-words text-text">{Array.isArray(v) ? v.join(", ") : fmtValue(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <span className="text-[11px] text-dim">none</span>
      )}
    </div>
  );
}

function ConfigSuggestions({ report }: { report: EngineeringReport }) {
  const [patchFile, setPatchFile] = useState<PatchFile | null>(null);
  const s = report.config_suggestions;
  const patchable = PATCH_FILES.filter((f) => s.some((x) => x.file === f && x.patchable));
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4" data-testid="config-suggestions">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="label text-text">Configuration suggestions</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {patchable.map((f) => (
            <button key={f} type="button" className={clsx("btn inline-flex items-center gap-1.5 !py-1", patchFile === f && "btn-active")} onClick={() => setPatchFile(patchFile === f ? null : f)} aria-expanded={patchFile === f}>
              <FileText size={12} /> View patch: {f}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-dim">Values come from the deterministic rules engine, never from the LLM. Suggestions are hypotheses to test; none claims improved weights.</p>
      {patchFile && <PatchViewer reportId={report.id} file={patchFile} />}
      {s.length === 0 ? (
        <p className="text-[12px] text-muted">No configuration change is suggested by the evidence.</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[1240px] table-fixed text-[12px]">
            <colgroup>
              {[112, 120, 92, 170, 0, 176, 0, 0, 92].map((w, i) => (
                <col key={i} style={w ? { width: w } : undefined} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-line text-left align-bottom">
                {["File", "Key", "Original", "Suggested", "Reason", "Evidence", "Expected benefit", "Trade-offs", "Confidence"].map((h) => (
                  <th key={h} scope="col" className="label px-2 py-1.5 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.map((x) => (
                <tr key={x.id} className="border-b border-line/60 align-top" data-suggestion={x.id}>
                  <td className="value whitespace-nowrap px-2 py-1.5 text-text">
                    {x.file}
                    {!x.patchable && <div className="text-[9px] uppercase tracking-[0.08em] text-dim">advisory</div>}
                  </td>
                  <td className="value break-words px-2 py-1.5 text-text">{x.key}</td>
                  <td className="value px-2 py-1.5 text-muted">
                    {fmtValue(x.original)}
                    <div className="text-[9px] text-dim">{x.original_source.replace(/_/g, " ")}</div>
                  </td>
                  <td className="value break-words px-2 py-1.5 font-medium text-amber">{fmtValue(x.suggested)}</td>
                  <td className="px-2 py-1.5 leading-snug text-text/90">{x.reason}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {[...new Set(x.evidence)].map((e) => (
                        <code key={e} className="max-w-full break-all border border-line bg-ground px-1 font-mono text-[9px] text-muted">
                          {e}
                        </code>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 leading-snug text-muted">{x.expected_benefit}</td>
                  <td className="px-2 py-1.5 leading-snug text-muted">{x.tradeoffs}</td>
                  <td className="px-2 py-1.5">
                    <span className={clsx("sim-tag", x.confidence === "high" ? "!border-teal/70 !text-teal" : x.confidence === "medium" ? "!text-text" : "!text-dim")}>{x.confidence.toUpperCase()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function PatchViewer({ reportId, file }: { reportId: string; file: PatchFile }) {
  const patch = useResource(`patch:${reportId}:${file}`, (s) => api.getPatch(reportId, file, s));
  if (patch.loading) return <SkeletonRows rows={3} />;
  if (patch.error) return <ErrorNote error={patch.error} onRetry={patch.reload} />;
  const p = patch.data!;
  const download = () => {
    const blob = new Blob([p.patched], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.replace(".yaml", ".gantrylab.yaml");
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="flex flex-col gap-2 border border-line bg-ground/50 p-3" data-testid="patch-viewer">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="value text-text">{p.file}</span>
          <span className="sim-tag">{p.original_source === "user_file" ? "FROM YOUR FILE" : "NO ORIGINAL SUPPLIED"}</span>
          <span className="text-dim">applies {p.applied_suggestions.join(", ") || "nothing"}</span>
        </span>
        <button type="button" className="btn inline-flex items-center gap-1.5 !py-1" onClick={download} data-testid="download-patched">
          <Download size={12} /> Download patched copy
        </button>
      </div>
      <p className="text-[11px] leading-snug text-muted">{p.note} Your original stays untouched; the download is a separate copy.</p>
      <pre className="max-h-[320px] overflow-auto border border-line bg-ground py-2 font-mono text-[12px] leading-[1.55]" aria-label={`Unified diff for ${p.file}`} data-testid="patch-diff">
        {p.diff ? (
          p.diff.split("\n").map((line, i) => (
            <div
              key={i}
              className={clsx(
                "whitespace-pre px-3",
                line.startsWith("+++") || line.startsWith("---")
                  ? "text-muted"
                  : line.startsWith("@@")
                    ? "text-dim"
                    : line.startsWith("+")
                      ? "bg-ok/10 text-ok"
                      : line.startsWith("-")
                        ? "bg-danger/10 text-[#f07c80]"
                        : "text-text/80",
              )}
            >
              {line || " "}
            </div>
          ))
        ) : (
          <div className="px-3 text-dim">No changes.</div>
        )}
      </pre>
    </div>
  );
}

export function ReportExports({ reportId }: { reportId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="report-exports">
      <a className="btn inline-flex items-center gap-1.5 !py-1.5" href={urls.reportJson(reportId)} target="_blank" rel="noreferrer">
        <FileJson size={12} /> JSON
      </a>
      <a className="btn inline-flex items-center gap-1.5 !py-1.5" href={urls.reportHtml(reportId)} target="_blank" rel="noreferrer">
        <FileText size={12} /> HTML
      </a>
      <a
        className="btn inline-flex items-center gap-1.5 !py-1.5"
        href={urls.reportHtml(reportId)}
        target="_blank"
        rel="noreferrer"
        title="Opens the print-friendly HTML export. Use the browser's Print dialog (Ctrl+P) and choose Save as PDF."
      >
        <Printer size={12} /> Print / Save as PDF
      </a>
    </div>
  );
}
