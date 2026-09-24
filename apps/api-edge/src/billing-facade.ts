import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const ORG_BILLING_PLANS_RE = /^\/v1\/organizations\/[^/]+\/billing\/plans$/;
const ORG_BILLING_CUSTOMER_RE = /^\/v1\/organizations\/[^/]+\/billing\/customer$/;
const ORG_BILLING_SUMMARY_RE = /^\/v1\/organizations\/[^/]+\/billing\/summary$/;
const ORG_BILLING_INVOICES_RE = /^\/v1\/organizations\/[^/]+\/billing\/invoices$/;
const ORG_BILLING_ENTITLEMENTS_RE = /^\/v1\/organizations\/[^/]+\/billing\/entitlements$/;
const ORG_BILLING_PAYMENT_METHODS_RE = /^\/v1\/organizations\/[^/]+\/billing\/payment-methods$/;
const ORG_BILLING_CHECKOUT_RE = /^\/v1\/organizations\/[^/]+\/billing\/checkout$/;
const ORG_BILLING_PORTAL_RE = /^\/v1\/organizations\/[^/]+\/billing\/portal$/;
const ORG_BILLING_CANCEL_RE = /^\/v1\/organizations\/[^/]+\/billing\/subscription\/cancel$/;
const ORG_BILLING_CHANGE_RE = /^\/v1\/organizations\/[^/]+\/billing\/subscription\/change$/;
const ORG_BILLING_RECONCILE_RE = /^\/v1\/organizations\/[^/]+\/billing\/reconcile$/;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

// checkout/portal/cancel/change are POST (billing.manage); the rest are GET reads.
const WRITE_BILLING_RES = [ORG_BILLING_CHECKOUT_RE, ORG_BILLING_PORTAL_RE, ORG_BILLING_CANCEL_RE, ORG_BILLING_CHANGE_RE, ORG_BILLING_RECONCILE_RE];

export function isBillingRoute(pathname: string): boolean {
  return (
    ORG_BILLING_PLANS_RE.test(pathname) ||
    ORG_BILLING_CUSTOMER_RE.test(pathname) ||
    ORG_BILLING_SUMMARY_RE.test(pathname) ||
    ORG_BILLING_INVOICES_RE.test(pathname) ||
    ORG_BILLING_ENTITLEMENTS_RE.test(pathname) ||
    ORG_BILLING_PAYMENT_METHODS_RE.test(pathname) ||
    ORG_BILLING_CHECKOUT_RE.test(pathname) ||
    ORG_BILLING_PORTAL_RE.test(pathname) ||
    ORG_BILLING_CANCEL_RE.test(pathname) ||
    ORG_BILLING_CHANGE_RE.test(pathname) ||
    ORG_BILLING_RECONCILE_RE.test(pathname)
  );
}

function isWriteBillingRoute(pathname: string): boolean {
  return WRITE_BILLING_RES.some((re) => re.test(pathname));
}

export async function handleBillingRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const isWrite = isWriteBillingRoute(pathname);
  const expectedMethod = isWrite ? "POST" : "GET";
  if (request.method !== expectedMethod) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "billing", async () => {

    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }

    if (!env.BILLING_WORKER) {
      return errorResponse("internal_error", "Billing service unavailable", 503, requestId);
    }

    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    if (sessionResult.orgId) {
    }
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://billing.internal");

    try {
      const init: RequestInit = { method: request.method, headers };
      if (isWrite) init.body = request.body;
      const downstream = await timings.measure("edge_downstream", () => env.BILLING_WORKER!.fetch(target.toString(), init));
      const res = new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.billing", timings);
    } catch {
      return errorResponse("internal_error", "Billing service unavailable", 503, requestId);
    }
  });
}