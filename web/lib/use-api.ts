"use client";

import { useCallback, useEffect, useState } from "react";
import type { ZodType } from "zod";
import { apiFetch, errorMessage } from "./api";

/**
 * Loads one GET endpoint for a page. `path` null means "do not load yet". While a newer answer is
 * on its way the previous one stays visible (after a save the page does not flash empty).
 * The schema must be a module-level constant so it does not trigger reloads.
 */
export function useApi<T>(path: string | null, schema: ZodType<T>) {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: string }>({ path: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) return;
    const ac = new AbortController();
    apiFetch(path, { schema, signal: ac.signal }).then(
      (data) => setState({ path, data }),
      (err: unknown) => {
        if (ac.signal.aborted) return;
        setState({ path, error: errorMessage(err) });
      },
    );
    return () => ac.abort();
  }, [path, schema, tick]);

  const current = state.path === path ? state : { path };
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return {
    data: current.data,
    error: current.error ?? null,
    loading: path !== null && current.data === undefined && current.error === undefined,
    reload,
  };
}
