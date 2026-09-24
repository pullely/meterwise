// Edge-side per-org / per-identity rate limiter (Task 0097).
//
// Sits in front of `replayOrExecute` so every facade picks it up uniformly.
// Independent buckets:
//
//   - `org`:      keyed on `orgId` extracted from `/v1/organizations/{orgId}/…`.
//                 Skipped when the URL has no org segment.
//   - `identity`: keyed on a SHA-256 fingerprint of the bearer token when one
//                 is present (same token ⇒ same bucket, regardless of which
//                 actor type `resolveActor` will eventually classify it as);
//                 otherwise falls back to `anon:<routeFamily>:<CF-Connecting-IP>`
//                 so abuse from a single IP cannot bypass the limit.
//
// Algorithm: token bucket with refill per second. State persisted in KV as
// compact JSON `{t, r}` (`t` = tokens float, `r` = refilledAt epoch seconds).
// Last-writer-wins under concurrent retry — acceptable for V1; documented in
// the implementer report.
//
// Backend: reuses `IDEMPOTENCY_KV` with a mandatory `rl:v1:` key prefix to
// avoid keyspace collision with the existing `idem:v1:` replay store. This
// ships the limiter without the chicken-and-egg of provisioning a new KV
// namespace + wiring its ID in the same PR.
//
// Failure-open: if the KV binding is missing, or `get`/`put` throws, the
// request is admitted without rate-limit headers (we have no real counters
// to publish under failure). Logged via `console.warn`.
//
// PERF5 (latency): the KV token bucket did a `get`+`put` per bucket on EVERY
// request, before auth — measured at ~130ms/bucket, ~264ms for an org-scoped
// read (org + identity buckets, serialized). The fix has two stages:
//
//   Stage A — take it off the read hot path without losing protection:
//     1. Unsafe (mutating) methods keep a durable cross-isolate limiter, but the
//        buckets are evaluated CONCURRENTLY (`Promise.all`) instead of serially.
//     2. Safe (read) methods use a colo-local, in-isolate token bucket with ZERO
//        network I/O. Approximate (per-isolate state ⇒ the effective global limit
//        scales with isolate count) — acceptable for reads: caps are generous and
//        reads are not the abuse vector writes are.
//
//   Stage B — make the durable (write) limiter both faster and CORRECT:
//     the durable counters move from KV to Durable Objects. Each (scope,key)
//     bucket maps to one DO instance whose single-threaded execution makes the
//     read-modify-write atomic (fixing the KV limiter's documented
//     last-writer-wins race) with no central KV write on the hot path. When the
//     DO binding is absent (dev/local), the limiter falls back to the Stage A KV
//     path, then to fail-open — so the change is safe to roll out incrementally.

import type { Env } from "./env.js";

export type RouteFamily =
  | "auth"
  | "org"
  | "project"
  | "config"
  | "webhooks"
  | "metering"
  | "billing"
  | "audit"
  | "notifications"
  | "integrations";

interface BucketLimits {
  /** Bucket capacity (max tokens). */
  limit: number;
  /** Window length in seconds; refill rate = limit / windowSec tokens/sec. */
  windowSec: number;
}

interface FamilyConfig {
  identity: BucketLimits;
  org: BucketLimits;
}

/**
 * Per-route-family caps. Picked to absorb legitimate burstiness while still
 * blunting abuse. Tunable; no per-tenant overrides yet (B5 territory).
 *
 *   - `auth`: tighter — login/logout flows are the brute-force target.
 *   - everything else (writes/reads): 60/300 per minute identity/org.
 *   - `audit` is read-only and trusted further; raised to 120/600.
 */
const LIMITS: Record<RouteFamily, FamilyConfig> = {
  auth: {
    identity: { limit: 10, windowSec: 60 },
    org: { limit: 60, windowSec: 60 },
  },
  org: {
    identity: { limit: 60, windowSec: 60 },
    org: { limit: 300, windowSec: 60 },
  },
  project: {
    identity: { limit: 60, windowSec: 60 },
    org: { limit: 300, windowSec: 60 },
  },
  config: {
    identity: { limit: 60, windowSec: 60 },
    org: { limit: 300, windowSec: 60 },
  },
  webhooks: {
    identity: { limit: 60, windowSec: 60 },
    org: { limit: 300, windowSec: 60 },
  },
  metering: {
    identity: { limit: 60, windowSec: 60 },
    org: { limit: 300, windowSec: 60 },
  },
  billing: {
    identity: { limit: 60, windowSec: 60 },
    org: { limit: 300, windowSec: 60 },
  },
  audit: {
    identity: { limit: 120, windowSec: 60 },
    org: { limit: 600, windowSec: 60 },
  },
  notifications: {
    identity: { limit: 60, windowSec: 60 },
    org: { limit: 300, windowSec: 60 },
  },
  integrations: {
    identity: { limit: 60, windowSec: 60 },
    org: { limit: 300, windowSec: 60 },
  },
};

const KV_PREFIX = "rl:v1";
const KV_TTL_SECONDS = 600;
const ORG_PATH_RE = /^\/v1\/organizations\/([^/]+)/;

// PERF5 Stage A: only mutating methods pay the durable cross-isolate KV
// limiter. Safe reads use the in-isolate limiter below. Mirrors the
// `UNSAFE_METHODS` set in idempotency.ts (kept local to avoid an import cycle).
const DURABLE_LIMIT_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
]);

// In-isolate token-bucket state for safe (read) methods. Colo-local and
// per-isolate by design (see `enforceRateLimit`). Bounded so a long-lived
// isolate seeing many distinct orgs/identities cannot grow it without limit.
interface MemBucketState {
  t: number;
  r: number;
}
const MEM_BUCKET_CAP = 10_000;
const memBuckets = new Map<string, MemBucketState>();

/** Public result. `headers` is merged into the final response by the caller. */
export type RateLimitResult =
  | { kind: "allowed"; headers: Record<string, string> }
  | { kind: "denied"; response: Response };

/** Token-bucket persistence shape: `t` = tokens (float), `r` = refilledAt (epoch s). */
export interface BucketState {
  t: number;
  r: number;
}

interface BucketDecision {
  scope: "org" | "identity";
  limit: number;
  remaining: number;
  resetEpoch: number;
  retryAfterSec: number;
  allowed: boolean;
}

export interface TokenBucketStep {
  next: BucketState;
  allowed: boolean;
  remaining: number;
  resetEpoch: number;
  retryAfterSec: number;
}

/**
 * Pure token-bucket step — the single source of truth for the refill/consume
 * math, shared by the KV limiter, the in-isolate read limiter, and the Durable
 * Object write limiter (PERF5). Given the previous state (or `null` for a fresh
 * bucket) and the current time, returns the new state and the decision.
 */
export function tokenBucketStep(
  prev: BucketState | null,
  limit: number,
  windowSec: number,
  now: number,
): TokenBucketStep {
  const refillRate = limit / windowSec;
  const base = prev ?? { t: limit, r: now };
  const elapsed = Math.max(0, now - base.r);
  const refilled = Math.min(limit, base.t + elapsed * refillRate);

  if (refilled >= 1) {
    const tokens = refilled - 1;
    return {
      next: { t: tokens, r: now },
      allowed: true,
      remaining: Math.floor(tokens),
      resetEpoch: Math.ceil(now + (limit - tokens) / refillRate),
      retryAfterSec: 0,
    };
  }
  return {
    next: { t: refilled, r: now },
    allowed: false,
    remaining: 0,
    resetEpoch: Math.ceil(now + (limit - refilled) / refillRate),
    retryAfterSec: Math.max(1, Math.ceil((1 - refilled) / refillRate)),
  };
}

/**
 * Returns `allowed` (with headers to merge) or `denied` (with a complete
 * 429 response carrying the standard envelope and `Retry-After`).
 *
 * Never throws; KV failures degrade to admit-with-no-headers per the
 * fail-open contract.
 */
export async function enforceRateLimit(
  request: Request,
  requestId: string,
  env: Env,
  routeFamily: RouteFamily,
): Promise<RateLimitResult> {
  const config = LIMITS[routeFamily];

  const url = new URL(request.url);
  const orgId = extractOrgId(url.pathname);
  const identityKey = await deriveIdentityKey(request, routeFamily);

  const buckets: Array<{
    scope: "org" | "identity";
    key: string;
    limits: BucketLimits;
  }> = [];
  if (orgId) {
    buckets.push({
      scope: "org",
      key: `${KV_PREFIX}:org:${routeFamily}:${orgId}`,
      limits: config.org,
    });
  }
  buckets.push({
    scope: "identity",
    key: `${KV_PREFIX}:identity:${routeFamily}:${identityKey}`,
    limits: config.identity,
  });

  let decisions: BucketDecision[];
  let failureOpen = false;

  if (DURABLE_LIMIT_METHODS.has(request.method)) {
    // Unsafe (mutating) methods → durable, cross-isolate limiter.
    const ns = env.RATE_LIMITER_DO;
    if (ns) {
      // PERF5 Stage B: precise per-(scope,key) counters in Durable Objects.
      // Each bucket key maps to one DO instance whose single-threaded execution
      // makes the read-modify-write ATOMIC (no last-writer-wins race, the KV
      // limiter's documented V1 flaw) and needs no central KV write on the hot
      // path. Buckets are independent → evaluated concurrently.
      decisions = await Promise.all(
        buckets.map(async (b) => {
          try {
            return await consumeViaDurableObject(ns, b.key, b.limits, b.scope);
          } catch (err) {
            logLimiterFailure("durable_object", err, requestId);
            failureOpen = true;
            return fullBucketDecision(b.scope, b.limits);
          }
        }),
      );
    } else {
      // Fallback: the durable KV limiter (Stage A) when the DO binding is not
      // wired (e.g. dev / local). Backend missing entirely → fail open.
      const kv = env.IDEMPOTENCY_KV;
      if (!kv) {
        return { kind: "allowed", headers: {} };
      }
      // PERF5 Stage A: buckets are independent keys → evaluate CONCURRENTLY
      // rather than in a serial await-loop (halves the KV cost on org routes).
      decisions = await Promise.all(
        buckets.map(async (b) => {
          try {
            return await consumeToken(kv, b.key, b.limits, b.scope);
          } catch (err) {
            logLimiterFailure("kv", err, requestId);
            failureOpen = true;
            return fullBucketDecision(b.scope, b.limits);
          }
        }),
      );
    }
  } else {
    // PERF5 Stage A: safe (read) methods use a colo-local, in-isolate token
    // bucket — ZERO network I/O — so the KV read-modify-write is OFF the read
    // hot path. Approximate (per-isolate) by design; see the module header.
    decisions = buckets.map((b) =>
      consumeTokenInMemory(b.key, b.limits, b.scope),
    );
  }

  const headers = buildHeaders(decisions);

  // Under failure-open we do NOT deny even if a partial decision said no —
  // the fail-open contract supersedes the partial counter.
  if (failureOpen) {
    return { kind: "allowed", headers };
  }

  const denied = decisions.find((d) => !d.allowed);
  if (denied) {
    const retry = Math.max(1, denied.retryAfterSec);
    const responseHeaders: Record<string, string> = {
      ...headers,
      "content-type": "application/json",
      "Retry-After": String(retry),
    };
    const body = JSON.stringify({
      error: {
        code: "rate_limited",
        message: `Rate limit exceeded for ${denied.scope} scope. Retry after ${retry} seconds.`,
        details: { scope: denied.scope, retryAfterSeconds: retry },
        requestId,
      },
    });
    return {
      kind: "denied",
      response: new Response(body, { status: 429, headers: responseHeaders }),
    };
  }

  return { kind: "allowed", headers };
}

/**
 * Merge rate-limit headers into an existing response without reading its body.
 * Used by `replayOrExecute` to decorate every allowed response.
 */
export function mergeRateLimitHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  if (Object.keys(headers).length === 0) return response;
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) {
    merged.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

// --- Internals ---

async function consumeToken(
  kv: KVNamespace,
  key: string,
  limits: BucketLimits,
  scope: "org" | "identity",
): Promise<BucketDecision> {
  const now = Date.now() / 1000;
  const refillRate = limits.limit / limits.windowSec;

  const raw = await kv.get(key, "text");
  let state: BucketState;
  if (raw) {
    const parsed = parseState(raw);
    state = parsed ?? { t: limits.limit, r: now };
  } else {
    state = { t: limits.limit, r: now };
  }

  // Refill since last touch, capped at limit.
  const elapsed = Math.max(0, now - state.r);
  const refilled = Math.min(limits.limit, state.t + elapsed * refillRate);

  if (refilled >= 1) {
    const newState: BucketState = { t: refilled - 1, r: now };
    await kv.put(key, JSON.stringify(newState), {
      expirationTtl: KV_TTL_SECONDS,
    });
    const remaining = Math.floor(newState.t);
    const tokensToFull = limits.limit - newState.t;
    const resetEpoch = Math.ceil(now + tokensToFull / refillRate);
    return {
      scope,
      limit: limits.limit,
      remaining,
      resetEpoch,
      retryAfterSec: 0,
      allowed: true,
    };
  }

  // Deny. Persist refilled state (refilledAt update only) so subsequent
  // requests see the same wall-clock origin.
  const denyState: BucketState = { t: refilled, r: now };
  try {
    await kv.put(key, JSON.stringify(denyState), {
      expirationTtl: KV_TTL_SECONDS,
    });
  } catch {
    // Non-fatal: the deny is still correct, we just won't update the touch.
  }
  const needed = 1 - refilled;
  const waitSec = needed / refillRate;
  const retryAfterSec = Math.max(1, Math.ceil(waitSec));
  const tokensToFull = limits.limit - refilled;
  const resetEpoch = Math.ceil(now + tokensToFull / refillRate);
  return {
    scope,
    limit: limits.limit,
    remaining: 0,
    resetEpoch,
    retryAfterSec,
    allowed: false,
  };
}

/** Synthetic full-bucket decision (failure-open: admit, no real counter). */
function fullBucketDecision(
  scope: "org" | "identity",
  limits: BucketLimits,
): BucketDecision {
  const now = Math.ceil(Date.now() / 1000);
  return {
    scope,
    limit: limits.limit,
    remaining: limits.limit,
    resetEpoch: now + limits.windowSec,
    retryAfterSec: 0,
    allowed: true,
  };
}

/**
 * Synchronous, in-isolate token bucket for safe-method (read) rate limiting
 * (PERF5 Stage A). Same refill math as `consumeToken`, but state lives in a
 * module-scoped Map instead of KV — no network I/O on the read hot path.
 *
 * Approximate by design: state is per-isolate, so the effective global limit
 * scales with the number of live isolates. Acceptable for reads (generous caps;
 * not the abuse vector writes are). Mutating methods keep the precise durable
 * KV limiter.
 */
function consumeTokenInMemory(
  key: string,
  limits: BucketLimits,
  scope: "org" | "identity",
): BucketDecision {
  const now = Date.now() / 1000;
  const existing = memBuckets.get(key);

  // Bound memory: when the map is full and this is a new key, drop all state.
  // A reset just refills everyone to capacity — harmless for an approximate
  // read limiter, and isolates are recycled frequently anyway.
  if (!existing && memBuckets.size >= MEM_BUCKET_CAP) {
    memBuckets.clear();
  }

  const step = tokenBucketStep(existing ?? null, limits.limit, limits.windowSec, now);
  memBuckets.set(key, step.next);
  return {
    scope,
    limit: limits.limit,
    remaining: step.remaining,
    resetEpoch: step.resetEpoch,
    retryAfterSec: step.retryAfterSec,
    allowed: step.allowed,
  };
}

/**
 * Consume one token from the per-(scope,key) Durable Object (PERF5 Stage B).
 * The bucket key maps to a single DO instance via `idFromName`; its
 * single-threaded execution makes the consume atomic. Throws on a non-OK DO
 * response so the caller can fail open.
 */
async function consumeViaDurableObject(
  ns: DurableObjectNamespace,
  key: string,
  limits: BucketLimits,
  scope: "org" | "identity",
): Promise<BucketDecision> {
  const stub = ns.get(ns.idFromName(key));
  const res = await stub.fetch("https://rate-limiter.internal/consume", {
    method: "POST",
    body: JSON.stringify({
      limit: limits.limit,
      windowSec: limits.windowSec,
      scope,
    }),
  });
  if (!res.ok) {
    throw new Error(`rate-limiter DO responded ${res.status}`);
  }
  const d = (await res.json()) as {
    limit: number;
    remaining: number;
    resetEpoch: number;
    retryAfterSec: number;
    allowed: boolean;
  };
  return {
    scope,
    limit: d.limit,
    remaining: d.remaining,
    resetEpoch: d.resetEpoch,
    retryAfterSec: d.retryAfterSec,
    allowed: d.allowed,
  };
}

/** Test-only: clear the in-isolate read buckets between cases. */
export function __resetRateLimitMemoryForTest(): void {
  memBuckets.clear();
}

function parseState(raw: string): BucketState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { t?: unknown }).t === "number" &&
      typeof (parsed as { r?: unknown }).r === "number"
    ) {
      return { t: (parsed as BucketState).t, r: (parsed as BucketState).r };
    }
  } catch {
    // fall through
  }
  return null;
}

function buildHeaders(decisions: BucketDecision[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const d of decisions) {
    headers[`X-RateLimit-Limit-${d.scope}`] = String(d.limit);
    headers[`X-RateLimit-Remaining-${d.scope}`] = String(d.remaining);
    headers[`X-RateLimit-Reset-${d.scope}`] = String(d.resetEpoch);
  }
  return headers;
}

function extractOrgId(pathname: string): string | null {
  const m = ORG_PATH_RE.exec(pathname);
  if (!m || !m[1]) return null;
  return m[1];
}

async function deriveIdentityKey(
  request: Request,
  routeFamily: RouteFamily,
): Promise<string> {
  const auth = request.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token.length > 0) {
      const hash = await sha256Hex(token);
      return `bearer:${hash.slice(0, 32)}`;
    }
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return `anon:${routeFamily}:${ip}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function logLimiterFailure(
  backend: "kv" | "durable_object",
  err: unknown,
  requestId: string,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "rate_limit.backend_failure",
      backend,
      requestId,
      error: message,
    }),
  );
}

// Test-only export: allows unit tests to introspect the configured limits
// without needing to mirror the table.
export const __rateLimitConfigForTest: Record<RouteFamily, FamilyConfig> = LIMITS;
