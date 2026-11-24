"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { ApiError, isApiError } from "./client";

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True while the first value for the current key is loading (no data to show yet). */
  loading: boolean;
  /** True while a reload is in flight and the previous data is still shown. */
  refreshing: boolean;
  reload: () => void;
}

interface Slot<T> {
  key: string;
  data?: T;
  error?: ApiError;
}

function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e;
  return new ApiError("invalid_response", e instanceof Error ? e.message : String(e), { path: "" });
}

/**
 * Fetch `fetcher` whenever `key` changes (null disables the fetch).
 * A reload keeps the previous data visible instead of flashing a skeleton.
 */
export function useResource<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [nonce, setNonce] = useState(0);
  const [slot, setSlot] = useState<Slot<T> | null>(null);
  const run = useEffectEvent((signal: AbortSignal) => fetcher(signal));
  const fullKey = key === null ? null : `${key}#${nonce}`;

  useEffect(() => {
    if (fullKey === null) return;
    const ac = new AbortController();
    run(ac.signal).then(
      (data) => {
        if (!ac.signal.aborted) setSlot({ key: fullKey, data });
      },
      (e) => {
        if (ac.signal.aborted) return;
        const err = toApiError(e);
        if (err.kind === "aborted") return;
        setSlot((prev) => ({ key: fullKey, error: err, data: prev && sameBase(prev.key, fullKey) ? prev.data : undefined }));
      },
    );
    return () => ac.abort();
  }, [fullKey]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = slot && fullKey !== null && slot.key === fullKey;
  const sameEntity = slot && fullKey !== null && sameBase(slot.key, fullKey);
  return {
    data: sameEntity ? slot!.data : undefined,
    error: current ? slot!.error : undefined,
    loading: fullKey !== null && !sameEntity,
    refreshing: fullKey !== null && !!sameEntity && !current,
    reload,
  };
}

function sameBase(a: string, b: string) {
  return a.slice(0, a.lastIndexOf("#")) === b.slice(0, b.lastIndexOf("#"));
}

/** Re-run `fn` every `ms` while `active`. */
export function useInterval(fn: () => void, ms: number, active: boolean) {
  const tick = useEffectEvent(fn);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tick(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}

/** localStorage-backed state for per-viewer conveniences; every access is guarded. */
export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
