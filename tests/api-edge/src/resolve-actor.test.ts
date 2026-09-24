import { resolveActor, type ActorInfo, type ActorFailure } from "@api-edge/resolve-actor";
import { hashToken, noopStore, type ActorCacheStore } from "@api-edge/actor-cache";
import type { Env } from "@api-edge/env";

// In-memory cache store keyed by token (for asserting hit/miss/evict logic).
function memStore(): ActorCacheStore & { size: () => number } {
  const m = new Map<string, ActorInfo>();
  return {
    async get(token) {
      return m.get(token) ?? null;
    },
    async set(token, actor) {
      m.set(token, actor);
    },
    async evict(token) {
      m.delete(token);
    },
    size: () => m.size,
  };
}

// Counting identity-worker fetcher.
function identityFetcher(opts: { ok?: boolean; actorId?: string } = {}) {
  let calls = 0;
  const fetcher = {
    fetch: async () => {
      calls += 1;
      if (opts.ok === false) {
        return new Response(JSON.stringify({ error: { code: "unauthenticated" } }), { status: 401 });
      }
      return new Response(
        JSON.stringify({
          data: {
            actor: { actorType: "user", actorId: opts.actorId ?? "usr_abc", orgId: "org_1" },
            user: { id: opts.actorId ?? "usr_abc", email: "a@x.io" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  } as unknown as Fetcher;
  return { fetcher, calls: () => calls };
}

function req(token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://edge.test/v1/organizations", { headers });
}
const isActor = (r: ActorInfo | ActorFailure): r is ActorInfo => !("error" in r);

describe("resolveActor bearer cache (PERF2)", () => {
  it("resolves via identity on a cold miss and caches the result", async () => {
    const { fetcher, calls } = identityFetcher();
    const cache = memStore();
    const env = { IDENTITY_WORKER: fetcher } as unknown as Env;
    const r = await resolveActor(req("tok_1"), env, "req_1", { cache });
    expect(isActor(r)).toBe(true);
    if (isActor(r)) expect(r.subjectId).toBe("usr_abc");
    expect(calls()).toBe(1);
    expect(cache.size()).toBe(1);
  });

  it("serves a warm hit WITHOUT calling identity again", async () => {
    const { fetcher, calls } = identityFetcher();
    const cache = memStore();
    const env = { IDENTITY_WORKER: fetcher } as unknown as Env;
    await resolveActor(req("tok_1"), env, "req_1", { cache });
    const r2 = await resolveActor(req("tok_1"), env, "req_2", { cache });
    expect(isActor(r2)).toBe(true);
    expect(calls()).toBe(1); // identity hit only once
  });

  it("does NOT cache a denied resolution (re-hits identity next time)", async () => {
    const { fetcher, calls } = identityFetcher({ ok: false });
    const cache = memStore();
    const env = { IDENTITY_WORKER: fetcher } as unknown as Env;
    const r = await resolveActor(req("bad"), env, "req_1", { cache });
    expect(isActor(r)).toBe(false);
    expect(cache.size()).toBe(0);
    await resolveActor(req("bad"), env, "req_2", { cache });
    expect(calls()).toBe(2); // not served from cache
  });

  it("re-resolves after eviction (logout)", async () => {
    const { fetcher, calls } = identityFetcher();
    const cache = memStore();
    const env = { IDENTITY_WORKER: fetcher } as unknown as Env;
    await resolveActor(req("tok_1"), env, "req_1", { cache });
    await cache.evict("tok_1");
    await resolveActor(req("tok_1"), env, "req_2", { cache });
    expect(calls()).toBe(2);
  });

  it("keeps tokens isolated — a different token is a separate cache entry", async () => {
    const { fetcher, calls } = identityFetcher();
    const cache = memStore();
    const env = { IDENTITY_WORKER: fetcher } as unknown as Env;
    await resolveActor(req("tok_a"), env, "r1", { cache });
    await resolveActor(req("tok_b"), env, "r2", { cache });
    expect(calls()).toBe(2);
    expect(cache.size()).toBe(2);
  });

  it("rejects a missing/invalid Authorization header before any identity call or cache write", async () => {
    const { fetcher, calls } = identityFetcher();
    const cache = memStore();
    const env = { IDENTITY_WORKER: fetcher } as unknown as Env;
    const r = await resolveActor(req(null), env, "req_1", { cache });
    expect(isActor(r)).toBe(false);
    expect(calls()).toBe(0);
    expect(cache.size()).toBe(0);
  });

  it("noopStore never caches (every get misses)", async () => {
    const { fetcher, calls } = identityFetcher();
    const env = { IDENTITY_WORKER: fetcher } as unknown as Env;
    await resolveActor(req("tok_1"), env, "r1", { cache: noopStore() });
    await resolveActor(req("tok_1"), env, "r2", { cache: noopStore() });
    expect(calls()).toBe(2);
  });
});

describe("hashToken", () => {
  it("is a deterministic 64-char hex digest and differs per token", async () => {
    const a1 = await hashToken("tok_1");
    const a2 = await hashToken("tok_1");
    const b = await hashToken("tok_2");
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toContain("tok_1"); // never embeds the raw token
  });
});
