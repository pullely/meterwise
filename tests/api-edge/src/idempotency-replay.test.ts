// Edge-side idempotency replay store tests (Task 0095).
//
// Asserts the durable KV-backed replay behaviour added in
// `apps/api-edge/src/idempotency.ts::replayOrExecute`:
//   - cache miss on POST → downstream invoked, response cached
//   - cache hit on POST  → downstream NOT invoked, cached envelope replayed
//   - GET request → never cached, never validated, always passthrough
//   - absent Idempotency-Key on POST → not cached (header is optional)
//   - missing IDEMPOTENCY_KV binding → degrades open (downstream only)
//   - non-text response body → base64-encoded round trip
//   - replay marks response with x-saas-replay-source header
//   - 5xx responses are NOT cached (transient errors)
//   - TTL of 86400 seconds (24h) is set on KV.put
//
// Tests drive the full facade pipeline (handleAuthRoute) so the integration
// is verified end-to-end, not just the helper in isolation.

import { handleAuthRoute } from "@api-edge/auth-facade";
import { replayOrExecute } from "@api-edge/idempotency";

interface KvPutCall {
  key: string;
  value: string;
  options: { expirationTtl?: number } | undefined;
}

interface FakeKv {
  binding: KVNamespace;
  store: Map<string, string>;
  putCalls: KvPutCall[];
  getCalls: string[];
}

function createFakeKv(seed: Record<string, string> = {}): FakeKv {
  const store = new Map<string, string>(Object.entries(seed));
  const putCalls: KvPutCall[] = [];
  const getCalls: string[] = [];
  const binding = {
    get(key: string, _type?: string): Promise<string | null> {
      getCalls.push(key);
      return Promise.resolve(store.get(key) ?? null);
    },
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      putCalls.push({ key, value, options });
      store.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
    list(): Promise<{ keys: { name: string }[]; list_complete: true; cacheStatus: null }> {
      return Promise.resolve({
        keys: Array.from(store.keys()).map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      });
    },
  } as unknown as KVNamespace;
  return { binding, store, putCalls, getCalls };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  responseFactory: () => Response = () =>
    Response.json({
      data: { ok: true },
      meta: { requestId: "req_inner", cursor: null },
    }),
): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(responseFactory());
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

const VALID_KEY_A = "550e8400-e29b-41d4-a716-446655440000";
const VALID_KEY_B = "11111111-2222-3333-4444-555555555555";

function makePost(key?: string, body: string = '{"email":"u@test.com"}'): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["idempotency-key"] = key;
  return new Request("https://api.example.com/v1/auth/login/start", {
    method: "POST",
    headers,
    body,
  });
}

describe("api-edge idempotency replay store (Task 0095)", () => {
  describe("integration via handleAuthRoute", () => {
    it("cache miss → downstream called, response stored with TTL=86400", async () => {
      const kv = createFakeKv();
      const { fetcher, calls } = createFakeFetcher();

      const response = await handleAuthRoute(
        makePost(VALID_KEY_A),
        { IDENTITY_WORKER: fetcher, IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      const idemPuts = kv.putCalls.filter(c => c.key.startsWith("idem:"));
      expect(idemPuts).toHaveLength(1);
      expect(idemPuts[0]!.options?.expirationTtl).toBe(86400);
      expect([...kv.store.keys()].filter(k => k.startsWith("idem:")).length).toBe(1);
    });

    it("cache hit → downstream NOT called, replayed envelope returned with x-saas-replay-source", async () => {
      const kv = createFakeKv();
      const { fetcher, calls } = createFakeFetcher();
      const env = { IDENTITY_WORKER: fetcher, IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" };

      // First request populates cache.
      const first = await handleAuthRoute(makePost(VALID_KEY_A), env, "req_a", "/v1/auth/login/start");
      expect(first.status).toBe(200);
      expect(calls).toHaveLength(1);

      // Second request with SAME key → replay.
      const second = await handleAuthRoute(makePost(VALID_KEY_A), env, "req_b", "/v1/auth/login/start");
      expect(second.status).toBe(200);
      expect(calls).toHaveLength(1); // downstream NOT called again
      expect(second.headers.get("x-saas-replay-source")).toBe("edge-idempotency");
    });

    it("different idempotency keys → cache miss for each, downstream called for both", async () => {
      const kv = createFakeKv();
      const { fetcher, calls } = createFakeFetcher();
      const env = { IDENTITY_WORKER: fetcher, IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" };

      await handleAuthRoute(makePost(VALID_KEY_A), env, "req_a", "/v1/auth/login/start");
      await handleAuthRoute(makePost(VALID_KEY_B), env, "req_b", "/v1/auth/login/start");

      expect(calls).toHaveLength(2);
      expect([...kv.store.keys()].filter(k => k.startsWith("idem:")).length).toBe(2);
    });

    it("absent Idempotency-Key on POST → passthrough, NOT cached", async () => {
      const kv = createFakeKv();
      const { fetcher, calls } = createFakeFetcher();

      const response = await handleAuthRoute(
        makePost(),
        { IDENTITY_WORKER: fetcher, IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(kv.putCalls.filter(c => c.key.startsWith("idem:"))).toHaveLength(0);
      expect(kv.getCalls.filter(k => k.startsWith("idem:"))).toHaveLength(0);
    });

    it("IDEMPOTENCY_KV unbound → degrades open, downstream still called", async () => {
      const { fetcher, calls } = createFakeFetcher();

      const response = await handleAuthRoute(
        makePost(VALID_KEY_A),
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
    });

    it("5xx response is NOT cached (transient errors should be retryable)", async () => {
      const kv = createFakeKv();
      const { fetcher } = createFakeFetcher(() =>
        Response.json(
          { error: { code: "internal_error", message: "boom" }, meta: { requestId: "req_inner", cursor: null } },
          { status: 503 },
        ),
      );

      await handleAuthRoute(
        makePost(VALID_KEY_A),
        { IDENTITY_WORKER: fetcher, IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/login/start",
      );

      expect(kv.putCalls.filter(c => c.key.startsWith("idem:"))).toHaveLength(0);
    });

    it("4xx response IS cached (stable client errors replay deterministically)", async () => {
      const kv = createFakeKv();
      const { fetcher } = createFakeFetcher(() =>
        Response.json(
          { error: { code: "validation_failed", message: "bad email" }, meta: { requestId: "req_inner", cursor: null } },
          { status: 400 },
        ),
      );

      await handleAuthRoute(
        makePost(VALID_KEY_A),
        { IDENTITY_WORKER: fetcher, IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/login/start",
      );

      expect(kv.putCalls.filter(c => c.key.startsWith("idem:"))).toHaveLength(1);
    });
  });

  describe("replayOrExecute (helper, isolated)", () => {
    function makeEnv(kvBinding: KVNamespace | undefined) {
      return { IDEMPOTENCY_KV: kvBinding, ENVIRONMENT: "test" } as unknown as Parameters<typeof replayOrExecute>[2];
    }

    it("GET request → downstream invoked once, never touches KV", async () => {
      const kv = createFakeKv();
      let downstreamCalls = 0;
      const get = new Request("https://api.example.com/v1/auth/session", { method: "GET" });

      const response = await replayOrExecute(get, "req_test", makeEnv(kv.binding), "auth", () => {
        downstreamCalls += 1;
        return Promise.resolve(new Response("ok", { status: 200 }));
      });

      expect(response.status).toBe(200);
      expect(downstreamCalls).toBe(1);
      expect(kv.getCalls.filter(k => k.startsWith("idem:"))).toHaveLength(0);
      expect(kv.putCalls.filter(c => c.key.startsWith("idem:"))).toHaveLength(0);
    });

    it("malformed Idempotency-Key on POST → 400 validation_failed, downstream NOT called", async () => {
      const kv = createFakeKv();
      let downstreamCalls = 0;
      const req = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "idempotency-key": "a".repeat(256) },
        body: "{}",
      });

      const response = await replayOrExecute(req, "req_test", makeEnv(kv.binding), "auth", () => {
        downstreamCalls += 1;
        return Promise.resolve(new Response("ok"));
      });

      expect(response.status).toBe(400);
      expect(downstreamCalls).toBe(0);
      expect(kv.getCalls.filter(k => k.startsWith("idem:"))).toHaveLength(0);
    });

    it("KV get failure → degrades to cache-miss, downstream still called once", async () => {
      const failing = {
        get(): Promise<string | null> {
          return Promise.reject(new Error("kv unavailable"));
        },
        put(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as KVNamespace;
      let downstreamCalls = 0;
      const req = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "idempotency-key": VALID_KEY_A },
        body: "{}",
      });

      const response = await replayOrExecute(req, "req_test", makeEnv(failing), "auth", () => {
        downstreamCalls += 1;
        return Promise.resolve(new Response("ok", { status: 200 }));
      });

      expect(response.status).toBe(200);
      expect(downstreamCalls).toBe(1);
    });

    it("non-text response body → base64-encoded in envelope, replay round-trips bytes", async () => {
      const kv = createFakeKv();
      const bytes = new Uint8Array([0xff, 0x00, 0x42, 0xab, 0xcd]);
      let downstreamCalls = 0;
      const downstream = () => {
        downstreamCalls += 1;
        return Promise.resolve(
          new Response(bytes, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
        );
      };
      const req1 = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "idempotency-key": VALID_KEY_A },
        body: "{}",
      });

      const first = await replayOrExecute(req1, "req_a", makeEnv(kv.binding), "auth", downstream);
      expect(first.status).toBe(200);
      expect(downstreamCalls).toBe(1);
      const stored = kv.putCalls.find(c => c.key.startsWith("idem:"))!.value;
      const env = JSON.parse(stored) as { bodyEncoding: string; v: number };
      expect(env.bodyEncoding).toBe("base64");
      expect(env.v).toBe(1);

      // Replay
      const req2 = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "idempotency-key": VALID_KEY_A },
        body: "{}",
      });
      const replay = await replayOrExecute(req2, "req_b", makeEnv(kv.binding), "auth", downstream);
      expect(downstreamCalls).toBe(1); // not called again
      const replayBytes = new Uint8Array(await replay.arrayBuffer());
      expect(Array.from(replayBytes)).toEqual(Array.from(bytes));
    });

    it("identity-agnostic key → same path + same idempotency-key collides regardless of caller actor", async () => {
      const kv = createFakeKv();
      let downstreamCalls = 0;
      const downstream = () => {
        downstreamCalls += 1;
        return Promise.resolve(Response.json({ data: { n: downstreamCalls } }));
      };

      // Two requests, same path + same key, "different actors" (we don't pass actor —
      // this asserts the cache key derivation does not depend on identity headers).
      const r1 = new Request("https://api.example.com/v1/organizations/org_abc/invitations", {
        method: "POST",
        headers: {
          "idempotency-key": VALID_KEY_A,
          authorization: "Bearer caller-A",
        },
        body: "{}",
      });
      const r2 = new Request("https://api.example.com/v1/organizations/org_abc/invitations", {
        method: "POST",
        headers: {
          "idempotency-key": VALID_KEY_A,
          authorization: "Bearer caller-B",
        },
        body: "{}",
      });

      const env = makeEnv(kv.binding);
      const first = await replayOrExecute(r1, "req_a", env, "org", downstream);
      const second = await replayOrExecute(r2, "req_b", env, "org", downstream);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(downstreamCalls).toBe(1);
      expect(second.headers.get("x-saas-replay-source")).toBe("edge-idempotency");
    });
  });
});
