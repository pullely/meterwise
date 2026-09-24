import { createD1Adapter } from "@saas/db/d1";
import type { HealthStatus } from "@saas/contracts/health";
import type { Env } from "./env";
import { resolveRequestId, notFound } from "./http";
import { handlePreflight, applyCorsHeaders } from "./cors";
import { isAuthRoute, handleAuthRoute } from "./auth-facade";
import { isOrgRoute, handleOrgRoute } from "./org-facade";
import { isProjectRoute, handleProjectRoute } from "./project-facade";
import { isAuditRoute, handleAuditRoute } from "./audit-facade";
import { isConfigRoute, handleConfigRoute } from "./config-facade";
import { isWebhooksRoute, handleWebhooksRoute } from "./webhooks-facade";
import { isMeteringRoute, handleMeteringRoute } from "./metering-facade";
import { isBillingRoute, handleBillingRoute } from "./billing-facade";
import { isBillingWebhookRoute, handleBillingWebhookRoute } from "./billing-webhooks-facade";
import { isNotificationsRoute, handleNotificationsRoute } from "./notifications-facade";
import {
  isIntegrationsRoute,
  isIntegrationsIngressRoute,
  handleIntegrationsRoute,
  handleIntegrationsIngressRoute,
} from "./integrations-facade";
import { isSoloMode, isSoloSuppressed } from "./solo-mode";

// Durable Object class backing the PERF5 Stage B rate-limit counters. Must be
// exported from the Worker entry so the runtime can instantiate it for the
// `RATE_LIMITER_DO` binding.
export { RateLimiterDO } from "./rate-limit-do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const preflight = handlePreflight(request, env);
    if (preflight) return preflight;

    const url = new URL(request.url);
    const requestId = resolveRequestId(request);

    let response: Response;

    if (url.pathname === "/health") {
      response = await handleHealth(env);
    } else if (isSoloMode(env) && isSoloSuppressed(url.pathname, request.method)) {
      // M0 / Solo profile: org/team/project and platform-plumbing surfaces are
      // hidden. Suppress at the edge before any facade dispatch — the route
      // reads as "not found" to the single-user surface. Flip SOLO_MODE off and
      // this branch is dead, restoring the full baseline. (See ./solo-mode.ts.)
      response = notFound(requestId, url.pathname);
    } else if (isAuthRoute(url.pathname)) {
      response = await handleAuthRoute(request, env, requestId, url.pathname);
    } else if (isAuditRoute(url.pathname)) {
      response = await handleAuditRoute(request, env, requestId, url.pathname);
    } else if (isConfigRoute(url.pathname)) {
      response = await handleConfigRoute(request, env, requestId, url.pathname);
    } else if (isIntegrationsIngressRoute(url.pathname)) {
      // Public install-callback ingress (no session) — authenticated by the
      // signed single-use state verified in integrations-worker.
      response = await handleIntegrationsIngressRoute(request, env, requestId, url.pathname);
    } else if (isIntegrationsRoute(url.pathname)) {
      response = await handleIntegrationsRoute(request, env, requestId, url.pathname);
    } else if (isBillingWebhookRoute(url.pathname)) {
      // Public inbound provider webhook (no session) — matched before the
      // authenticated webhooks/billing facades.
      response = await handleBillingWebhookRoute(request, env, requestId, url.pathname);
    } else if (isWebhooksRoute(url.pathname)) {
      response = await handleWebhooksRoute(request, env, requestId, url.pathname);
    } else if (isNotificationsRoute(url.pathname)) {
      response = await handleNotificationsRoute(request, env, requestId, url.pathname);
    } else if (isMeteringRoute(url.pathname)) {
      response = await handleMeteringRoute(request, env, requestId, url.pathname);
    } else if (isBillingRoute(url.pathname)) {
      response = await handleBillingRoute(request, env, requestId, url.pathname);
    } else if (isProjectRoute(url.pathname)) {
      response = await handleProjectRoute(request, env, requestId, url.pathname);
    } else if (isOrgRoute(url.pathname)) {
      response = await handleOrgRoute(request, env, requestId, url.pathname);
    } else {
      response = notFound(requestId, url.pathname);
    }

    return applyCorsHeaders(response, request, env);
  },
} satisfies ExportedHandler<Env>;

async function handleHealth(env: Env): Promise<Response> {
  const db = await checkDatabase(env);
  const identity = checkIdentityBinding(env);
  const membership = checkMembershipBinding(env);

  const status: HealthStatus = !db.configured
    ? "ok"
    : db.reachable
      ? "ok"
      : "degraded";

  const code = status === "ok" ? 200 : 503;

  return Response.json(
    {
      status,
      service: "api-edge",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: { database: db, identity, membership },
    },
    { status: code },
  );
}

function checkIdentityBinding(env: Env): { configured: boolean } {
  return { configured: !!env.IDENTITY_WORKER };
}

function checkMembershipBinding(env: Env): { configured: boolean } {
  return { configured: !!env.MEMBERSHIP_WORKER };
}

async function checkDatabase(
  env: Env,
): Promise<{ configured: boolean; reachable: boolean }> {
  if (!env.PLATFORM_DB) {
    return { configured: false, reachable: false };
  }

  const adapter = createD1Adapter(env.PLATFORM_DB);
  try {
    return await adapter.ping();
  } finally {
    await adapter.dispose();
  }
}
