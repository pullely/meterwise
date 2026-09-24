// PERF5 Stage B — Durable Object rate-limiter tests.
//
// Asserts:
//   - the DO token bucket allows up to the limit then denies (atomic, in-memory)
//   - enforceRateLimit PREFERS the DO for unsafe methods and does NOT touch KV
//   - a DO failure fails open (admit), same contract as the KV path
//   - when no DO binding is present, the limiter falls back to the KV path
//   - safe (read) methods never call the DO (in-isolate path, Stage A)

import { RateLimiterDO } from "@api-edge/rate-limit-do";
import {
  enforceRateLimit,
  __rateLimitConfigForTest,
  __resetRateLimitMemoryForTest,
} from "@api-edge/rate-limit";
import type { Env } from "@api-edge/env";

// --- Fakes ---------------------------------------------------------------

interface FakeKv {
  binding: KVNamespace;
  store: Map<string, string>;
}
function createFakeKv(): FakeKv {
  const store = new Map<string, string>();
  const binding = {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
    delete: (k: string) => {
      store.delete(k);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  return { binding, store };
}

/** Routes idFromName→get→fetch to a per-key in-memory RateLimiterDO instance. */
function createFakeRateLimiterNamespace(opts?: { throwOnFetch?: boolean }): {
  ns: DurableObjectNamespace;
  fetchedKeys: string[];
} {
  const instances = new Map<string, RateLimiterDO>();
  const fetchedKeys: string[] = [];
  const ns = {
    idFromName(name: string) {
      return { __key: name } as unknown as DurableObjectId;
    },
    get(id: unknown) {
      const key = (id as { __key: string }).__key;
      return {
        async fetch(input: RequestInfo, init?: RequestInit) {
          fetchedKeys.push(key);
          if (opts?.throwOnFetch) throw new Error("DO unavailable");
          let inst = instances.get(key);
          if (!inst) {
            inst = new RateLimiterDO({} as DurableObjectState, {});
            instances.set(key, inst);
          }
          return inst.fetch(new Request(input as string, init));
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns, fetchedKeys };
}

function makeEnv(opts: { kv?: KVNamespace; ratelimiterDo?: DurableObjectNamespace }): Env {
  return {
    IDEMPOTENCY_KV: opts.kv,
    RATE_LIMITER_DO: opts.ratelimiterDo,
    ENVIRONMENT: "test",
  } as Env;
}

function postOrgReq(org = "org_b"): Request {
  return new Request(`https://api.example.com/v1/organizations/${org}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
    body: "{}",
  });
}

// --- DO unit ------------------------------------------------------------

describe("RateLimiterDO token bucket", () => {
  it("allows up to the limit, then denies — atomically in memory", async () => {
    const doInst = new RateLimiterDO({} as DurableObjectState, {});
    const limit = 5;
    const call = () =>
      doInst.fetch(
        new Request("https://rate-limiter.internal/consume", {
          method: "POST",
          body: JSON.stringify({ limit, windowSec: 60, scope: "org" }),
        }),
      );

    for (let i = 0; i < limit; i++) {
      const res = await call();
      const body = (await res.json()) as { allowed: boolean; remaining: number };
      expect(body.allowed).toBe(true);
      expect(body.remaining).toBe(limit - 1 - i);
    }
    const denied = (await (await call()).json()) as {
      allowed: boolean;
      retryAfterSec: number;
      scope: string;
    };
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(denied.scope).toBe("org");
  });

  it("rejects a malformed body with 400", async () => {
    const doInst = new RateLimiterDO({} as DurableObjectState, {});
    const res = await doInst.fetch(
      new Request("https://rate-limiter.internal/consume", { method: "POST", body: "not-json" }),
    );
    expect(res.status).toBe(400);
  });
});

// --- enforceRateLimit integration --------------------------------------

describe("enforceRateLimit with the Durable Object backend (Stage B)", () => {
  beforeEach(() => __resetRateLimitMemoryForTest());

  it("unsafe POST consumes via the DO and does NOT touch KV", async () => {
    const kv = createFakeKv();
    const { ns, fetchedKeys } = createFakeRateLimiterNamespace();
    const result = await enforceRateLimit(
      postOrgReq(),
      "req_do",
      makeEnv({ kv: kv.binding, ratelimiterDo: ns }),
      "project",
    );
    expect(result.kind).toBe("allowed");
    // Both buckets resolved through the DO...
    expect(fetchedKeys.length).toBe(2);
    expect(fetchedKeys.some((k) => k.includes(":org:"))).toBe(true);
    expect(fetchedKeys.some((k) => k.includes(":identity:"))).toBe(true);
    // ...and the KV store was never written (no rl:* keys).
    expect([...kv.store.keys()].filter((k) => k.startsWith("rl:v1:"))).toHaveLength(0);
  });

  it("emits both org and identity headers from the DO decisions", async () => {
    const { ns } = createFakeRateLimiterNamespace();
    const result = await enforceRateLimit(
      postOrgReq(),
      "req_h",
      makeEnv({ ratelimiterDo: ns }),
      "project",
    );
    if (result.kind !== "allowed") throw new Error("expected allowed");
    expect(result.headers["X-RateLimit-Limit-org"]).toBe(
      String(__rateLimitConfigForTest.project.org.limit),
    );
    expect(result.headers["X-RateLimit-Limit-identity"]).toBe(
      String(__rateLimitConfigForTest.project.identity.limit),
    );
  });

  it("overflows the org bucket via the DO → 429", async () => {
    const { ns } = createFakeRateLimiterNamespace();
    const env = makeEnv({ ratelimiterDo: ns });
    const orgLimit = __rateLimitConfigForTest.project.org.limit;
    const idLimit = __rateLimitConfigForTest.project.identity.limit;
    const identitiesNeeded = Math.ceil(orgLimit / idLimit) + 1;
    let denied: Awaited<ReturnType<typeof enforceRateLimit>> | null = null;
    for (let i = 0; i < identitiesNeeded && !denied; i++) {
      for (let j = 0; j < idLimit; j++) {
        const r = new Request("https://api.example.com/v1/organizations/org_OF/projects", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer tok_${i}` },
          body: "{}",
        });
        const res = await enforceRateLimit(r, `r_${i}_${j}`, env, "project");
        if (res.kind === "denied") {
          denied = res;
          break;
        }
      }
    }
    expect(denied?.kind).toBe("denied");
    if (denied?.kind === "denied") {
      const body = (await denied.response.json()) as { error: { details: { scope: string } } };
      expect(body.error.details.scope).toBe("org");
    }
  });

  it("a DO failure fails open (admit), like the KV path", async () => {
    const { ns } = createFakeRateLimiterNamespace({ throwOnFetch: true });
    const original = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    const result = await enforceRateLimit(
      postOrgReq(),
      "req_fail",
      makeEnv({ ratelimiterDo: ns }),
      "project",
    );
    console.warn = original;
    expect(result.kind).toBe("allowed");
    expect(warned).toBe(true);
  });

  it("falls back to the KV path when no DO binding is present", async () => {
    const kv = createFakeKv();
    const result = await enforceRateLimit(
      postOrgReq(),
      "req_fallback",
      makeEnv({ kv: kv.binding }),
      "project",
    );
    expect(result.kind).toBe("allowed");
    // KV path persisted both rl:* buckets.
    expect([...kv.store.keys()].filter((k) => k.startsWith("rl:v1:"))).toHaveLength(2);
  });

  it("safe (read) GET never calls the DO and never touches KV", async () => {
    const kv = createFakeKv();
    const { ns, fetchedKeys } = createFakeRateLimiterNamespace();
    const req = new Request("https://api.example.com/v1/organizations/org_r/projects", {
      method: "GET",
      headers: { authorization: "Bearer tok_read" },
    });
    const result = await enforceRateLimit(
      req,
      "req_read",
      makeEnv({ kv: kv.binding, ratelimiterDo: ns }),
      "project",
    );
    expect(result.kind).toBe("allowed");
    expect(fetchedKeys).toHaveLength(0);
    expect(kv.store.size).toBe(0);
  });
});
