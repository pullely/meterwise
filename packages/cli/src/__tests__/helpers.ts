// Test helpers: in-memory token store + context store + fake SDK.

import type { Meterwise } from "@saas/sdk";

import type { StoredCredential, TokenStore } from "../token-store/types.js";

export class MemoryTokenStore implements TokenStore {
  readonly kind = "memory" as const;
  private cred: StoredCredential | null = null;

  constructor(initial?: StoredCredential) {
    this.cred = initial ?? null;
  }

  async load(): Promise<StoredCredential | null> {
    return this.cred;
  }
  async save(cred: StoredCredential): Promise<void> {
    this.cred = cred;
  }
  async clear(): Promise<void> {
    this.cred = null;
  }
}

export interface CapturedFetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

export function captureFetch(responseFactory: () => Response): {
  fetch: typeof fetch;
  calls: CapturedFetchCall[];
} {
  const calls: CapturedFetchCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return responseFactory().clone();
  };
  return { fetch: fn, calls };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function envelope<T>(data: T, requestId = "req_test"): {
  data: T;
  meta: { requestId: string; cursor: null };
} {
  return { data, meta: { requestId, cursor: null } };
}

export type MeterwiseFactory = (baseUrl: string, token: string) => Meterwise;
