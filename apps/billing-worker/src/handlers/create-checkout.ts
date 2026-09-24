import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { CreateCheckoutResponse } from "@saas/contracts/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeBillingManage } from "../policy.js";
import { isKnownPlanCode, getPlanDefinition, DEFAULT_PLAN_CODE } from "../plan-catalog.js";
import { orgPublicId } from "../ids.js";
import { resolveBillingOrgHex } from "../billing-scope.js";
import { buildBillingProviderRegistry } from "../billing-provider/polar.js";
import { parsePolarConfig } from "../billing-provider/polar-mapping.js";
import type { BillingProviderRegistry } from "../billing-provider/registry.js";

/** The internal free-plan row id; an active subscription on any other plan means
 *  the account already subscribes (so plan changes go through the portal). */
const FREE_PLAN_ID = getPlanDefinition(DEFAULT_PLAN_CODE)?.id ?? "plan_free";

/**
 * Validate a client-supplied embed origin: it must be a bare origin (scheme +
 * host, no path/query/fragment) over https — or http only for localhost dev.
 * This value only governs which origin may iframe the hosted checkout (it is not
 * a redirect target), but we still constrain it so a malformed value can't reach
 * the provider. Returns the normalized origin or null.
 */
export function validateEmbedOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 253) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== raw) return null; // reject anything with a path/query/fragment
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return url.origin;
  }
  return null;
}

/**
 * Validate a client-supplied return path: a root-relative path within the
 * console (e.g. `/orgs/acme/settings/billing?checkout=complete`). It is appended
 * to the validated `embedOrigin` to build the provider success URL, so the buyer
 * returns into the console even on the full-page (non-embedded) fallback. Reject
 * absolute/protocol-relative/backslash/control-char inputs so it can only ever
 * be same-origin as `embedOrigin` (no open redirect). Returns the path or null.
 */
export function validateReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith("/")) return null; // must be root-relative
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null; // not protocol-relative
  if (raw.includes("\\")) return null;
  if (/[\x00-\x1f\x7f]/.test(raw)) return null; // no control chars
  return raw;
}

/**
 * Build the provider success URL the buyer returns to after a hosted (non-
 * embedded) checkout. Prefer a same-origin URL from the validated embed origin +
 * return path so the buyer lands back in the console; fall back to the per-env
 * `POLAR_SUCCESS_URL`, then to empty (provider default page).
 */
export function buildSuccessUrl(
  embedOrigin: string | null,
  returnPath: string | null,
  envSuccessUrl: string | undefined,
): string {
  if (embedOrigin && returnPath) return `${embedOrigin}${returnPath}`;
  return envSuccessUrl ?? "";
}

/**
 * Authoritative "is the account already a paying subscriber?" signal — read from
 * OUR billing state (what the console shows), not a provider API call. An active
 * subscription on a non-free plan ⇒ a plan change, which must go through the
 * customer portal. Fails safe to `false` (→ checkout) if state is unavailable.
 */
async function accountHasPaidSubscription(
  env: Env,
  billingOrgHex: string,
  deps: CreateCheckoutDeps,
): Promise<boolean> {
  if (deps.getActiveSubscription) {
    const sub = await deps.getActiveSubscription(billingOrgHex);
    return sub !== null && sub.planId !== FREE_PLAN_ID;
  }
  if (!env.PLATFORM_DB) return false;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createBillingRepository(executor);
    const res = await repo.getActiveSubscription(billingOrgHex);
    return res.ok && res.value.planId !== FREE_PLAN_ID;
  } catch {
    return false;
  } finally {
    if ("dispose" in executor && typeof executor.dispose === "function") {
      await executor.dispose();
    }
  }
}

/**
 * POST /v1/organizations/:orgId/billing/checkout (BP2).
 *
 * Authorize `billing.manage`, resolve the plan to the active provider's product
 * (`POLAR_PRODUCT_MAP`), and return a URL to redirect to:
 *   - first purchase (no active subscription) → a hosted **checkout** URL;
 *   - existing subscriber (plan change) → the customer **portal** URL, since
 *     providers reject a second subscription via checkout ("You already have an
 *     active subscription"). `mode` distinguishes the two.
 *
 * Binds to the account's billing org (a child resolves to its parent — MO4) and
 * only accepts purchasable plans (free/enterprise are rejected). Creates no
 * local state; the plan is applied by the verified webhook (BP2 intake).
 */

export interface CreateCheckoutDeps {
  registry?: BillingProviderRegistry;
  productMap?: Record<string, string>;
  authorize?: typeof authorizeBillingManage;
  /** Injectable "active subscription for this billing org" lookup (tests); the
   *  default reads the billing repo. `null` = no active subscription. */
  getActiveSubscription?: (billingOrgHex: string) => Promise<{ planId: string } | null>;
}

export async function handleCreateCheckout(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps: CreateCheckoutDeps = {},
): Promise<Response> {
  const authorize = deps.authorize ?? authorizeBillingManage;
  const auth = await authorize(env, actor, orgId, requestId);
  if (!auth.ok) return auth.response;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationError(requestId, "request body is not valid JSON");
  }
  const planCode = (payload as { planCode?: unknown } | null)?.planCode;
  if (typeof planCode !== "string" || !isKnownPlanCode(planCode)) {
    return validationError(requestId, "planCode is required and must be a known plan");
  }
  // Optional: the console's origin, enabling an in-app embedded checkout. A
  // malformed value is ignored (the checkout still works as a full-page redirect).
  const embedOrigin = validateEmbedOrigin(
    (payload as { embedOrigin?: unknown } | null)?.embedOrigin,
  );
  // Optional: a root-relative console path to return the buyer to after a hosted
  // (non-embedded) checkout. Combined with embedOrigin into a same-origin success
  // URL so the buyer lands back in the console; ignored if malformed.
  const returnPath = validateReturnPath(
    (payload as { returnPath?: unknown } | null)?.returnPath,
  );

  const productMap = deps.productMap ?? parsePolarConfig(env)?.productMap ?? {};
  const productId = productMap[planCode];
  if (!productId) {
    return errorResponse(
      "plan_not_purchasable",
      "This plan cannot be purchased via self-serve checkout",
      400,
      requestId,
    );
  }

  const registry = deps.registry ?? buildBillingProviderRegistry(env);
  const resolved = registry.resolve(env);
  if (!resolved.ok) {
    return errorResponse("provider_unavailable", "Billing provider not configured", 503, requestId);
  }

  // Target the account's billing org (a child's purchase/change is the parent's
  // single subscription — MO4). Standalone orgs resolve to themselves.
  const billingOrgHex = await resolveBillingOrgHex(env, orgId, requestId);
  const billingOrgPublicId = orgPublicId(billingOrgHex);

  try {
    // A plan change for an account that already subscribes can't be a second
    // checkout (the provider rejects it: "You already have an active
    // subscription") — route to the customer portal. Decide from OUR billing
    // state primarily; the provider check is a secondary safety net.
    const alreadySubscribed =
      (await accountHasPaidSubscription(env, billingOrgHex, deps)) ||
      (await resolved.provider.hasActiveSubscription(billingOrgPublicId));
    if (alreadySubscribed) {
      const portal = await resolved.provider.createPortalSession({ orgId: billingOrgPublicId });
      const body: CreateCheckoutResponse = { checkoutUrl: portal.portalUrl, mode: "portal" };
      return successResponse(body, requestId);
    }

    const result = await resolved.provider.createCheckout({
      orgId: billingOrgPublicId,
      planCode,
      productId,
      successUrl: buildSuccessUrl(embedOrigin, returnPath, env.POLAR_SUCCESS_URL),
      ...(embedOrigin ? { embedOrigin } : {}),
    });
    const body: CreateCheckoutResponse = { checkoutUrl: result.checkoutUrl, mode: "checkout" };
    return successResponse(body, requestId);
  } catch {
    return errorResponse("provider_error", "Failed to start plan change", 502, requestId);
  }
}
