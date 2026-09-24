import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ChangePlanResponse } from "@saas/contracts/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeBillingManage } from "../policy.js";
import { orgPublicId } from "../ids.js";
import { resolveBillingOrgHex } from "../billing-scope.js";
import { isKnownPlanCode, getPlanById, getPlanDefinition, DEFAULT_PLAN_CODE } from "../plan-catalog.js";
import { buildBillingProviderRegistry } from "../billing-provider/polar.js";
import { parsePolarConfig } from "../billing-provider/polar-mapping.js";
import type { BillingProviderRegistry } from "../billing-provider/registry.js";

const FREE_PLAN_ID = getPlanDefinition(DEFAULT_PLAN_CODE)?.id ?? "plan_free";

interface ActiveSub {
  planId: string;
  providerSubscriptionId: string | null;
}

/**
 * POST /v1/organizations/:orgId/billing/subscription/change  body: { planCode }
 *
 * Change an existing paid subscription to another plan natively (no hosted-portal
 * redirect). Authorizes `billing.manage`, resolves the account billing org
 * (child → parent, MO4), maps the target plan to the active provider's product,
 * and asks the provider to switch (proration is provider-side). The downgrade/
 * upgrade re-materializes via the verified webhook — no local state written here.
 *
 * Guards: target must be a known, purchasable plan; the account must already have
 * a provider-linked paid subscription (first purchase goes through checkout); and
 * changing to the plan already active is a no-op `409`.
 */

export interface ChangePlanDeps {
  registry?: BillingProviderRegistry;
  productMap?: Record<string, string>;
  authorize?: typeof authorizeBillingManage;
  getActiveSubscription?: (billingOrgHex: string) => Promise<ActiveSub | null>;
}

async function readActiveSub(
  env: Env,
  billingOrgHex: string,
  deps: ChangePlanDeps,
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

export async function handleChangePlan(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps: ChangePlanDeps = {},
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

  const productMap = deps.productMap ?? parsePolarConfig(env)?.productMap ?? {};
  const productId = productMap[planCode];
  if (!productId) {
    return errorResponse("plan_not_purchasable", "This plan cannot be selected via self-serve", 400, requestId);
  }

  const registry = deps.registry ?? buildBillingProviderRegistry(env);
  const resolved = registry.resolve(env);
  if (!resolved.ok) {
    return errorResponse("provider_unavailable", "Billing provider not configured", 503, requestId);
  }

  const billingOrgHex = await resolveBillingOrgHex(env, orgId, requestId);
  const active = await readActiveSub(env, billingOrgHex, deps);

  if (!active || active.planId === FREE_PLAN_ID || !active.providerSubscriptionId) {
    // No provider-managed paid subscription to change — first purchase is checkout.
    return errorResponse("no_active_subscription", "No paid subscription to change", 409, requestId);
  }
  // Changing to the plan already active is a no-op.
  if (getPlanById(active.planId)?.code === planCode) {
    return errorResponse("already_on_plan", "Already subscribed to this plan", 409, requestId);
  }

  try {
    const result = await resolved.provider.changeSubscriptionPlan({
      orgId: orgPublicId(billingOrgHex),
      providerSubscriptionId: active.providerSubscriptionId,
      productId,
    });
    const body: ChangePlanResponse = { changed: result.changed };
    return successResponse(body, requestId);
  } catch {
    return errorResponse("provider_error", "Failed to change plan", 502, requestId);
  }
}
