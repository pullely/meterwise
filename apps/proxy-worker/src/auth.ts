import type { Env } from "./env.js";
import { publicOrgId, sha256Hex } from "./ids.js";

// The Meterwise API key travels in x-meterwise-key, never in Authorization
// (that header is the customer's PROVIDER key, design §7.3). It is resolved by
// identity-worker over the service binding, exactly as api-edge resolves a
// bearer, and a success is cached in-isolate for 30 s keyed by the key's
// SHA-256 (the same revocation latency as api-edge, design §5).

export interface ProxyActor {
  /** The API key's service principal, sp_<hex>. */
  subjectId: string;
  subjectType: "service_principal";
  /** org_<hex> */
  org: string;
}

export type AuthResult = { ok: true; actor: ProxyActor } | { ok: false; error: "unauthenticated" | "unavailable" };

export const ACTOR_CACHE_TTL_MS = 30_000;
const KEY_RE = /^[\x21-\x7e]{8,256}$/;
const cache = new Map<string, { actor: ProxyActor; expires: number }>();

export function clearActorCache(): void {
  cache.clear();
}

export async function authenticate(env: Env, meterwiseKey: string | null, requestId: string): Promise<AuthResult> {
  if (meterwiseKey === null || !KEY_RE.test(meterwiseKey)) return { ok: false, error: "unauthenticated" };
  if (!env.IDENTITY_WORKER) return { ok: false, error: "unavailable" };
  const hash = await sha256Hex(meterwiseKey);
  const hit = cache.get(hash);
  if (hit && hit.expires > Date.now()) return { ok: true, actor: hit.actor };

  let response: Response;
  try {
    response = await env.IDENTITY_WORKER.fetch("https://identity.internal/v1/auth/resolve", {
      method: "GET",
      // The Meterwise key as a bearer, to identity-worker only. The provider
      // key is never part of this request.
      headers: { authorization: `Bearer ${meterwiseKey}`, "x-request-id": requestId },
    });
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (response.status >= 500) return { ok: false, error: "unavailable" };
  if (!response.ok) return { ok: false, error: "unauthenticated" };
  let actor: { actorType?: unknown; actorId?: unknown; orgId?: unknown } | undefined;
  try {
    actor = ((await response.json()) as { data?: { actor?: typeof actor } }).data?.actor;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  // Only an org API key: a user session has no org to meter against.
  if (actor?.actorType !== "service_principal" || typeof actor.actorId !== "string" || typeof actor.orgId !== "string") {
    return { ok: false, error: "unauthenticated" };
  }
  const org = publicOrgId(actor.orgId);
  if (!org || !/^sp_[0-9a-f]{32}$/.test(actor.actorId)) return { ok: false, error: "unauthenticated" };
  const resolved: ProxyActor = { subjectId: actor.actorId, subjectType: "service_principal", org };
  cache.set(hash, { actor: resolved, expires: Date.now() + ACTOR_CACHE_TTL_MS });
  return { ok: true, actor: resolved };
}
