import type { Env } from "./env";
import { errorResponse } from "./http";
import { replayOrExecute } from "./idempotency";
import { cacheApiStore, bearerToken } from "./actor-cache";

const LOGOUT_PATH = "/v1/auth/logout";

const AUTH_ROUTES: Record<string, string> = {
  "/v1/auth/login/start": "POST",
  "/v1/auth/login/complete": "POST",
  "/v1/auth/session": "GET",
  "/v1/auth/resolve": "GET",
  "/v1/auth/logout": "POST",
  "/v1/auth/security-events": "GET",
};

const AUTH_MULTI_METHOD_ROUTES: Record<string, Set<string>> = {
  "/v1/auth/profile": new Set(["GET", "PATCH"]),
};

// OAuth sign-in routes (all GET). `start` and `callback` are browser-redirect
// navigations; `providers` is a JSON read. The `:provider` segment is dynamic,
// so these are matched by pattern rather than the static route map.
const OAUTH_PROVIDERS_PATH = "/v1/auth/oauth/providers";
const OAUTH_START_RE = /^\/v1\/auth\/oauth\/[^/]+\/start$/;
const OAUTH_CALLBACK_RE = /^\/v1\/auth\/oauth\/[^/]+\/callback$/;

function isOAuthRoute(pathname: string): boolean {
  return (
    pathname === OAUTH_PROVIDERS_PATH ||
    OAUTH_START_RE.test(pathname) ||
    OAUTH_CALLBACK_RE.test(pathname)
  );
}

const FORWARDED_HEADERS = [
  "authorization",
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
  // Forwarded so the OAuth callback can read the state cookie set by `start`
  // (double-submit CSRF defense). Cookies are first-party to api-edge.
  "cookie",
];

export function isAuthRoute(pathname: string): boolean {
  return pathname in AUTH_ROUTES || pathname in AUTH_MULTI_METHOD_ROUTES || isOAuthRoute(pathname);
}

export async function handleAuthRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const expectedMethod = AUTH_ROUTES[pathname];
  const allowedMethods = AUTH_MULTI_METHOD_ROUTES[pathname];
  const oauth = isOAuthRoute(pathname);

  if (!expectedMethod && !allowedMethods && !oauth) {
    return errorResponse("not_found", `Route not found: ${pathname}`, 404, requestId);
  }

  if (oauth) {
    if (request.method !== "GET") {
      return errorResponse("unsupported", "Method not allowed", 405, requestId);
    }
  } else if (expectedMethod && request.method !== expectedMethod) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  } else if (allowedMethods && !allowedMethods.has(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "auth", async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse(
        "internal_error",
        "Authentication service unavailable",
        503,
        requestId,
      );
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://identity.internal");

    const init: RequestInit = {
      method: request.method,
      headers,
      // OAuth `start`/`callback` return 302s (to the provider, then back to the
      // console). Without manual mode the service-binding fetch would FOLLOW
      // them server-side instead of handing the redirect to the browser.
      // Other auth routes never redirect, so this is inert for them.
      redirect: "manual",
    };

    if (request.method === "POST" || request.method === "PATCH") {
      init.body = request.body;
    }

    try {
      const downstream = await env.IDENTITY_WORKER.fetch(target.toString(), init);
      // On a successful logout, evict the cached actor so the (now-revoked)
      // session can't be served from the edge cache for the rest of its TTL.
      if (pathname === LOGOUT_PATH && downstream.ok) {
        const token = bearerToken(request.headers.get("authorization"));
        if (token) await cacheApiStore().evict(token);
      }
      return new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
    } catch {
      return errorResponse(
        "internal_error",
        "Authentication service unavailable",
        503,
        requestId,
      );
    }
  });
}
