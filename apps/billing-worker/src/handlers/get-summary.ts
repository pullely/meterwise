import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { GetBillingSummaryResponse } from "@saas/contracts/billing";
import type { BillingRepository } from "@saas/db/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { errorResponse, successResponse, withTimings } from "../http.js";
import { authorizeBillingRead } from "../policy.js";
import { resolveBillingOrgHex } from "../billing-scope.js";
import { createTimings } from "@saas/contracts/timing";
import {
  mapBillingCustomerToPublic,
  mapEntitlementToPublic,
  mapPlanToPublic,
  mapSubscriptionToPublic,
} from "../mappers.js";

export interface HandleGetBillingSummaryDeps {
  repo?: Pick<BillingRepository, "getBillingSummary">;
}

export async function handleGetBillingSummary(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps?: HandleGetBillingSummaryDeps,
): Promise<Response> {
  if (!deps?.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  const timings = createTimings();
  const endTotal = timings.start("total");
  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  const repo = deps?.repo ?? createBillingRepository(executor!);
  try {
    // PERF4 (task 0133): authorization (membership context + policy) and the
    // MO4 billing-parent resolution are independent — run them concurrently.
    // The read targets the resolved (effective) billing org: a child's summary
    // is the account's single subscription on the parent (deps.repo path skips
    // resolution — no MEMBERSHIP_WORKER — and reads the queried org as before).
    const [auth, billingOrgId] = await Promise.all([
      timings.measure("authz", () => authorizeBillingRead(env, actor, orgId, requestId)),
      timings.measure("resolve", () => resolveBillingOrgHex(env, orgId, requestId)),
    ]);

    if (!auth.ok) {
      endTotal();
      return withTimings(auth.response, requestId, "billing.summary", timings);
    }

    const result = await timings.measure("db", () => repo.getBillingSummary(billingOrgId));
    if (!result.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Failed to get billing summary", 503, requestId), requestId, "billing.summary", timings);
    }

    const { customer, activeSubscription, plan, entitlements } = result.value;
    const body: GetBillingSummaryResponse = {
      customer: customer ? mapBillingCustomerToPublic(customer) : null,
      activeSubscription: activeSubscription ? mapSubscriptionToPublic(activeSubscription) : null,
      plan: plan ? mapPlanToPublic(plan) : null,
      entitlements: entitlements.map(mapEntitlementToPublic),
    };
    endTotal();
    return withTimings(successResponse(body, requestId), requestId, "billing.summary", timings);
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Failed to get billing summary", 503, requestId), requestId, "billing.summary", timings);
  } finally {
    if (executor) await executor.dispose();
  }
}
