import type { Env } from "./env";
import { errorResponse } from "./http";
import { cacheApiStore, bearerToken, type ActorCacheStore } from "./actor-cache";

export interface ActorInfo {
  subjectId: string;
  subjectType: string;
  email: string;
  orgId?: string;
}

export interface ActorFailure {
  error: Response;
}

export interface ResolveActorDeps {
  /** Injectable cache store (tests). Defaults to the Cache-API store. */
  cache?: ActorCacheStore;
}

/**
 * Resolves bearer token to actor context via IDENTITY_WORKER /v1/auth/resolve.
 * Supports both user sessions (sps_ses_ tokens) and API keys (service_principal).
 *
 * Hot-path cache (Task 0131 / PERF2): a successful resolution is cached by a
 * hash of the token for a short TTL, so repeat requests skip the identity-worker
 * hop + its DB queries. Misses and failures fall through to a live resolve.
 */
export async function resolveActor(
  request: Request,
  env: Env,
  requestId: string,
  deps?: ResolveActorDeps,
): Promise<ActorInfo | ActorFailure> {
  const authorization = request.headers.get("authorization");
  const token = bearerToken(authorization);
  if (!authorization || !token) {
    return {
      error: errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId),
    };
  }

  if (!env.IDENTITY_WORKER) {
    return {
      error: errorResponse("internal_error", "Authentication service unavailable", 503, requestId),
    };
  }

  const cache = deps?.cache ?? cacheApiStore();
  const cached = await cache.get(token);
  if (cached) return cached;

  const headers = new Headers();
  headers.set("authorization", authorization);
  headers.set("x-request-id", requestId);

  const target = new URL("/v1/auth/resolve", "https://identity.internal");

  try {
    const response = await env.IDENTITY_WORKER.fetch(target.toString(), {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      return {
        error: errorResponse("unauthenticated", "Authentication failed", 401, requestId),
      };
    }

    const json = (await response.json()) as {
      data?: {
        actor?: {
          actorType?: string;
          actorId?: string;
          email?: string;
          orgId?: string;
        };
        user?: { id?: string; email?: string };
      };
    };

    const actor = json?.data?.actor;
    if (!actor?.actorType || !actor?.actorId) {
      return {
        error: errorResponse("unauthenticated", "Authentication failed", 401, requestId),
      };
    }

    // For user actors, prefer user-level email; for service_principal, use actor email or empty
    const email = json?.data?.user?.email ?? actor.email ?? "";

    const info: ActorInfo = {
      subjectId: actor.actorId,
      subjectType: actor.actorType,
      email,
      ...(actor.orgId && { orgId: actor.orgId }),
    };
    // Cache only successful resolutions (best-effort; never cache a denial).
    await cache.set(token, info);
    return info;
  } catch {
    return {
      error: errorResponse("internal_error", "Authentication service unavailable", 503, requestId),
    };
  }
}
