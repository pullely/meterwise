import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { CancelSubscriptionResponse } from "@saas/contracts/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { errorResponse, successResponse } from "../http.js";
import { authorizeBillingManage } from "../policy.js";
import { orgPublicId } from "../ids.js";
import { resolveBillingOrgHex } from "../billing-scope.js";
import { getPlanDefinition, DEFAULT_PLAN_CODE } from "../plan-catalog.js";
import { buildBillingProviderRegistry } from "../billing-provider/polar.js";
import type { BillingProviderRegistry } from "../billing-provider/registry.js";

const FREE_PLAN_ID = getPlanDefinition(DEFAULT_PLAN_CODE)?.id ?? "plan_free";

/** The active subscription the cancel targets — resolved from our own mirror. */
interface ActiveSub {
  planId: string;
  providerSubscriptionId: string | null;
}

/**
 * POST /v1/organizations/:orgId/billing/subscription/cancel
 *
 * Cancel the account's paid subscription natively (no hosted-portal redirect).
 * Authorizes `billing.manage`, resolves the account billing org (a child →
 * parent, MO4), reads the provider subscription id from our mirror, and asks the
 * provider to cancel. The authoritative downgrade still arrives via the verified
 * webhook — this creates no local state. Idempotent-ish: a free/absent
 * subscription returns a clear 409 rather than calling the provider.
 */

export interface CancelSubscriptionDeps {
  registry?: BillingProviderRegistry;
  authorize?: typeof authorizeBillingManage;
  /** Injectable active-subscription lookup (tests); default reads the billing repo. */
  getActiveSubscription?: (billingOrgHex: string) => Promise<ActiveSub | null>;
}

async function readActiveSub(
  env: Env,
  billingOrgHex: string,
  deps: CancelSubscriptionDeps,
): Promise<ActiveSub | null> {
  if (deps.getActiveSubscription) return deps.getActiveSubscription(billingOrgHex);
  if (!env.PLATFORM_DB) return null;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createBillingRepository(executor);
    const res = await repo.getActiveSubscription(billingOrgHex);
    if (!res.ok) return null;
    return { planId: res.value.planId, providerSubscriptionId: res.value.providerSubscriptionId };
  } catch {
    return null;
  } finally {
    if ("dispose" in executor && typeof executor.dispose === "function") {
      await executor.dispose();
    }
  }
}

export async function handleCancelSubscription(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps: CancelSubscriptionDeps = {},
): Promise<Response> {
  const authorize = deps.authorize ?? authorizeBillingManage;
  const auth = await authorize(env, actor, orgId, requestId);
  if (!auth.ok) return auth.response;

  const registry = deps.registry ?? buildBillingProviderRegistry(env);
  const resolved = registry.resolve(env);
  if (!resolved.ok) {
    return errorResponse("provider_unavailable", "Billing provider not configured", 503, requestId);
  }

  // Target the account's billing org (child → parent, MO4).
  const billingOrgHex = await resolveBillingOrgHex(env, orgId, requestId);
  const active = await readActiveSub(env, billingOrgHex, deps);

  if (!active || active.planId === FREE_PLAN_ID) {
    return errorResponse("no_active_subscription", "No paid subscription to cancel", 409, requestId);
  }
  if (!active.providerSubscriptionId) {
    // A paid plan with no provider link can't be canceled at the provider — this
    // would only happen for manually-assigned plans; surface clearly.
    return errorResponse("not_cancelable", "This subscription cannot be canceled here", 409, requestId);
  }

  try {
    const result = await resolved.provider.cancelSubscription({
      orgId: orgPublicId(billingOrgHex),
      providerSubscriptionId: active.providerSubscriptionId,
    });
    const body: CancelSubscriptionResponse = { cancelAtPeriodEnd: result.cancelAtPeriodEnd };
    return successResponse(body, requestId);
  } catch {
    return errorResponse("provider_error", "Failed to cancel subscription", 502, requestId);
  }
}
