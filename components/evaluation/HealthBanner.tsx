"use client";

import clsx from "clsx";
import type { HealthResponse } from "@/lib/api/types";
import { useState, useSyncExternalStore } from "react";
import { API_ORIGIN, apiToken, setApiToken, urls } from "@/lib/api/client";

function Flag({ name, on, title }: { name: string; on: boolean; title?: string }) {
  return (
    <span title={title} data-flag={name} data-on={on} className={clsx("inline-flex items-center gap-1.5 border px-1.5 py-[2px]", on ? "border-line-strong" : "border-line")}>
      <span className={clsx("h-1.5 w-1.5 rounded-full", on ? "bg-teal" : "bg-line-strong")} aria-hidden />
      <span className={clsx("font-mono text-[10px] tracking-[0.08em] uppercase", on ? "text-text" : "text-dim")}>{name}</span>
      <span className="sr-only">{on ? "available" : "not available"}</span>
    </span>
  );
}

/** Backend status strip: service, devices, adapters and configured LLM providers (booleans only). */
export function HealthBanner({ health }: { health: HealthResponse }) {
  const cuda = health.devices.cuda ?? [];
  return (
    <div data-testid="health-banner" className="panel flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 max-[479px]:px-3">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-teal" aria-hidden />
        <span className="label text-text">Backend online</span>
        <a href={urls.docs()} target="_blank" rel="noreferrer" className="value text-[11px] text-muted underline decoration-line-strong underline-offset-2 hover:text-text">
          {API_ORIGIN.replace(/^https?:\/\//, "")} v{health.version}
        </a>
      </div>
      <Group label="Devices">
        <Flag name="CPU" on title={health.devices.cpu ?? "CPU"} />
        {cuda.length ? cuda.map((g) => <Flag key={g} name="CUDA" on title={g} />) : <Flag name="CUDA" on={false} title="No CUDA device reported" />}
        <span className="value hidden truncate text-[11px] text-muted min-[1280px]:inline">{cuda[0] ?? health.devices.cpu ?? ""}</span>
      </Group>
      <Group label="Adapters">
        {Object.entries(health.adapters).map(([k, v]) => (
          <Flag key={k} name={k} on={v} />
        ))}
      </Group>
      <Group label="LLM">
        {Object.entries(health.llm_providers).map(([k, v]) => (
          <Flag key={k} name={k} on={v} title={v ? `${k} configured` : `${k} not configured`} />
        ))}
      </Group>
      {health.write_auth && <TokenField />}
      {!health.data_dir_writable && <span className="label text-danger">Data directory is not writable</span>}
    </div>
  );
}

const never = () => () => {};

/** The backend accepts writes only with its access token. Stored in this browser, sent only to the backend. */
function TokenField() {
  const saved = useSyncExternalStore(never, () => apiToken() !== "", () => false);
  const [has, setHas] = useState<boolean | null>(null);
  const [v, setV] = useState("");
  const ok = has ?? saved;
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setApiToken(v.trim());
        setHas(v.trim() !== "");
        setV("");
      }}
    >
      <label className="label text-[9px] text-dim" htmlFor="api-token">
        Access token
      </label>
      <input id="api-token" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder={ok ? "saved" : "needed to upload and run"} className="value w-44 border border-line-strong bg-ground px-2 py-1 text-[11px] text-text placeholder:text-dim" />
      <button type="submit" className="btn !px-2 !py-1">
        {ok && !v ? "Clear" : "Save"}
      </button>
    </form>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="label mr-0.5 text-[9px] text-dim">{label}</span>
      {children}
    </div>
  );
}
