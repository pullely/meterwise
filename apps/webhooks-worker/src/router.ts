import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import {
  handleCreateWebhookEndpoint,
  handleGetWebhookEndpoint,
  handleListWebhookEndpoints,
  handleUpdateWebhookEndpoint,
  handleDisableWebhookEndpoint,
  handleEnableWebhookEndpoint,
  handleDeleteWebhookEndpoint,
  handleRotateWebhookSecret,
} from "./handlers/webhook-endpoints.js";
import {
  handleCreateWebhookSubscription,
  handleGetWebhookSubscription,
  handleListWebhookSubscriptions,
  handleUpdateWebhookSubscription,
  handleDeleteWebhookSubscription,
} from "./handlers/webhook-subscriptions.js";
import {
  handleGetDeliveryAttempt,
  handleListDeliveryAttempts,
  handleReplayDeliveryAttempt,
} from "./handlers/webhook-delivery-attempts.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import {
  generateRequestId,
  parseOrgPublicId,
  parseProjectPublicId,
  parseWebhookEndpointPublicId,
  parseWebhookSubscriptionPublicId,
  parseWebhookDeliveryAttemptPublicId,
} from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

// ── Route patterns ──────────────────────────────────────────

// Collection routes
const ORG_ENDPOINTS_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/endpoints$/;
const PRJ_ENDPOINTS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/webhooks\/endpoints$/;

// Item routes
const ORG_ENDPOINT_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/endpoints\/([^/]+)$/;
const ORG_ENDPOINT_DISABLE_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/endpoints\/([^/]+)\/disable$/;
const ORG_ENDPOINT_ENABLE_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/endpoints\/([^/]+)\/enable$/;
const ORG_ENDPOINT_ROTATE_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/endpoints\/([^/]+)\/rotate-secret$/;

// Subscriptions
const ENDPOINT_SUBSCRIPTIONS_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/endpoints\/([^/]+)\/subscriptions$/;
const ORG_SUBSCRIPTIONS_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/subscriptions$/;
const ORG_SUBSCRIPTION_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/subscriptions\/([^/]+)$/;

// Delivery attempts
const ENDPOINT_DELIVERY_ATTEMPTS_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/endpoints\/([^/]+)\/delivery-attempts$/;
const ORG_DELIVERY_ATTEMPT_REPLAY_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/delivery-attempts\/([^/]+)\/replay$/;
const ORG_DELIVERY_ATTEMPT_ITEM_RE = /^\/v1\/organizations\/([^/]+)\/webhooks\/delivery-attempts\/([^/]+)$/;

// ── Main router ─────────────────────────────────────────────

export async function route(request: Request, env: Env): Promise<Response> {
  const requestId = resolveRequestId(request);
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Health check — no auth required
  if (pathname === "/health") {
    return handleHealth(env, requestId);
  }

  // Pre-flight checks
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Authorization services not configured", 503, requestId);
  }

  const actor = resolveActor(request);
  if (!actor) {
    return errorResponse("unauthenticated", "Authentication required", 401, requestId);
  }

  let m: RegExpMatchArray | null;

  // ── Endpoints ─────────────────────────────────────────────

  // POST /v1/organizations/:orgId/webhooks/endpoints/:id/disable
  m = pathname.match(ORG_ENDPOINT_DISABLE_RE);
  if (m) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    const orgId = parseOrgPublicId(m[1]!);
    const endpointId = parseWebhookEndpointPublicId(m[2]!);
    if (!orgId || !endpointId) return notFound(requestId, pathname);
    return handleDisableWebhookEndpoint(request, env, requestId, actor, orgId, endpointId);
  }

  // POST /v1/organizations/:orgId/webhooks/endpoints/:id/enable
  m = pathname.match(ORG_ENDPOINT_ENABLE_RE);
  if (m) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    const orgId = parseOrgPublicId(m[1]!);
    const endpointId = parseWebhookEndpointPublicId(m[2]!);
    if (!orgId || !endpointId) return notFound(requestId, pathname);
    return handleEnableWebhookEndpoint(request, env, requestId, actor, orgId, endpointId);
  }

  // POST /v1/organizations/:orgId/webhooks/endpoints/:id/rotate-secret
  m = pathname.match(ORG_ENDPOINT_ROTATE_RE);
  if (m) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    const orgId = parseOrgPublicId(m[1]!);
    const endpointId = parseWebhookEndpointPublicId(m[2]!);
    if (!orgId || !endpointId) return notFound(requestId, pathname);
    return handleRotateWebhookSecret(request, env, requestId, actor, orgId, endpointId);
  }

  // GET/PATCH/DELETE /v1/organizations/:orgId/webhooks/endpoints/:id
  m = pathname.match(ORG_ENDPOINT_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const endpointId = parseWebhookEndpointPublicId(m[2]!);
    if (!orgId || !endpointId) return notFound(requestId, pathname);
    switch (request.method) {
      case "GET":
        return handleGetWebhookEndpoint(request, env, requestId, actor, orgId, endpointId);
      case "PATCH":
        return handleUpdateWebhookEndpoint(request, env, requestId, actor, orgId, endpointId);
      case "DELETE":
        return handleDeleteWebhookEndpoint(request, env, requestId, actor, orgId, endpointId);
      default:
        return methodNotAllowed(requestId);
    }
  }

  // GET/POST /v1/organizations/:orgId/projects/:projectId/webhooks/endpoints
  m = pathname.match(PRJ_ENDPOINTS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const projectId = parseProjectPublicId(m[2]!);
    if (!orgId || !projectId) return notFound(requestId, pathname);
    switch (request.method) {
      case "GET":
        return handleListWebhookEndpoints(request, env, requestId, actor, orgId, projectId);
      case "POST":
        return handleCreateWebhookEndpoint(request, env, requestId, actor, orgId);
      default:
        return methodNotAllowed(requestId);
    }
  }

  // GET/POST /v1/organizations/:orgId/webhooks/endpoints
  m = pathname.match(ORG_ENDPOINTS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    switch (request.method) {
      case "GET":
        return handleListWebhookEndpoints(request, env, requestId, actor, orgId, null);
      case "POST":
        return handleCreateWebhookEndpoint(request, env, requestId, actor, orgId);
      default:
        return methodNotAllowed(requestId);
    }
  }

  // ── Subscriptions ─────────────────────────────────────────

  // GET /v1/organizations/:orgId/webhooks/endpoints/:endpointId/subscriptions
  m = pathname.match(ENDPOINT_SUBSCRIPTIONS_RE);
  if (m) {
    if (request.method !== "GET") return methodNotAllowed(requestId);
    const orgId = parseOrgPublicId(m[1]!);
    const endpointId = parseWebhookEndpointPublicId(m[2]!);
    if (!orgId || !endpointId) return notFound(requestId, pathname);
    return handleListWebhookSubscriptions(request, env, requestId, actor, orgId, endpointId);
  }

  // GET/PATCH/DELETE /v1/organizations/:orgId/webhooks/subscriptions/:id
  m = pathname.match(ORG_SUBSCRIPTION_ITEM_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    const subscriptionId = parseWebhookSubscriptionPublicId(m[2]!);
    if (!orgId || !subscriptionId) return notFound(requestId, pathname);
    switch (request.method) {
      case "GET":
        return handleGetWebhookSubscription(request, env, requestId, actor, orgId, subscriptionId);
      case "PATCH":
        return handleUpdateWebhookSubscription(request, env, requestId, actor, orgId, subscriptionId);
      case "DELETE":
        return handleDeleteWebhookSubscription(request, env, requestId, actor, orgId, subscriptionId);
      default:
        return methodNotAllowed(requestId);
    }
  }

  // POST /v1/organizations/:orgId/webhooks/subscriptions
  m = pathname.match(ORG_SUBSCRIPTIONS_RE);
  if (m) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return notFound(requestId, pathname);
    return handleCreateWebhookSubscription(request, env, requestId, actor, orgId);
  }

  // ── Delivery attempts ─────────────────────────────────────

  // GET /v1/organizations/:orgId/webhooks/endpoints/:endpointId/delivery-attempts
  m = pathname.match(ENDPOINT_DELIVERY_ATTEMPTS_RE);
  if (m) {
    if (request.method !== "GET") return methodNotAllowed(requestId);
    const orgId = parseOrgPublicId(m[1]!);
    const endpointId = parseWebhookEndpointPublicId(m[2]!);
    if (!orgId || !endpointId) return notFound(requestId, pathname);
    return handleListDeliveryAttempts(request, env, requestId, actor, orgId, endpointId);
  }

  // POST /v1/organizations/:orgId/webhooks/delivery-attempts/:id/replay
  m = pathname.match(ORG_DELIVERY_ATTEMPT_REPLAY_RE);
  if (m) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    const orgId = parseOrgPublicId(m[1]!);
    const attemptId = parseWebhookDeliveryAttemptPublicId(m[2]!);
    if (!orgId || !attemptId) return notFound(requestId, pathname);
    return handleReplayDeliveryAttempt(request, env, requestId, actor, orgId, attemptId);
  }

  // GET /v1/organizations/:orgId/webhooks/delivery-attempts/:id
  m = pathname.match(ORG_DELIVERY_ATTEMPT_ITEM_RE);
  if (m) {
    if (request.method !== "GET") return methodNotAllowed(requestId);
    const orgId = parseOrgPublicId(m[1]!);
    const attemptId = parseWebhookDeliveryAttemptPublicId(m[2]!);
    if (!orgId || !attemptId) return notFound(requestId, pathname);
    return handleGetDeliveryAttempt(request, env, requestId, actor, orgId, attemptId);
  }

  return notFound(requestId, pathname);
}
