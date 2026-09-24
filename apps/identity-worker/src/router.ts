import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleLoginStart } from "./handlers/login-start.js";
import { handleLoginComplete } from "./handlers/login-complete.js";
import { handleSession } from "./handlers/session.js";
import { handleResolveBearer } from "./handlers/resolve-bearer.js";
import { handleLogout } from "./handlers/logout.js";
import { handleSecurityEvents } from "./handlers/security-events.js";
import { handleProfile } from "./handlers/profile.js";
import { handleOAuthProviders } from "./handlers/oauth-providers.js";
import { handleOAuthStart } from "./handlers/oauth-start.js";
import { handleOAuthCallback } from "./handlers/oauth-callback.js";
import { handleCreateApiKey, handleListApiKeys, handleRevokeApiKey } from "./handlers/api-key-admin.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";

const ORG_API_KEYS_RE = /^\/v1\/organizations\/[^/]+\/api-keys$/;
const ORG_API_KEY_ID_RE = /^\/v1\/organizations\/[^/]+\/api-keys\/[^/]+$/;
const OAUTH_START_RE = /^\/v1\/auth\/oauth\/[^/]+\/start$/;
const OAUTH_CALLBACK_RE = /^\/v1\/auth\/oauth\/[^/]+\/callback$/;
import { generateRequestId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    if (url.pathname === "/v1/auth/login/start") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleLoginStart(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/login/complete") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleLoginComplete(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/session") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleSession(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/resolve") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleResolveBearer(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/logout") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleLogout(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/security-events") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleSecurityEvents(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/profile") {
      if (request.method !== "GET" && request.method !== "PATCH") return methodNotAllowed(requestId);
      return handleProfile(request, env, requestId);
    }

    // OAuth sign-in (pre-organization, identity-owned). Browser-redirect flow.
    if (url.pathname === "/v1/auth/oauth/providers") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleOAuthProviders(env, requestId);
    }

    if (OAUTH_START_RE.test(url.pathname)) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleOAuthStart(request, env, requestId);
    }

    if (OAUTH_CALLBACK_RE.test(url.pathname)) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleOAuthCallback(request, env, requestId);
    }

    // API-key admin routes (forwarded from api-edge)
    if (ORG_API_KEYS_RE.test(url.pathname)) {
      if (request.method === "POST") return handleCreateApiKey(request, env, requestId);
      if (request.method === "GET") return handleListApiKeys(request, env, requestId);
      return methodNotAllowed(requestId);
    }

    if (ORG_API_KEY_ID_RE.test(url.pathname)) {
      if (request.method === "DELETE") return handleRevokeApiKey(request, env, requestId);
      return methodNotAllowed(requestId);
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
