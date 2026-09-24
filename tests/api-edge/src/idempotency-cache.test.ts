// Idempotency replay L1 (colo-local Cache API in front of the KV store).
//
// Asserts the tiered design: KV stays the global source of truth, while a
// same-colo replay is served from the Cache API without a KV `get`; and when
// there is no L1 (cross-colo / eviction), the lookup falls back to KV so
// idempotency correctness is preserved.

import { replayOrExecute } from "@api-edge/idempotency";
import { __resetRateLimitMemoryForTest } from "@api-edge/rate-limit";
import type { Env } from "@api-edge/env";

function makeFakeCaches() {
  const store = new Map<string, Response>();
  const def = {
    async match(key: string): Promise<Response | undefined> {
      const r = store.get(key);
      return r ? r.clone() : undefined;
    },
    async put(key: string, res: Response): Promise<void> {
      store.set(key, res.clone());
    },
  };
  return { caches: { default: def }, store };
}

// Counts only idempotency (`idem:`-prefixed) KV ops, so the rate limiter's own
// KV fallback (same binding, `rl:` prefix) does not pollute the assertions.
function countingKv() {
  const store = new Map<string, string>();
  const counts = { idemGet: 0, idemPut: 0 };
  const binding = {
    get: (k: string) => {
      if (k.startsWith("idem:")) counts.idemGet++;
      return Promise.resolve(store.get(k) ?? null);
    },
    put: (k: string, v: string) => {
      if (k.startsWith("idem:")) counts.idemPut++;
      store.set(k, v);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  return { binding, store, counts };
}

const KEY = "550e8400-e29b-41d4-a716-446655440000";
function postReq(): Request {
  return new Request("https://api.example.com/v1/organizations/org_idem/projects", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": KEY },
    body: "{}",
  });
}

describe("idempotency Cache API L1 (tiered in front of KV)", () => {
  let originalCaches: unknown;
  beforeEach(() => {
    __resetRateLimitMemoryForTest();
    originalCaches = (globalThis as unknown as { caches?: unknown }).caches;
  });
  afterEach(() => {
    (globalThis as unknown as { caches?: unknown }).caches = originalCaches;
  });

  it("serves a same-colo replay from L1 without a KV get, and survives KV loss", async () => {
    const { caches } = makeFakeCaches();
    (globalThis as unknown as { caches: unknown }).caches = caches;
    const kv = countingKv();
    const env = { IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" } as Env;

    let downstreamCalls = 0;
    const downstream = () => {
      downstreamCalls++;
      return Promise.resolve(Response.json({ n: downstreamCalls }, { status: 201 }));
    };

    // 1st request: miss L1 + KV → execute downstream → store to KV + L1.
    const r1 = await replayOrExecute(postReq(), "r1", env, "project", downstream);
    expect(r1.status).toBe(201);
    expect(downstreamCalls).toBe(1);
    expect(kv.counts.idemPut).toBe(1);
    const idemGetsAfter1 = kv.counts.idemGet;

    // 2nd request (same key): L1 hit → replay, no downstream, no extra KV get.
    const r2 = await replayOrExecute(postReq(), "r2", env, "project", downstream);
    expect(downstreamCalls).toBe(1);
    expect(r2.headers.get("x-saas-replay-source")).toBe("edge-idempotency");
    expect(kv.counts.idemGet).toBe(idemGetsAfter1); // KV not touched on the L1 hit

    // 3rd: wipe KV but keep L1 → still replays (proves L1 served it).
    kv.store.clear();
    const r3 = await replayOrExecute(postReq(), "r3", env, "project", downstream);
    expect(downstreamCalls).toBe(1);
    expect(r3.headers.get("x-saas-replay-source")).toBe("edge-idempotency");
  });

  it("falls back to KV (global) when there is no L1 — cross-colo correctness", async () => {
    (globalThis as unknown as { caches?: unknown }).caches = undefined; // no Cache API
    const kv = countingKv();
    const env = { IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" } as Env;

    let calls = 0;
    const downstream = () => {
      calls++;
      return Promise.resolve(Response.json({ n: calls }, { status: 201 }));
    };

    await replayOrExecute(postReq(), "r1", env, "project", downstream);
    const r2 = await replayOrExecute(postReq(), "r2", env, "project", downstream);
    expect(calls).toBe(1); // replayed from KV even with no L1 layer
    expect(r2.headers.get("x-saas-replay-source")).toBe("edge-idempotency");
    expect(kv.counts.idemPut).toBe(1);
  });
});
