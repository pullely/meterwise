"use client";

import * as React from "react";
import type { Meterwise } from "@saas/sdk";
import {
  TARGETS,
  DEPLOY_ENV,
  createClient,
  type ApiTarget,
} from "./api";
import { STORAGE_PREFIX } from "./app-config";

const TOKEN_KEY = `${STORAGE_PREFIX}.token`;
const TARGET_KEY = `${STORAGE_PREFIX}.target`;

/**
 * Read the persisted bearer token straight from localStorage (client only).
 * Shared by the provider's initial state and the auth guard so both observe the
 * exact same source of truth — the guard never bounces a user who actually has
 * a token, even before React state has propagated.
 */
export function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

interface SessionCtx {
  client: Meterwise;
  target: ApiTarget;
  token: string | null;
  setToken: (t: string | null) => void;
  setTarget: (t: ApiTarget) => void;
  availableTargets: ApiTarget[];
  isLocked: boolean;
  deployEnv: string | undefined;
}

const Ctx = React.createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  // Read persisted session synchronously in the initializer (client only). This
  // means the token is already present on the *first* client render, so the auth
  // guard never observes a false `null` and bounces an authenticated user to
  // /login on a hard refresh or deep link. SSR returns null and the shell gates
  // on `ready` (set in an effect), so the committed markup stays consistent.
  const [target, setTargetState] = React.useState<ApiTarget>(() => {
    if (typeof window === "undefined") return TARGETS[0]!;
    try {
      const saved = window.localStorage.getItem(TARGET_KEY);
      return TARGETS.find((t) => t.name === saved) ?? TARGETS[0]!;
    } catch {
      return TARGETS[0]!;
    }
  });
  const [token, setTokenState] = React.useState<string | null>(() => readStoredToken());

  const client = React.useMemo(() => createClient(target, token), [target, token]);

  const setToken = React.useCallback((t: string | null) => {
    setTokenState(t);
    if (typeof window !== "undefined") {
      try {
        if (t) window.localStorage.setItem(TOKEN_KEY, t);
        else window.localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const setTarget = React.useCallback((t: ApiTarget) => {
    setTargetState(t);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(TARGET_KEY, t.name);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const value = React.useMemo<SessionCtx>(
    () => ({
      client,
      target,
      token,
      setToken,
      setTarget,
      availableTargets: TARGETS,
      isLocked: TARGETS.length === 1 && !!DEPLOY_ENV,
      deployEnv: DEPLOY_ENV,
    }),
    [client, target, token, setToken, setTarget],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("useSession must be used inside <SessionProvider>");
  return c;
}
