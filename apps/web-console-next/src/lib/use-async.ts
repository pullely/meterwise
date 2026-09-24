"use client";

import * as React from "react";
import type { ApiResult } from "@/lib/api";
import { useSession, readStoredToken } from "@/lib/session";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: { code: string; message: string } | null;
  reload: () => void;
}

export function useAsync<T>(
  fn: () => Promise<ApiResult<T>>,
  deps: React.DependencyList,
): AsyncState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);
  const [seq, setSeq] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fn().then(
      (r) => {
        if (cancelled) return;
        if (r.ok) {
          setData(r.data);
        } else {
          setError({ code: r.error.code, message: r.error.message });
        }
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError({ code: "exception", message: (e as Error).message });
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, seq]);

  return { data, loading, error, reload: () => setSeq((x) => x + 1) };
}

/**
 * Redirects to /login only when there is genuinely no session, and returns
 * whether the session is present.
 *
 * The token is hydrated synchronously from localStorage in the provider, so on a
 * reload/deep-link `token` is already set on the first render. As a belt-and-
 * suspenders guard we also re-check storage directly before redirecting: we
 * never bounce a user who actually has a token, even if context state hasn't
 * propagated yet. This is what prevents the "logged out after every reload" bug.
 */
export function useRequireAuth(): boolean {
  const { token } = useSession();
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    setReady(true);
    if (typeof window === "undefined") return;
    if (!token && !readStoredToken()) {
      window.location.href = "/login";
    }
  }, [token]);
  return ready && !!token;
}
