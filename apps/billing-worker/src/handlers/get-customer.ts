import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { GetBillingCustomerResponse } from "@saas/contracts/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { errorResponse, successResponse } from "../http.js";
import { authorizeBillingRead } from "../policy.js";
import { resolveBillingOrgHex } from "../billing-scope.js";
import { mapBillingCustomerToPublic } from "../mappers.js";

export async function handleGetBillingCustomer(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createBillingRepository(executor);
  try {
    // PERF12: authorization and the MO4 billing-parent resolution are
    // independent — run them concurrently. The read needs the resolved org, so
    // it follows the gate (no speculative read of customer data on deny).
    const [auth, billingOrgId] = await Promise.all([
      authorizeBillingRead(env, actor, orgId, requestId),
      resolveBillingOrgHex(env, orgId, requestId),
    ]);
    if (!auth.ok) return auth.response;

    const result = await repo.getBillingCustomer(billingOrgId);
    if (!result.ok) {
      if (result.error.kind === "not_found") {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      return errorResponse("internal_error", "Failed to get billing customer", 503, requestId);
    }

    const body: GetBillingCustomerResponse = { customer: mapBillingCustomerToPublic(result.value) };
    return successResponse(body, requestId);
  } catch {
    return errorResponse("internal_error", "Failed to get billing customer", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
