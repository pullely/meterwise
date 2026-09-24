import type { ActorInfo } from "./resolve-actor";

/**
 * Edge bearer→actor resolution cache (Task 0131 / PERF2).
 *
 * Bearer resolution runs on every authenticated request (api-edge →
 * identity-worker → 2 DB queries, ~0.45s measured). For a stable session/key
 * that result is identical request-to-request, so we cache it for a short TTL
 * and skip the identity hop on the hot path.
 *
 * Security invariants:
 *  - keyed on a SHA-256 hash of the token (the raw token is never stored or
 *    logged; the cached value is the minimal non-secret `ActorInfo` only);
 *  - short TTL (revocation latency is bounded by it);
 *  - only successful resolutions are cached — never a denial, so the cache can
 *    never turn a 401 into an allow;
 *  - best-effort: any cache error falls through to a live resolve (fail-closed
 *    is preserved by the resolver, not the cache).
 *
 * Backed by the Workers Cache API (`caches.default`) — colo-local, no new
 * infra/resource. A `noopStore` is used when the Cache API is unavailable
 * (e.g. unit tests) so resolution always still works.
 */

export interface ActorCacheStore {
  get(token: string): Promise<ActorInfo | null>;
  set(token: string, actor: ActorInfo): Promise<void>;
  evict(token: string): Promise<void>;
}

export const ACTOR_CACHE_TTL_SECONDS = 30;

/** SHA-256 hex of the token — the cache key material (never the raw token). */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function keyUrl(hash: string): string {
  return `https://actor-cache.internal/v1/${hash}`;
}

/** No-op store: every get misses, set/evict do nothing. */
export function noopStore(): ActorCacheStore {
  return {
    async get() {
      return null;
    },
    async set() {
      /* no-op */
    },
    async evict() {
      /* no-op */
    },
  };
}

type CacheLike = {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
};

/** Cache-API-backed store. Falls back to a no-op store when unavailable. */
export function cacheApiStore(): ActorCacheStore {
  const c =
    typeof caches !== "undefined" && (caches as unknown as { default?: CacheLike }).default
      ? ((caches as unknown as { default: CacheLike }).default)
      : null;
  if (!c) return noopStore();
  return {
    async get(token) {
      try {
        const res = await c.match(keyUrl(await hashToken(token)));
        if (!res) return null;
        return (await res.json()) as ActorInfo;
      } catch {
        return null;
      }
    },
    async set(token, actor) {
      try {
        const res = new Response(JSON.stringify(actor), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${ACTOR_CACHE_TTL_SECONDS}`,
          },
        });
        await c.put(keyUrl(await hashToken(token)), res);
      } catch {
        /* best-effort */
      }
    },
    async evict(token) {
      try {
        await c.delete(keyUrl(await hashToken(token)));
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Extract the bearer token from an Authorization header value, or null. */
export function bearerToken(authorization: string | null): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}
