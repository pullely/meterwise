import type { Env } from "./env.js";
import type { SupportActor } from "./support-auth.js";
import type { SupportRequestContext } from "./handlers/record-support-action.js";
import { handleHealth } from "./handlers/health.js";
import { handleRecordSupportAction } from "./handlers/record-support-action.js";
import { handleListSupportActions } from "./handlers/list-support-actions.js";
import { handleListEntitlementDecisions } from "./handlers/list-entitlement-decisions.js";
import {
  handleLookupOrganizationForSupport,
  handleLookupUserForSupport,
} from "./handlers/lookup-support.js";
import { errorResponse } from "./http.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `req_${hex}`;
}

// Resolve the support request context from request headers. Mirrors how peer
// internal workers resolve actor claims from headers. The exact source of truth
// for the support-role claim is intentionally narrow for V1 (header-carried,
// tighten-able to a signed claim later without changing the auth contract).
//
// Headers:
//   x-actor-id / x-actor-type — the authenticated caller (set by the trusted
//     internal caller; admin-worker is NOT exposed via api-edge).
//   x-support-role           — the caller's support-role claim (if any).
//   x-system-override: "true" — explicit break-glass override (system actor only).
function resolveSupportContext(request: Request): SupportRequestContext {
  const actorId = request.headers.get("x-actor-id");
  const actorType = request.headers.get("x-actor-type");
  let actor: SupportActor | null = null;
  if (actorId && actorType) {
    actor = { subjectId: actorId, subjectType: actorType };
  }
  const supportRoleClaim = request.headers.get("x-support-role");
  const systemOverride = request.headers.get("x-system-override") === "true";
  return { actor, supportRoleClaim, systemOverride };
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Internal route prefixes (NOT public, NOT routed through api-edge).
const ORG_LOOKUP_RE = /^\/v1\/internal\/support\/organizations\/([^/]+)$/;
const USER_LOOKUP_RE = /^\/v1\/internal\/support\/users\/([^/]+)$/;
const ACTIONS_RE = /^\/v1\/internal\/support\/organizations\/([^/]+)\/actions$/;
const ENTITLEMENT_DECISIONS_RE = /^\/v1\/internal\/support\/organizations\/([^/]+)\/entitlement-decisions$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const requestId = resolveRequestId(request);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  try {
    if (method === "GET" && path === "/health") {
      return handleHealth(env, requestId);
    }

    // Record a support action against a target org.
    if (method === "POST" && path === "/v1/internal/support/actions") {
      const ctx = resolveSupportContext(request);
      const body = await readJsonBody(request);
      return await handleRecordSupportAction(env, requestId, ctx, body);
    }

    // List support actions for a target org.
    const actionsMatch = ACTIONS_RE.exec(path);
    if (method === "GET" && actionsMatch) {
      const ctx = resolveSupportContext(request);
      return await handleListSupportActions(env, requestId, ctx, actionsMatch[1]!, url);
    }

    // Aggregated entitlement-decision observability for a target org (B9).
    const decisionsMatch = ENTITLEMENT_DECISIONS_RE.exec(path);
    if (method === "GET" && decisionsMatch) {
      const ctx = resolveSupportContext(request);
      return await handleListEntitlementDecisions(env, requestId, ctx, decisionsMatch[1]!, url);
    }

    // Read-only diagnostic lookup: organization.
    const orgMatch = ORG_LOOKUP_RE.exec(path);
    if (method === "GET" && orgMatch) {
      const ctx = resolveSupportContext(request);
      return await handleLookupOrganizationForSupport(env, requestId, ctx, orgMatch[1]!);
    }

    // Read-only diagnostic lookup: user.
    const userMatch = USER_LOOKUP_RE.exec(path);
    if (method === "GET" && userMatch) {
      const ctx = resolveSupportContext(request);
      const targetOrgId = url.searchParams.get("targetOrgId");
      return await handleLookupUserForSupport(env, requestId, ctx, userMatch[1]!, targetOrgId);
    }

    return errorResponse("not_found", `Route not found: ${path}`, 404, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
