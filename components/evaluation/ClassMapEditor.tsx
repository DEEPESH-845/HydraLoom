"use client";

import clsx from "clsx";
import { useId, useMemo, useState } from "react";
import { inputCls } from "./ui";

export type ClassMap = Record<string, string | null>;

/** Exact match first, then case-insensitive match; everything else is ignored. */
export function suggestClassMap(modelClasses: string[], datasetClasses: string[]): ClassMap {
  const exact = new Set(datasetClasses);
  const lower = new Map(datasetClasses.map((c) => [c.toLowerCase(), c]));
  const out: ClassMap = {};
  for (const m of modelClasses) out[m] = exact.has(m) ? m : (lower.get(m.toLowerCase()) ?? null);
  return out;
}

export function coverage(map: ClassMap, datasetClasses: string[]) {
  const covered = new Set(Object.values(map).filter((v): v is string => !!v));
  return { covered: datasetClasses.filter((c) => covered.has(c)), uncovered: datasetClasses.filter((c) => !covered.has(c)) };
}

export function ClassMapEditor({
  modelClasses,
  datasetClasses,
  value,
  onChange,
  disabledReason,
}: {
  modelClasses: string[];
  datasetClasses: string[];
  value: ClassMap;
  onChange: (m: ClassMap) => void;
  disabledReason?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [mappedOnly, setMappedOnly] = useState(false);
  const uid = useId();
  const suggested = useMemo(() => suggestClassMap(modelClasses, datasetClasses), [modelClasses, datasetClasses]);
  const { covered, uncovered } = coverage(value, datasetClasses);
  const nMapped = Object.values(value).filter(Boolean).length;
  const rows = modelClasses
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => (!mappedOnly || value[m]) && (!query || m.toLowerCase().includes(query.toLowerCase())));

  if (disabledReason)
    return (
      <p className="border border-line px-3 py-2 text-[12px] text-muted" data-testid="classmap-disabled">
        {disabledReason}
      </p>
    );

  return (
    <div className="flex flex-col gap-3" data-testid="classmap">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <span className="value text-muted">
          <span className="text-text">{nMapped}</span> of {modelClasses.length} model classes mapped
        </span>
        <span className="value text-muted">
          <span className={uncovered.length ? "text-amber" : "text-teal"}>{covered.length}</span> of {datasetClasses.length} dataset classes covered
        </span>
      </div>
      {uncovered.length > 0 && (
        <p className="border-l-2 border-amber bg-amber/5 px-3 py-1.5 text-[11px] leading-relaxed text-muted" data-testid="classmap-uncovered">
          No model class maps to <span className="value text-text">{uncovered.join(", ")}</span>; recall for {uncovered.length === 1 ? "that class" : "those classes"} will be 0.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${uid}-q`} className="sr-only">
          Filter model classes
        </label>
        <input id={`${uid}-q`} className={clsx(inputCls, "max-w-[220px]")} placeholder="Filter model classes" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
          <input type="checkbox" checked={mappedOnly} onChange={(e) => setMappedOnly(e.target.checked)} className="accent-teal" />
          Mapped only
        </label>
        <button type="button" className="btn !py-1" onClick={() => onChange(suggested)}>
          Reset to suggestions
        </button>
        <button type="button" className="btn !py-1" onClick={() => onChange(Object.fromEntries(modelClasses.map((m) => [m, null])))}>
          Ignore all
        </button>
      </div>
      <div className="relative max-h-[300px] overflow-y-auto border border-line">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="border-b border-line text-left">
              <th scope="col" className="label px-2 py-1.5 font-normal">
                Model class
              </th>
              <th scope="col" className="label px-2 py-1.5 font-normal">
                Dataset class
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, i }) => {
              const v = value[m] ?? null;
              const auto = v !== null && v === suggested[m];
              return (
                <tr key={m} className="border-b border-line/60 last:border-0" data-model-class={m}>
                  <td className="px-2 py-1">
                    <label htmlFor={`${uid}-${i}`} className="flex items-center gap-2">
                      <span className="value w-6 shrink-0 text-right text-[10px] text-dim">{i}</span>
                      <span className={clsx("truncate", v ? "text-text" : "text-muted")}>{m}</span>
                      {auto && <span className="sim-tag !text-[8px] !text-teal">AUTO</span>}
                    </label>
                  </td>
                  <td className="w-[52%] px-2 py-1">
                    <select
                      id={`${uid}-${i}`}
                      value={v ?? ""}
                      onChange={(e) => onChange({ ...value, [m]: e.target.value || null })}
                      className={clsx(inputCls, "!py-1", v ? "border-teal/50" : "text-muted")}
                    >
                      <option value="">ignore</option>
                      {datasetClasses.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={2} className="px-2 py-3 text-center text-[11px] text-dim">
                  No model class matches the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
