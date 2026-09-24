// Rate-limiter Durable Object (PERF5 Stage B).
//
// One DO instance per (scope,key) rate-limit bucket — the edge addresses it via
// `idFromName(bucketKey)`. The Workers runtime serializes all requests to a
// single DO instance, so the token-bucket read-modify-write here is ATOMIC.
// That is the whole point of Stage B: the KV limiter it replaces did a
// non-atomic get-then-put and documented "last-writer-wins under concurrent
// retry", i.e. it was both slow (a central KV write per request) and inaccurate
// under the exact burst load it exists to bound. The DO is correct and needs no
// KV write on the hot path.
//
// State is held in memory. A DO that hibernates or is evicted loses its bucket
// and the next request starts from a full bucket — for a token bucket that just
// means it refilled, which is acceptable (and a hot bucket under active load
// stays resident for the duration of the burst that matters). We therefore keep
// NO durable storage, which also keeps the consume path I/O-free.

import { tokenBucketStep, type BucketState } from "./rate-limit.js";

interface ConsumeRequest {
  limit: number;
  windowSec: number;
  scope: "org" | "identity";
}

function isConsumeRequest(value: unknown): value is ConsumeRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ConsumeRequest).limit === "number" &&
    typeof (value as ConsumeRequest).windowSec === "number" &&
    ((value as ConsumeRequest).scope === "org" ||
      (value as ConsumeRequest).scope === "identity")
  );
}

export class RateLimiterDO {
  /** In-memory token bucket for this single (scope,key). See the file header. */
  private bucket: BucketState | null = null;

  // Workers constructs a DO with (state, env). We keep neither — the bucket is
  // in-memory and the limits arrive on each request — but the signature is part
  // of the Durable Object contract.
  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("invalid body", { status: 400 });
    }
    if (!isConsumeRequest(body)) {
      return new Response("invalid body", { status: 400 });
    }

    const now = Date.now() / 1000;
    const step = tokenBucketStep(this.bucket, body.limit, body.windowSec, now);
    this.bucket = step.next;

    return Response.json({
      scope: body.scope,
      limit: body.limit,
      remaining: step.remaining,
      resetEpoch: step.resetEpoch,
      retryAfterSec: step.retryAfterSec,
      allowed: step.allowed,
    });
  }
}
