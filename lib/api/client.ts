/**
 * Typed client for the GANTRYLAB model-evaluation backend (docs/API_V1.md).
 *
 * Every call resolves with the typed body or rejects with an `ApiError` that says whether the
 * backend could not be reached at all (`kind: "unreachable"`) or answered with an HTTP error
 * (`kind: "http"`, with the status and the backend's `detail` message).
 */

import type {
  AskRequest,
  AskResponse,
  CompareResponse,
  ComputeProfileList,
  DatasetDetail,
  DatasetList,
  DatasetManifest,
  EngineeringReport,
  HealthResponse,
  ModelList,
  ModelRecord,
  PatchFile,
  PatchResponse,
  ReportCreate,
  ReportList,
  RunCreate,
  RunCreated,
  RunEvent,
  RunList,
  RunMetrics,
  RunPredictions,
  RunRecord,
  RunStatus,
} from "./types";

export const API_ORIGIN = (process.env.NEXT_PUBLIC_GANTRYLAB_API ?? "http://localhost:8000").replace(/\/+$/, "");
export const API_BASE = `${API_ORIGIN}/api/v1`;

/** The exact start command from backend/README_GANTRYLAB.md. */
export const BACKEND_START_COMMAND = "cd backend\n.venv/Scripts/python -m uvicorn gantrylab.app:app --port 8000";

export type ApiErrorKind = "unreachable" | "http" | "invalid_response" | "aborted";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly detail: unknown;
  readonly path: string;

  constructor(kind: ApiErrorKind, message: string, opts: { status?: number | null; detail?: unknown; path: string }) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.detail = opts.detail;
    this.path = opts.path;
  }

  get unreachable() {
    return this.kind === "unreachable";
  }

  /** Short human label for the error class, for UI headings. */
  get title() {
    if (this.kind === "unreachable") return "Backend unreachable";
    if (this.kind === "aborted") return "Request cancelled";
    if (this.kind === "invalid_response") return "Unexpected response";
    if (this.status === 404) return "Not found";
    if (this.status === 409) return "Not ready yet";
    if (this.status === 413) return "Too large";
    if (this.status === 400 || this.status === 422) return "Request rejected";
    return `HTTP ${this.status}`;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Turn FastAPI's `{"detail": ...}` shapes into one readable sentence. */
export function detailMessage(detail: unknown, fallback: string): string {
  if (detail == null) return fallback;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => {
      if (d && typeof d === "object" && "msg" in d) {
        const loc = Array.isArray((d as { loc?: unknown[] }).loc) ? (d as { loc: unknown[] }).loc.filter((x) => x !== "body").join(".") : "";
        return `${loc ? loc + ": " : ""}${String((d as { msg: unknown }).msg)}`;
      }
      return typeof d === "string" ? d : JSON.stringify(d);
    });
    return parts.join("; ") || fallback;
  }
  if (typeof detail === "object") {
    const o = detail as { message?: unknown; errors?: unknown };
    const head = typeof o.message === "string" ? o.message : fallback;
    if (Array.isArray(o.errors) && o.errors.length) return `${head}: ${detailMessage(o.errors, "")}`;
    return head;
  }
  return fallback;
}

async function errorFromResponse(res: Response, path: string): Promise<ApiError> {
  let detail: unknown = null;
  try {
    const body = await res.json();
    detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : body;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError("http", detailMessage(detail, res.statusText || `HTTP ${res.status}`), { status: res.status, detail, path });
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? "GET", signal: opts.signal, cache: "no-store" };
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) init.body = opts.body;
    else {
      init.body = JSON.stringify(opts.body);
      init.headers = { "content-type": "application/json" };
    }
  }
  let res: Response;
  try {
    res = await fetch(API_BASE + path, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw new ApiError("aborted", "Request cancelled", { path });
    throw new ApiError("unreachable", `Cannot reach the GANTRYLAB backend at ${API_ORIGIN}.`, { path, detail: String(e) });
  }
  if (!res.ok) throw await errorFromResponse(res, path);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("invalid_response", "The backend returned a body that is not JSON.", { status: res.status, path });
  }
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// URL helpers for links, images and downloads
// ---------------------------------------------------------------------------

export const urls = {
  frame: (datasetId: string, file: string) => `${API_BASE}/datasets/${enc(datasetId)}/frames/${enc(file)}`,
  yoloZip: (datasetId: string) => `${API_BASE}/datasets/${enc(datasetId)}/export/yolo.zip`,
  cocoJson: (datasetId: string) => `${API_BASE}/datasets/${enc(datasetId)}/export/coco.json`,
  reportJson: (reportId: string) => `${API_BASE}/reports/${enc(reportId)}/export.json`,
  reportHtml: (reportId: string) => `${API_BASE}/reports/${enc(reportId)}/export.html`,
  docs: () => `${API_ORIGIN}/docs`,
  runEvents: (runId: string) => `${API_BASE.replace(/^http/, "ws")}/runs/${enc(runId)}/events`,
};

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>("/health", { signal }),
  computeProfiles: (signal?: AbortSignal) => request<ComputeProfileList>("/compute-profiles", { signal }),

  listModels: (signal?: AbortSignal) => request<ModelList>("/models", { signal }),
  getModel: (id: string, signal?: AbortSignal) => request<ModelRecord>(`/models/${enc(id)}`, { signal }),

  listDatasets: (signal?: AbortSignal) => request<DatasetList>("/datasets", { signal }),
  getDataset: (id: string, signal?: AbortSignal) => request<DatasetDetail>(`/datasets/${enc(id)}`, { signal }),
  getManifest: (id: string, signal?: AbortSignal) => request<DatasetManifest>(`/datasets/${enc(id)}/manifest`, { signal }),
  uploadDataset: (manifest: DatasetManifest, frames: { file: string; blob: Blob }[]) => {
    const fd = new FormData();
    fd.append("manifest", JSON.stringify(manifest));
    for (const f of frames) fd.append("files", f.blob, f.file);
    return request<DatasetDetail>("/datasets", { method: "POST", body: fd });
  },

  createRun: (body: RunCreate) => request<RunCreated>("/runs", { method: "POST", body }),
  listRuns: (signal?: AbortSignal) => request<RunList>("/runs", { signal }),
  getRun: (id: string, signal?: AbortSignal) => request<RunRecord>(`/runs/${enc(id)}`, { signal }),
  getMetrics: (id: string, signal?: AbortSignal) => request<RunMetrics>(`/runs/${enc(id)}/metrics`, { signal }),
  getPredictions: (id: string, signal?: AbortSignal) => request<RunPredictions>(`/runs/${enc(id)}/predictions`, { signal }),

  createReport: (runId: string, body: ReportCreate) =>
    request<EngineeringReport>(`/runs/${enc(runId)}/report`, { method: "POST", body }),
  listReports: (runId?: string, signal?: AbortSignal) =>
    request<ReportList>(runId ? `/reports?run_id=${enc(runId)}` : "/reports", { signal }),
  getReport: (id: string, signal?: AbortSignal) => request<EngineeringReport>(`/reports/${enc(id)}`, { signal }),
  getPatch: (id: string, file: PatchFile, signal?: AbortSignal) =>
    request<PatchResponse>(`/reports/${enc(id)}/patches/${enc(file)}`, { signal }),
  ask: (id: string, body: AskRequest) => request<AskResponse>(`/reports/${enc(id)}/ask`, { method: "POST", body }),

  compare: (a: string, b: string, signal?: AbortSignal) =>
    request<CompareResponse>(`/compare?runs=${enc(a)},${enc(b)}`, { signal }),
};

// ---------------------------------------------------------------------------
// Model upload with progress (XMLHttpRequest exposes upload progress events; fetch does not)
// ---------------------------------------------------------------------------

export interface UploadProgress {
  loaded: number;
  total: number;
  fraction: number;
}

export interface UploadHandle {
  promise: Promise<{ record: ModelRecord; created: boolean }>;
  abort: () => void;
}

export function uploadModel(file: File, opts: { name?: string; onProgress?: (p: UploadProgress) => void } = {}): UploadHandle {
  const xhr = new XMLHttpRequest();
  const path = "/models";
  const promise = new Promise<{ record: ModelRecord; created: boolean }>((resolve, reject) => {
    xhr.open("POST", API_BASE + path);
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      const total = e.lengthComputable ? e.total : file.size;
      opts.onProgress?.({ loaded: e.loaded, total, fraction: total > 0 ? Math.min(1, e.loaded / total) : 0 });
    };
    xhr.onerror = () =>
      reject(new ApiError("unreachable", `Cannot reach the GANTRYLAB backend at ${API_ORIGIN}.`, { path }));
    xhr.onabort = () => reject(new ApiError("aborted", "Upload cancelled", { path }));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        /* handled below */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!body || typeof body !== "object") {
          reject(new ApiError("invalid_response", "The backend returned a body that is not JSON.", { status: xhr.status, path }));
          return;
        }
        resolve({ record: body as ModelRecord, created: xhr.status === 201 });
        return;
      }
      const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : body;
      reject(new ApiError("http", detailMessage(detail, xhr.statusText || `HTTP ${xhr.status}`), { status: xhr.status, detail, path }));
    };
    const fd = new FormData();
    fd.append("file", file, file.name);
    if (opts.name) fd.append("name", opts.name);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

/** Poll `GET /models/{id}` until inspection leaves `pending`. */
export function waitForInspection(
  id: string,
  opts: { intervalMs?: number; onUpdate?: (m: ModelRecord) => void; signal?: AbortSignal } = {},
): Promise<ModelRecord> {
  const interval = opts.intervalMs ?? 1000;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer) clearTimeout(timer);
    };
    opts.signal?.addEventListener("abort", () => {
      stop();
      reject(new ApiError("aborted", "Polling cancelled", { path: `/models/${id}` }));
    });
    const tick = async () => {
      try {
        const m = await api.getModel(id, opts.signal);
        opts.onUpdate?.(m);
        if (m.status !== "pending") {
          resolve(m);
          return;
        }
      } catch (e) {
        if (isApiError(e) && e.kind === "aborted") return;
        reject(e);
        return;
      }
      timer = setTimeout(tick, interval);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Run progress: WebSocket event stream with polling fallback
// ---------------------------------------------------------------------------

export type RunWatchSource = "websocket" | "polling";

export interface RunWatchUpdate {
  status: RunStatus;
  progress: number;
  message: string;
  type: RunEvent["type"] | "snapshot";
  source: RunWatchSource;
  ts: string;
}

export interface RunWatchOptions {
  onUpdate: (u: RunWatchUpdate) => void;
  /** Called once with the final run record when the run reaches `complete` or `failed`. */
  onDone?: (run: RunRecord) => void;
  onError?: (e: ApiError) => void;
  onSourceChange?: (s: RunWatchSource) => void;
  pollIntervalMs?: number;
  /** Skip the WebSocket and poll from the start. */
  forcePolling?: boolean;
}

const TERMINAL: RunStatus[] = ["complete", "failed"];

/**
 * Follow a run. Opens `WS /runs/{id}/events`; if the socket cannot be opened, errors, or closes
 * before a terminal event, falls back to polling `GET /runs/{id}`. Returns a cancel function.
 */
export function watchRun(runId: string, opts: RunWatchOptions): () => void {
  let cancelled = false;
  let ws: WebSocket | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let done = false;
  const interval = opts.pollIntervalMs ?? 1000;

  const finish = async () => {
    if (done || cancelled) return;
    done = true;
    try {
      const run = await api.getRun(runId);
      if (!cancelled) opts.onDone?.(run);
    } catch (e) {
      if (!cancelled && isApiError(e)) opts.onError?.(e);
    }
  };

  const poll = async () => {
    if (cancelled || done) return;
    try {
      const run = await api.getRun(runId);
      if (cancelled) return;
      opts.onUpdate({ status: run.status, progress: run.progress, message: run.message, type: "snapshot", source: "polling", ts: run.finished_at ?? run.started_at ?? run.created_at });
      if (TERMINAL.includes(run.status)) {
        done = true;
        opts.onDone?.(run);
        return;
      }
    } catch (e) {
      if (cancelled) return;
      if (isApiError(e)) opts.onError?.(e);
    }
    pollTimer = setTimeout(poll, interval);
  };

  const startPolling = () => {
    if (polling || cancelled || done) return;
    polling = true;
    opts.onSourceChange?.("polling");
    poll();
  };

  if (opts.forcePolling || typeof WebSocket === "undefined") {
    startPolling();
  } else {
    try {
      ws = new WebSocket(urls.runEvents(runId));
      opts.onSourceChange?.("websocket");
      ws.onmessage = (msg) => {
        if (cancelled) return;
        let ev: (Omit<Partial<RunEvent>, "type"> & { type?: RunEvent["type"] | "error"; message?: string }) | null = null;
        try {
          ev = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        if (!ev) return;
        if (ev.type === "error") {
          opts.onError?.(new ApiError("http", ev.message ?? "run not found", { status: 404, path: `/runs/${runId}/events` }));
          done = true;
          return;
        }
        if (ev.status) {
          opts.onUpdate({
            status: ev.status,
            progress: ev.progress ?? 0,
            message: ev.message ?? "",
            type: (ev.type as RunEvent["type"]) ?? "status",
            source: "websocket",
            ts: ev.ts ?? "",
          });
          if (TERMINAL.includes(ev.status) && (ev.type === "complete" || ev.type === "failed" || ev.type === "status")) finish();
        }
      };
      ws.onerror = () => {
        /* onclose follows; fall back there */
      };
      ws.onclose = () => {
        ws = null;
        if (!cancelled && !done) startPolling();
      };
    } catch {
      startPolling();
    }
  }

  return () => {
    cancelled = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Client-side upload validation
// ---------------------------------------------------------------------------

export const MODEL_EXTENSIONS = [".pt", ".onnx"] as const;

export function validateModelFile(file: File, maxMb: number): string | null {
  const lower = file.name.toLowerCase();
  if (!MODEL_EXTENSIONS.some((ext) => lower.endsWith(ext))) return `"${file.name}" is not a .pt or .onnx file.`;
  if (/[\\/]|\.\.|[\u0000-\u001f]/.test(file.name)) return "The file name contains path separators, '..' or control characters.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > maxMb * 1024 * 1024) return `The file is ${(file.size / 1048576).toFixed(1)} MB; the backend limit is ${maxMb} MB.`;
  return null;
}
