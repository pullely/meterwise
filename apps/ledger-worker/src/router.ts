import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleIngest } from "./handlers/ingest.js";
import { handleListEvents } from "./handlers/events.js";
import { handleCosts } from "./handlers/costs.js";
import { handlePrices } from "./handlers/prices.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import { generateRequestId, parseOrgPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header && REQUEST_ID_RE.test(header) ? header : generateRequestId();
}

/**
 * This worker is unreachable except over a service binding from api-edge, so
 * the actor arrives as headers the edge resolved and set, never as a token.
 * For the SDK the actor is the API key's service principal.
 */
function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

type Handler = (request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string) => Promise<Response>;

// Every route is org-scoped: /v1/organizations/{org}/…  (design §4.1)
const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "llm-events": { GET: handleListEvents, POST: handleIngest },
  "llm-costs": { GET: handleCosts },
  "llm-prices": { GET: handlePrices },
};

const ORG_ROUTE_RE = /^\/v1\/organizations\/([^/]+)\/(llm-events|llm-costs|llm-prices)$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);
  try {
    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env, requestId);
    const m = url.pathname.match(ORG_ROUTE_RE);
    if (!m) return notFound(requestId, url.pathname);
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId);
    const handler = ROUTES[m[2]!]![request.method];
    if (!handler) return methodNotAllowed(requestId);
    const actor = resolveActor(request);
    if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
    return await handler(request, env, requestId, actor, orgId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
