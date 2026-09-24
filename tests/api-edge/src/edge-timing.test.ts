// PERF6 — edge gate Server-Timing instrumentation.
//
// Asserts that `replayOrExecute` (the rate-limit + idempotency gate that runs
// BEFORE the facade's own timings) now contributes `edge_ratelimit` and, for an
// idempotent unsafe request, `edge_idem` phases to the response `Server-Timing`
// header — without clobbering phases the downstream worker already emitted.

import { replayOrExecute } from "@api-edge/idempotency";
import { __resetRateLimitMemoryForTest } from "@api-edge/rate-limit";
import { parseServerTimingDuration } from "@saas/contracts/timing";
import type { Env } from "@api-edge/env";

function createFakeKv(): { binding: KVNamespace; store: Map<string, string> } {
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

const VALID_KEY = "550e8400-e29b-41d4-a716-446655440000";

describe("PERF6 edge gate Server-Timing", () => {
  beforeEach(() => __resetRateLimitMemoryForTest());

  it("a safe GET carries edge_ratelimit and preserves the downstream phases", async () => {
    const env = { ENVIRONMENT: "test" } as Env; // no KV/DO → in-isolate read limiter
    const downstream = () =>
      Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "Server-Timing": "db;dur=5" },
        }),
      );
    const req = new Request("https://api.example.com/v1/organizations/org_t/projects", {
      method: "GET",
    });

    const res = await replayOrExecute(req, "req_get", env, "project", downstream);
    const st = res.headers.get("Server-Timing");
    expect(st).not.toBeNull();
    // downstream phase preserved (appended, not clobbered)...
    expect(parseServerTimingDuration(st, "db")).toBe(5);
    // ...and the gate phase is now present.
    expect(parseServerTimingDuration(st, "edge_ratelimit")).not.toBeNull();
    // reads do no idempotency lookup.
    expect(parseServerTimingDuration(st, "edge_idem")).toBeNull();
  });

  it("an idempotent unsafe POST carries both edge_ratelimit and edge_idem", async () => {
    const kv = createFakeKv();
    const env = { IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" } as Env;
    const downstream = () => Promise.resolve(Response.json({ ok: true }));
    const req = new Request("https://api.example.com/v1/organizations/org_t/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": VALID_KEY },
      body: "{}",
    });

    const res = await replayOrExecute(req, "req_post", env, "project", downstream);
    const st = res.headers.get("Server-Timing");
    expect(parseServerTimingDuration(st, "edge_ratelimit")).not.toBeNull();
    expect(parseServerTimingDuration(st, "edge_idem")).not.toBeNull();
  });

  it("a rate-limit denial (429) still reports edge_ratelimit", async () => {
    const kv = createFakeKv();
    const env = { IDEMPOTENCY_KV: kv.binding, ENVIRONMENT: "test" } as Env;
    const downstream = () => Promise.resolve(Response.json({ ok: true }));
    const mkReq = () =>
      new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
        body: "{}",
      });

    // Drain the auth identity bucket (tight: 10/min) to force a 429.
    let denied: Response | null = null;
    for (let i = 0; i < 20 && !denied; i++) {
      const r = await replayOrExecute(mkReq(), `req_${i}`, env, "auth", downstream);
      if (r.status === 429) denied = r;
    }
    expect(denied).not.toBeNull();
    expect(parseServerTimingDuration(denied!.headers.get("Server-Timing"), "edge_ratelimit")).not.toBeNull();
  });
});
