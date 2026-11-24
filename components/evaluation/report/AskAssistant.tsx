"use client";

import { Send } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { api, isApiError, type ApiError } from "@/lib/api/client";
import type { AskResponse } from "@/lib/api/types";
import { ErrorNote, Evidence, inputCls } from "../ui";

export const SUGGESTED_QUESTIONS = [
  "Why did my model fail in the harbor?",
  "Which environmental parameter caused the largest degradation?",
  "Which training configuration should I test next?",
];

export function AskAssistant({ reportId }: { reportId: string }) {
  const uid = useId();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [history, setHistory] = useState<AskResponse[]>([]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.ask(reportId, { question: text });
      setHistory((h) => [res, ...h]);
      setQ("");
    } catch (e) {
      if (isApiError(e)) setError(e);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(q);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="ask-assistant">
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTED_QUESTIONS.map((s) => (
          <button key={s} type="button" className="border border-line px-2.5 py-1 text-left text-[12px] text-muted transition-colors duration-100 hover:border-teal hover:text-text disabled:opacity-50" onClick={() => ask(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      <form onSubmit={onSubmit} className="flex gap-2">
        <label htmlFor={`${uid}-q`} className="sr-only">
          Question about this evaluation
        </label>
        <input
          id={`${uid}-q`}
          className={inputCls + " !py-2 font-sans !text-[13px]"}
          placeholder="Ask about this run, answered only from the stored evidence"
          value={q}
          maxLength={2000}
          onChange={(e) => setQ(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary inline-flex shrink-0 items-center gap-1.5" disabled={busy || !q.trim()}>
          <Send size={13} /> {busy ? "Asking" : "Ask"}
        </button>
      </form>
      {error && <ErrorNote error={error} />}
      <div aria-live="polite" className="flex flex-col gap-3">
        {history.map((h, i) => (
          <div key={history.length - i} className="flex flex-col gap-1.5 border border-line px-3 py-2.5" data-testid="ask-answer">
            <p className="text-[12px] text-muted">
              <span className="label mr-2 text-[9px]">Q</span>
              {h.question}
            </p>
            <p className="text-[13px] leading-relaxed text-text">{h.answer}</p>
            <p className="border-l-2 border-amber/70 pl-2 text-[11px] leading-snug text-muted">
              <span className="label mr-1.5 text-[9px] text-amber">Uncertainty</span>
              {h.uncertainty}
            </p>
            <Evidence refs={h.evidence_refs} />
            <span className="value text-[10px] text-dim">
              {h.provider}
              {h.fallback ? ` · fallback${h.fallback_reason ? `: ${h.fallback_reason}` : ""}` : ""}
              {h.mock ? " · MOCK run" : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
