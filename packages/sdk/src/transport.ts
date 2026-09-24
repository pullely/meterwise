// Base HTTP transport for the Meterwise SDK.
//
// Goals:
// - Runtime-agnostic: native `fetch`, native `crypto.randomUUID`, no `node:*`.
// - Stripe-style ergonomics: `Idempotency-Key` is a per-request option,
//   request-id auto-generated when caller omits it, abort signal passthrough.
// - Typed errors: every non-2xx response is decoded into a `MeterwiseError`
//   subclass via `decodeError`.
// - Forward-compatible envelope: success responses are `{ data: T, meta: {...} }`
//   today; the transport only requires the `data` field to exist.

import { decodeError } from "./errors.js";

export type AuthOption =
  | { kind: "bearer"; token: string }
  | { kind: "session"; cookie: string };

export interface ClientOptions {
  /**
   * Base URL of the Meterwise api-edge worker, e.g.
   * `https://api.meterwise.app`. Trailing slash is stripped.
   */
  baseUrl: string;
  /** Optional auth credential; sent on every request when present. */
  auth?: AuthOption;
  /** Default headers merged into every request (per-request wins on conflict). */
  defaultHeaders?: Record<string, string>;
  /**
   * Custom `fetch` implementation. Defaults to the platform global. Useful
   * for tests, retries-on-the-outside, or polyfilled environments.
   */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /**
   * Per-request idempotency key. Caller-owned (Stripe parity) — the SDK does
   * NOT auto-generate one for unsafe methods. When omitted, no
   * `Idempotency-Key` header is sent.
   */
  idempotencyKey?: string;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
  /**
   * Request id for distributed tracing. When omitted, the SDK generates a
   * `req_<uuid>` value and sends it as `x-request-id`.
   */
  requestId?: string;
  /** Per-request header overrides (merged after defaults). */
  headers?: Record<string, string>;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: { requestId: string; cursor?: string | null };
}

interface PerformInput {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined> | undefined;
  body?: unknown;
}

/**
 * Internal HTTP gateway. Resource clients receive an instance of this and call
 * `request<T>()`; they never see `fetch` directly.
 *
 * The transport is intentionally exported so power users can drive it without
 * the high-level resource namespaces, but the public stable surface is
 * `Meterwise` (the client class wired up in `index.ts`).
 */
export class Transport {
  readonly baseUrl: string;
  readonly auth: AuthOption | undefined;
  readonly defaultHeaders: Record<string, string>;
  readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.auth = options.auth;
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError(
        "Meterwise SDK requires a fetch implementation. Pass `fetch` in options on platforms without a global.",
      );
    }
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  async request<T>(input: PerformInput, opts: RequestOptions = {}): Promise<T> {
    const { data } = await this.performRequest<T>(input, opts);
    return data;
  }

  /**
   * Envelope-aware sibling of `request<T>`. Returns BOTH the unwrapped `data`
   * payload AND the `meta` block (request id + optional cursor) so paginated
   * resource clients can drive cursor-based loops without reaching into raw
   * `fetchImpl`. Same auth / idempotency / abort-signal semantics as
   * `request<T>`.
   *
   * Added for Task 0102 (SDK-side close of audit pagination gap surfaced by
   * Task 0101). `EventsClient.iterAuditEntries` consumes this; future
   * paginated reads (security events, future feeds) can adopt the same
   * pattern.
   */
  async requestWithEnvelope<T>(
    input: PerformInput,
    opts: RequestOptions = {},
  ): Promise<{ data: T; meta: { requestId: string; cursor?: string | null } }> {
    return this.performRequest<T>(input, opts);
  }

  private async performRequest<T>(
    input: PerformInput,
    opts: RequestOptions,
  ): Promise<{ data: T; meta: { requestId: string; cursor?: string | null } }> {
    const url = this.buildUrl(input.path, input.query);
    const requestId = opts.requestId ?? generateRequestId();

    const headers = new Headers();
    for (const [k, v] of Object.entries(this.defaultHeaders)) headers.set(k, v);
    if (this.auth) applyAuth(headers, this.auth);

    let body: BodyInit | undefined;
    if (input.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(input.body);
    }

    headers.set("accept", "application/json");
    headers.set("x-request-id", requestId);
    if (opts.idempotencyKey !== undefined) {
      headers.set("idempotency-key", opts.idempotencyKey);
    }
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) headers.set(k, v);
    }

    const init: RequestInit = {
      method: input.method,
      headers,
    };
    if (body !== undefined) init.body = body;
    if (opts.signal !== undefined) init.signal = opts.signal;

    const response = await this.fetchImpl(url, init);

    if (!response.ok) {
      throw await decodeError(response, requestId);
    }

    if (response.status === 204) {
      // No content: caller-supplied T is implicitly `void`/`null`-shaped.
      return { data: undefined as T, meta: { requestId } };
    }

    const parsed: unknown = await response.json();
    if (isSuccessEnvelope(parsed)) {
      const meta = parsed.meta ?? { requestId };
      return { data: parsed.data as T, meta };
    }
    // Defensive: server returned a 2xx with a non-conformant body. Surface the
    // raw payload to the caller rather than crashing.
    return { data: parsed as T, meta: { requestId } };
  }

  private buildUrl(
    path: string,
    query: Record<string, string | number | undefined> | undefined,
  ): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(this.baseUrl + normalized);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

function applyAuth(headers: Headers, auth: AuthOption): void {
  switch (auth.kind) {
    case "bearer":
      headers.set("authorization", `Bearer ${auth.token}`);
      return;
    case "session":
      headers.set("cookie", auth.cookie);
      return;
  }
}

/**
 * Generate a `req_<uuid>`-shaped request id using the platform `crypto.randomUUID`.
 * Falls back to a `getRandomValues`-derived hex string on the (rare) platforms
 * that expose `crypto` but not `randomUUID`.
 */
export function generateRequestId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return `req_${cryptoRef.randomUUID().replace(/-/g, "")}`;
  }
  if (cryptoRef && typeof cryptoRef.getRandomValues === "function") {
    const buf = new Uint8Array(16);
    cryptoRef.getRandomValues(buf);
    let hex = "";
    for (let i = 0; i < buf.length; i++) {
      hex += (buf[i] ?? 0).toString(16).padStart(2, "0");
    }
    return `req_${hex}`;
  }
  throw new Error(
    "Meterwise SDK requires the Web Crypto API (globalThis.crypto). No source of randomness was found.",
  );
}

function isSuccessEnvelope(value: unknown): value is SuccessEnvelope<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    !Array.isArray(value)
  );
}
