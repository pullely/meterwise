// Edge-side rate-limit tests (Task 0097).
//
// Asserts:
//   - under-limit allows the request and emits X-RateLimit-* headers
//   - identity bucket overflow returns 429 with envelope and Retry-After
//   - org bucket overflow returns 429 with envelope and Retry-After
//   - anon traffic limited by IP (CF-Connecting-IP)
//   - separate IPs do NOT share the same bucket
//   - missing IDEMPOTENCY_KV binding → fail open (admit, no headers)
//   - KV get failure → fail open
//   - KV put failure → fail open
//   - refill correctness across simulated time
//   - key isolation across orgs / identities / route families
//   - rate-limit fires BEFORE replayOrExecute KV touch (denied request never
//     reaches the idempotency cache)

import { handleAuthRoute } from "@api-edge/auth-facade";
import {
  enforceRateLimit,
  __rateLimitConfigForTest,
  __resetRateLimitMemoryForTest,
  type RouteFamily,
} from "@api-edge/rate-limit";
import type { Env } from "@api-edge/env";

interface FakeKv {
  binding: KVNamespace;
  store: Map<string, string>;
  getThrows: { value: boolean };
  putThrows: { value: boolean };
}

function createFakeKv(): FakeKv {
  const store = new Map<string, string>();
  const getThrows = { value: false };
  const putThrows = { value: false };
  const binding = {
    get(key: string): Promise<string | null> {
      if (getThrows.value) return Promise.reject(new Error("kv get fail"));
      return Promise.resolve(store.get(key) ?? null);
    },
    put(key: string, value: string): Promise<void> {
      if (putThrows.value) return Promise.reject(new Error("kv put fail"));
      store.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
    list(): Promise<{ keys: { name: string }[]; list_complete: true; cacheStatus: null }> {
      return Promise.resolve({ keys: [], list_complete: true, cacheStatus: null });
    },
  } as unknown as KVNamespace;
  return { binding, store, getThrows, putThrows };
}

function makeEnv(kv?: KVNamespace): Env {
  return {
    IDEMPOTENCY_KV: kv,
    ENVIRONMENT: "test",
  } as Env;
}

function makeRequest(opts: {
  url?: string;
  method?: string;
  ip?: string;
  bearer?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  const method = opts.method ?? "POST";
  const url = opts.url ?? "https://api.example.com/v1/auth/login/start";
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    return new Request(url, { method, headers, body: "{}" });
  }
  return new Request(url, { method, headers });
}

describe("api-edge rate limiter (Task 0097)", () => {
  describe("config sanity", () => {
    it("auth family is the tightest identity bucket", () => {
      expect(__rateLimitConfigForTest.auth.identity.limit).toBeLessThan(
        __rateLimitConfigForTest.org.identity.limit,
      );
    });

    it("every family has both org and identity limits > 0", () => {
      const families: RouteFamily[] = [
        "auth",
        "org",
        "project",
        "config",
        "webhooks",
        "metering",
        "billing",
        "audit",
      ];
      for (const f of families) {
        expect(__rateLimitConfigForTest[f].org.limit).toBeGreaterThan(0);
        expect(__rateLimitConfigForTest[f].identity.limit).toBeGreaterThan(0);
      }
    });
  });

  describe("under-limit allows + emits headers", () => {
    it("allowed result carries X-RateLimit-Limit/Remaining/Reset for active scopes", async () => {
      const kv = createFakeKv();
      const result = await enforceRateLimit(
        makeRequest({ ip: "1.2.3.4" }),
        "req_a",
        makeEnv(kv.binding),
        "auth",
      );
      expect(result.kind).toBe("allowed");
      if (result.kind !== "allowed") return;
      expect(result.headers["X-RateLimit-Limit-identity"]).toBe(
        String(__rateLimitConfigForTest.auth.identity.limit),
      );
      // remaining is limit-1 since one token was consumed
      expect(Number(result.headers["X-RateLimit-Remaining-identity"])).toBe(
        __rateLimitConfigForTest.auth.identity.limit - 1,
      );
      expect(Number(result.headers["X-RateLimit-Reset-identity"])).toBeGreaterThan(0);
      // No org segment in URL → no org headers.
      expect(result.headers["X-RateLimit-Limit-org"]).toBeUndefined();
    });

    it("org-scoped path emits both org and identity headers", async () => {
      const kv = createFakeKv();
      const result = await enforceRateLimit(
        makeRequest({
          url: "https://api.example.com/v1/organizations/org_abc/projects",
          bearer: "tok_x",
        }),
        "req_a",
        makeEnv(kv.binding),
        "project",
      );
      expect(result.kind).toBe("allowed");
      if (result.kind !== "allowed") return;
      expect(result.headers["X-RateLimit-Limit-org"]).toBeDefined();
      expect(result.headers["X-RateLimit-Limit-identity"]).toBeDefined();
    });
  });

  describe("identity overflow", () => {
    it("returns 429 with rate_limited envelope and Retry-After once limit hit", async () => {
      const kv = createFakeKv();
      const env = makeEnv(kv.binding);
      const limit = __rateLimitConfigForTest.auth.identity.limit;

      // Exhaust the bucket.
      for (let i = 0; i < limit; i++) {
        const r = await enforceRateLimit(
          makeRequest({ ip: "9.9.9.9" }),
          `req_${i}`,
          env,
          "auth",
        );
        expect(r.kind).toBe("allowed");
      }

      // (limit+1)th request → denied.
      const denied = await enforceRateLimit(
        makeRequest({ ip: "9.9.9.9" }),
        "req_overflow",
        env,
        "auth",
      );
      expect(denied.kind).toBe("denied");
      if (denied.kind !== "denied") return;
      expect(denied.response.status).toBe(429);
      const retryAfter = denied.response.headers.get("Retry-After");
      expect(retryAfter).not.toBeNull();
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      expect(denied.response.headers.get("X-RateLimit-Remaining-identity")).toBe("0");

      const body = (await denied.response.json()) as {
        error: { code: string; details: { scope: string; retryAfterSeconds: number } };
      };
      expect(body.error.code).toBe("rate_limited");
      expect(body.error.details.scope).toBe("identity");
      expect(body.error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });
  });

  describe("org overflow", () => {
    it("two different identities under the same org hit the org bucket", async () => {
      const kv = createFakeKv();
      const env = makeEnv(kv.binding);
      // Use the audit family — its identity cap (120) is well above the
      // org cap we'll trigger if we keep alternating identities. Actually
      // we want the OPPOSITE: identity cap high, org cap low. Use a
      // synthetic family with mismatched caps via the project family —
      // identity 60, org 300. We'd need to drive 300 reqs to exceed org.
      // Instead drive via a single identity past org cap by interleaving
      // identities so per-identity stays under 60.
      const orgLimit = __rateLimitConfigForTest.project.org.limit;
      // We'll alternate across many identities so identity bucket never
      // overflows. Each identity does at most `identityLimit`.
      const idLimit = __rateLimitConfigForTest.project.identity.limit;
      const identitiesNeeded = Math.ceil(orgLimit / idLimit) + 1;
      let consumed = 0;
      let overflow: Awaited<ReturnType<typeof enforceRateLimit>> | null = null;
      for (let i = 0; i < identitiesNeeded && !overflow; i++) {
        for (let j = 0; j < idLimit; j++) {
          const r = await enforceRateLimit(
            makeRequest({
              url: "https://api.example.com/v1/organizations/org_X/projects",
              bearer: `tok_user_${i}`,
            }),
            `req_${i}_${j}`,
            env,
            "project",
          );
          consumed++;
          if (r.kind === "denied") {
            overflow = r;
            break;
          }
        }
      }
      expect(overflow).not.toBeNull();
      if (!overflow || overflow.kind !== "denied") return;
      const body = (await overflow.response.json()) as {
        error: { details: { scope: string } };
      };
      expect(body.error.details.scope).toBe("org");
      expect(consumed).toBeGreaterThan(orgLimit);
    });
  });

  describe("anon traffic limited by IP", () => {
    it("same IP exhausts anon bucket", async () => {
      const kv = createFakeKv();
      const env = makeEnv(kv.binding);
      const limit = __rateLimitConfigForTest.auth.identity.limit;
      for (let i = 0; i < limit; i++) {
        const r = await enforceRateLimit(
          makeRequest({ ip: "5.5.5.5" }),
          `req_${i}`,
          env,
          "auth",
        );
        expect(r.kind).toBe("allowed");
      }
      const denied = await enforceRateLimit(
        makeRequest({ ip: "5.5.5.5" }),
        "req_overflow",
        env,
        "auth",
      );
      expect(denied.kind).toBe("denied");
    });

    it("different IPs do NOT share the same bucket", async () => {
      const kv = createFakeKv();
      const env = makeEnv(kv.binding);
      const limit = __rateLimitConfigForTest.auth.identity.limit;
      for (let i = 0; i < limit; i++) {
        await enforceRateLimit(makeRequest({ ip: "1.1.1.1" }), `r${i}`, env, "auth");
      }
      const otherIp = await enforceRateLimit(
        makeRequest({ ip: "2.2.2.2" }),
        "r_other",
        env,
        "auth",
      );
      expect(otherIp.kind).toBe("allowed");
    });
  });

  describe("fail open", () => {
    it("missing IDEMPOTENCY_KV → admits the request with no rate-limit headers", async () => {
      const result = await enforceRateLimit(
        makeRequest({ ip: "1.2.3.4" }),
        "req",
        makeEnv(undefined),
        "auth",
      );
      expect(result.kind).toBe("allowed");
      if (result.kind !== "allowed") return;
      expect(Object.keys(result.headers)).toHaveLength(0);
    });

    it("KV get failure → admits the request", async () => {
      const kv = createFakeKv();
      kv.getThrows.value = true;
      const original = console.warn;
      let warned = false;
      console.warn = () => { warned = true; };
      const result = await enforceRateLimit(
        makeRequest({ ip: "1.2.3.4" }),
        "req",
        makeEnv(kv.binding),
        "auth",
      );
      console.warn = original;
      expect(result.kind).toBe("allowed");
      expect(warned).toBe(true);
    });

    it("KV put failure → admits the request", async () => {
      const kv = createFakeKv();
      kv.putThrows.value = true;
      const original = console.warn;
      let warned = false;
      console.warn = () => { warned = true; };
      const result = await enforceRateLimit(
        makeRequest({ ip: "1.2.3.4" }),
        "req",
        makeEnv(kv.binding),
        "auth",
      );
      console.warn = original;
      expect(result.kind).toBe("allowed");
      expect(warned).toBe(true);
    });
  });

  describe("refill correctness across simulated time", () => {
    it("after window elapses, bucket refills to capacity", async () => {
      const kv = createFakeKv();
      const env = makeEnv(kv.binding);
      const limit = __rateLimitConfigForTest.auth.identity.limit;
      const window = __rateLimitConfigForTest.auth.identity.windowSec;

      // Exhaust.
      for (let i = 0; i < limit; i++) {
        await enforceRateLimit(makeRequest({ ip: "7.7.7.7" }), `r${i}`, env, "auth");
      }
      // Mutate stored refilledAt to far past so the next call sees full refill.
      const key = [...kv.store.keys()].find((k) => k.includes("identity"));
      expect(key).toBeDefined();
      const parsed = JSON.parse(kv.store.get(key!)!) as { t: number; r: number };
      parsed.r = parsed.r - window - 1;
      kv.store.set(key!, JSON.stringify(parsed));

      const after = await enforceRateLimit(
        makeRequest({ ip: "7.7.7.7" }),
        "r_after",
        env,
        "auth",
      );
      expect(after.kind).toBe("allowed");
    });
  });

  describe("key isolation", () => {
    it("different orgs do NOT share the same org bucket", async () => {
      const kv = createFakeKv();
      const env = makeEnv(kv.binding);
      const orgLimit = __rateLimitConfigForTest.project.org.limit;
      // Exhaust orgA (using many identities so identity cap doesn't fire).
      const idLimit = __rateLimitConfigForTest.project.identity.limit;
      const identitiesNeeded = Math.ceil(orgLimit / idLimit) + 1;
      let exhausted = false;
      for (let i = 0; i < identitiesNeeded && !exhausted; i++) {
        for (let j = 0; j < idLimit; j++) {
          const r = await enforceRateLimit(
            makeRequest({
              url: "https://api.example.com/v1/organizations/org_A/projects",
              bearer: `tA_${i}`,
            }),
            `r_${i}_${j}`,
            env,
            "project",
          );
          if (r.kind === "denied") {
            exhausted = true;
            break;
          }
        }
      }
      expect(exhausted).toBe(true);

      // org_B is unaffected.
      const otherOrg = await enforceRateLimit(
        makeRequest({
          url: "https://api.example.com/v1/organizations/org_B/projects",
          bearer: "tB",
        }),
        "r_other_org",
        env,
        "project",
      );
      expect(otherOrg.kind).toBe("allowed");
    });

    it("different route families do NOT share the same identity bucket", async () => {
      const kv = createFakeKv();
      const env = makeEnv(kv.binding);
      const limit = __rateLimitConfigForTest.auth.identity.limit;

      for (let i = 0; i < limit; i++) {
        await enforceRateLimit(
          makeRequest({ ip: "8.8.8.8" }),
          `r${i}`,
          env,
          "auth",
        );
      }
      const otherFamily = await enforceRateLimit(
        makeRequest({ ip: "8.8.8.8" }),
        "r_billing",
        env,
        "billing",
      );
      expect(otherFamily.kind).toBe("allowed");
    });
  });

  describe("safe (read) methods use the in-isolate limiter (PERF5 Stage A)", () => {
    beforeEach(() => {
      __resetRateLimitMemoryForTest();
    });

    it("a GET does NOT touch KV but is still allowed and emits headers", async () => {
      const kv = createFakeKv();
      const result = await enforceRateLimit(
        makeRequest({
          url: "https://api.example.com/v1/organizations/org_read/projects",
          method: "GET",
          bearer: "tok_read",
        }),
        "req_get",
        makeEnv(kv.binding),
        "project",
      );
      expect(result.kind).toBe("allowed");
      if (result.kind !== "allowed") return;
      // No rl:* (or any) key was written to KV — the read path is I/O-free.
      expect(kv.store.size).toBe(0);
      // Both scopes still reported.
      expect(result.headers["X-RateLimit-Limit-org"]).toBeDefined();
      expect(result.headers["X-RateLimit-Limit-identity"]).toBeDefined();
    });

    it("reads are limited WITHOUT a KV binding (in-memory needs no backend)", async () => {
      const result = await enforceRateLimit(
        makeRequest({ url: "https://api.example.com/v1/auth/session", method: "GET", ip: "3.3.3.3" }),
        "req_get_nokv",
        makeEnv(undefined),
        "auth",
      );
      expect(result.kind).toBe("allowed");
      if (result.kind !== "allowed") return;
      // Unlike the unsafe-method no-KV path (admit, no headers), reads still get
      // real headers from the in-isolate bucket.
      expect(result.headers["X-RateLimit-Limit-identity"]).toBe(
        String(__rateLimitConfigForTest.auth.identity.limit),
      );
    });

    it("a GET flood overflows the in-isolate identity bucket → 429", async () => {
      const env = makeEnv(createFakeKv().binding);
      const limit = __rateLimitConfigForTest.auth.identity.limit;
      for (let i = 0; i < limit; i++) {
        const r = await enforceRateLimit(
          makeRequest({ url: "https://api.example.com/v1/auth/session", method: "GET", ip: "4.4.4.4" }),
          `r${i}`,
          env,
          "auth",
        );
        expect(r.kind).toBe("allowed");
      }
      const denied = await enforceRateLimit(
        makeRequest({ url: "https://api.example.com/v1/auth/session", method: "GET", ip: "4.4.4.4" }),
        "r_overflow",
        env,
        "auth",
      );
      expect(denied.kind).toBe("denied");
      if (denied.kind !== "denied") return;
      expect(denied.response.status).toBe(429);
      // Still no KV writes for the read path even at overflow.
      // (env's KV store was created fresh and never used by the read path.)
    });

    it("different IPs do NOT share the in-isolate read bucket", async () => {
      const env = makeEnv(undefined);
      const limit = __rateLimitConfigForTest.auth.identity.limit;
      for (let i = 0; i < limit; i++) {
        await enforceRateLimit(
          makeRequest({ url: "https://api.example.com/v1/auth/session", method: "GET", ip: "4.4.4.4" }),
          `r${i}`,
          env,
          "auth",
        );
      }
      const other = await enforceRateLimit(
        makeRequest({ url: "https://api.example.com/v1/auth/session", method: "GET", ip: "5.6.7.8" }),
        "r_other",
        env,
        "auth",
      );
      expect(other.kind).toBe("allowed");
    });
  });

  describe("unsafe methods still use the durable KV limiter", () => {
    it("a POST writes rl:* bucket state to KV", async () => {
      const kv = createFakeKv();
      const result = await enforceRateLimit(
        makeRequest({
          url: "https://api.example.com/v1/organizations/org_w/projects",
          method: "POST",
          bearer: "tok_w",
        }),
        "req_post",
        makeEnv(kv.binding),
        "project",
      );
      expect(result.kind).toBe("allowed");
      const rlKeys = [...kv.store.keys()].filter((k) => k.startsWith("rl:v1:"));
      // org + identity buckets both persisted.
      expect(rlKeys.length).toBe(2);
    });
  });

  describe("integration via handleAuthRoute (replayOrExecute chokepoint)", () => {
    it("under-limit POST: response carries rate-limit headers", async () => {
      const kv = createFakeKv();
      const fetcher = {
        fetch(): Promise<Response> {
          return Promise.resolve(
            Response.json({
              data: { ok: true },
              meta: { requestId: "req_inner", cursor: null },
            }),
          );
        },
        connect() {
          throw new Error("not used");
        },
      } as unknown as Fetcher;
      const env = {
        IDENTITY_WORKER: fetcher,
        IDEMPOTENCY_KV: kv.binding,
        ENVIRONMENT: "test",
      } as Env;
      const req = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "10.10.10.10",
        },
        body: '{"email":"u@test.com"}',
      });

      const response = await handleAuthRoute(req, env, "req_test", "/v1/auth/login/start");
      expect(response.status).toBe(200);
      expect(response.headers.get("X-RateLimit-Limit-identity")).toBe(
        String(__rateLimitConfigForTest.auth.identity.limit),
      );
    });

    it("denied request short-circuits before idempotency KV is touched", async () => {
      const kv = createFakeKv();
      const env = makeEnv(kv.binding);
      const limit = __rateLimitConfigForTest.auth.identity.limit;
      // Drain bucket via direct calls.
      for (let i = 0; i < limit; i++) {
        await enforceRateLimit(
          makeRequest({ ip: "11.11.11.11" }),
          `r${i}`,
          env,
          "auth",
        );
      }
      // The rl bucket has its own put calls; clear store of `idem:` keys.
      const fetcher = {
        fetch(): Promise<Response> {
          return Promise.resolve(Response.json({ data: { ok: true } }));
        },
        connect() {
          throw new Error("not used");
        },
      } as unknown as Fetcher;
      const idemKeysBefore = [...kv.store.keys()].filter((k) =>
        k.startsWith("idem:"),
      );
      expect(idemKeysBefore).toHaveLength(0);

      const VALID_KEY = "550e8400-e29b-41d4-a716-446655440000";
      const req = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "11.11.11.11",
          "idempotency-key": VALID_KEY,
        },
        body: '{"email":"u@test.com"}',
      });
      const fullEnv = {
        IDENTITY_WORKER: fetcher,
        IDEMPOTENCY_KV: kv.binding,
        ENVIRONMENT: "test",
      } as Env;
      const response = await handleAuthRoute(req, fullEnv, "req_test", "/v1/auth/login/start");
      expect(response.status).toBe(429);
      // No idem:* key was ever written by replayOrExecute.
      const idemKeysAfter = [...kv.store.keys()].filter((k) =>
        k.startsWith("idem:"),
      );
      expect(idemKeysAfter).toHaveLength(0);
    });
  });
});
