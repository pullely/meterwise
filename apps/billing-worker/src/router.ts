import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleListPlans } from "./handlers/list-plans.js";
import { handleGetBillingCustomer } from "./handlers/get-customer.js";
import { handleGetBillingSummary } from "./handlers/get-summary.js";
import { handleListInvoices } from "./handlers/list-invoices.js";
import { handleListEntitlements } from "./handlers/list-entitlements.js";
import { handleCheckEntitlement } from "./handlers/check-entitlement.js";
import { handleAssignPlan } from "./handlers/assign-plan.js";
import { handleFanOutPlan } from "./handlers/fan-out.js";
import { handleWebhookIntake } from "./handlers/webhook-intake.js";
import { handleCreateCheckout } from "./handlers/create-checkout.js";
import { handleCreatePortal } from "./handlers/create-portal.js";
import { handleCancelSubscription } from "./handlers/cancel-subscription.js";
import { handleChangePlan } from "./handlers/change-plan.js";
import { handleListPaymentMethods } from "./handlers/list-payment-methods.js";
import { handleReconcile } from "./handlers/reconcile.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import { generateRequestId, parseOrgPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

/**
 * Allow-list of internal bounded-context callers permitted to invoke
 * service-binding-only billing routes. This is a non-secret provenance
 * contract, not an authentication credential: only Workers explicitly
 * bound to billing-worker over a Cloudflare service binding can present
 * this header, so it cannot be forged from outside the trust boundary.
 *
 * Add a new caller here when a new bounded context gains a service binding
 * to billing-worker. Avoid wildcards.
 */
const INTERNAL_CALLER_HEADER = "x-internal-caller";
const INTERNAL_CALLER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ALLOWED_INTERNAL_CALLERS: ReadonlySet<string> = new Set([
  "projects-worker",
  "membership-worker",
  "integrations-worker",
  // api-edge forwards verified-at-source-of-truth inbound provider webhooks
  // (it streams the raw body here; this worker verifies the signature).
  "api-edge",
]);

function isAllowedInternalCaller(value: string | null): value is string {
  if (!value) return false;
  if (!INTERNAL_CALLER_RE.test(value)) return false;
  return ALLOWED_INTERNAL_CALLERS.has(value);
}

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
const PLANS_RE = /^\/v1\/organizations\/([^/]+)\/billing\/plans$/;
const CUSTOMER_RE = /^\/v1\/organizations\/([^/]+)\/billing\/customer$/;
const SUMMARY_RE = /^\/v1\/organizations\/([^/]+)\/billing\/summary$/;
const INVOICES_RE = /^\/v1\/organizations\/([^/]+)\/billing\/invoices$/;
const ENTITLEMENTS_RE = /^\/v1\/organizations\/([^/]+)\/billing\/entitlements$/;
const PAYMENT_METHODS_RE = /^\/v1\/organizations\/([^/]+)\/billing\/payment-methods$/;
const CHECKOUT_RE = /^\/v1\/organizations\/([^/]+)\/billing\/checkout$/;
const PORTAL_RE = /^\/v1\/organizations\/([^/]+)\/billing\/portal$/;
const CANCEL_RE = /^\/v1\/organizations\/([^/]+)\/billing\/subscription\/cancel$/;
const CHANGE_RE = /^\/v1\/organizations\/([^/]+)\/billing\/subscription\/change$/;
const RECONCILE_RE = /^\/v1\/organizations\/([^/]+)\/billing\/reconcile$/;

type RouteKind =
  | "plans"
  | "customer"
  | "summary"
  | "invoices"
  | "entitlements"
  | "paymentMethods"
  | "checkout"
  | "portal"
  | "cancel"
  | "change"
  | "reconcile";

// checkout/portal/cancel/change/reconcile are POST writes; the rest are GET reads.
const WRITE_KINDS: ReadonlySet<RouteKind> = new Set<RouteKind>(["checkout", "portal", "cancel", "change", "reconcile"]);

interface MatchedRoute {
  kind: RouteKind;
  orgId: string;
}

function matchRoute(pathname: string): MatchedRoute | null {
  const patterns: Array<[RegExp, RouteKind]> = [
    [PLANS_RE, "plans"],
    [CUSTOMER_RE, "customer"],
    [SUMMARY_RE, "summary"],
    [INVOICES_RE, "invoices"],
    [ENTITLEMENTS_RE, "entitlements"],
    [PAYMENT_METHODS_RE, "paymentMethods"],
    [CHECKOUT_RE, "checkout"],
    [PORTAL_RE, "portal"],
    [CANCEL_RE, "cancel"],
    [CHANGE_RE, "change"],
    [RECONCILE_RE, "reconcile"],
  ];
  for (const [re, kind] of patterns) {
    const m = pathname.match(re);
    if (m) {
      const orgId = parseOrgPublicId(m[1]!);
      if (!orgId) return null;
      return { kind, orgId };
    }
  }
  return null;
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    // Private internal routes (service-binding only — not exposed via api-edge).
    // These do NOT require an x-actor-* identity because the caller is another
    // bounded-context Worker over a service binding, not an end user. Public
    // exposure is prevented by the api-edge billing facade routing allow-list.
    //
    // They DO require an explicit internal-caller identity (allow-list) so
    // the route fails closed if a misconfigured or unknown service binding
    // ever reaches it, before any repository access.
    if (url.pathname === "/v1/internal/billing/entitlements/check") {
      const caller = request.headers.get(INTERNAL_CALLER_HEADER);
      if (!isAllowedInternalCaller(caller)) {
        return errorResponse(
          "unauthorized",
          "Unauthorized",
          403,
          requestId,
        );
      }
      return handleCheckEntitlement(request, env, requestId);
    }

    // Inbound provider-webhook intake (service-binding only). api-edge forwards
    // the raw body + signature headers here; this handler verifies the signature
    // (fails closed) and applies the event. Internal-caller gated like the seams
    // below; the signature is the real authenticity check.
    if (url.pathname === "/v1/internal/billing/webhooks/polar") {
      const caller = request.headers.get(INTERNAL_CALLER_HEADER);
      if (!isAllowedInternalCaller(caller)) {
        return errorResponse("unauthorized", "Unauthorized", 403, requestId);
      }
      return handleWebhookIntake(request, env, requestId);
    }

    // Internal plan-assignment seam (service-binding only). Idempotent create
    // or change of an org's subscription + entitlement materialization. Called
    // by membership-worker on org bootstrap (free plan); admin/upgrade callers
    // can reuse it once added to the allow-list.
    if (url.pathname === "/v1/internal/billing/plan/assign") {
      const caller = request.headers.get(INTERNAL_CALLER_HEADER);
      if (!isAllowedInternalCaller(caller)) {
        return errorResponse("unauthorized", "Unauthorized", 403, requestId);
      }
      return handleAssignPlan(request, env, requestId);
    }

    // Internal entitlement fan-out seam (service-binding only, MO3). Copies a
    // billing parent's plan entitlements onto a child org. Called by
    // membership-worker right after a child org is created.
    if (url.pathname === "/v1/internal/billing/plan/fan-out") {
      const caller = request.headers.get(INTERNAL_CALLER_HEADER);
      if (!isAllowedInternalCaller(caller)) {
        return errorResponse("unauthorized", "Unauthorized", 403, requestId);
      }
      return handleFanOutPlan(request, env, requestId);
    }

    const matched = matchRoute(url.pathname);
    if (!matched) {
      return notFound(requestId, url.pathname);
    }

    const expectedMethod = WRITE_KINDS.has(matched.kind) ? "POST" : "GET";
    if (request.method !== expectedMethod) {
      return methodNotAllowed(requestId);
    }

    const actor = resolveActor(request);
    if (!actor) {
      return errorResponse("unauthenticated", "Authentication required", 401, requestId);
    }

    switch (matched.kind) {
      case "plans":
        return handleListPlans(request, env, requestId, actor, matched.orgId);
      case "customer":
        return handleGetBillingCustomer(request, env, requestId, actor, matched.orgId);
      case "summary":
        return handleGetBillingSummary(request, env, requestId, actor, matched.orgId);
      case "invoices":
        return handleListInvoices(request, env, requestId, actor, matched.orgId);
      case "entitlements":
        return handleListEntitlements(request, env, requestId, actor, matched.orgId);
      case "paymentMethods":
        return handleListPaymentMethods(request, env, requestId, actor, matched.orgId);
      case "checkout":
        return handleCreateCheckout(request, env, requestId, actor, matched.orgId);
      case "portal":
        return handleCreatePortal(request, env, requestId, actor, matched.orgId);
      case "cancel":
        return handleCancelSubscription(request, env, requestId, actor, matched.orgId);
      case "change":
        return handleChangePlan(request, env, requestId, actor, matched.orgId);
      case "reconcile":
        return handleReconcile(request, env, requestId, actor, matched.orgId);
    }
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
