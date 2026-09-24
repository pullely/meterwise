import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ListPlansResponse, PublicPlanStatus } from "@saas/contracts/billing";
import type { PlanStatus } from "@saas/db/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeBillingRead } from "../policy.js";
import { mapPlanToPublic } from "../mappers.js";

const VALID_STATUS: ReadonlySet<PublicPlanStatus> = new Set(["active", "archived"]);

export async function handleListPlans(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  let status: PlanStatus | undefined;
  if (rawStatus) {
    if (!VALID_STATUS.has(rawStatus as PublicPlanStatus)) {
      return validationError(requestId, "status must be 'active' or 'archived'");
    }
    status = rawStatus as PlanStatus;
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createBillingRepository(executor);
  try {
    // PERF12: authorization (membership + policy) and the read are independent —
    // run them concurrently, then apply the decision. On deny the speculatively
    // read plans are discarded (deny-by-default; the plan catalog is non-sensitive).
    const [auth, result] = await Promise.all([
      authorizeBillingRead(env, actor, orgId, requestId),
      repo.listPlans(status ? { status } : {}),
    ]);
    if (!auth.ok) return auth.response;
    if (!result.ok) {
      return errorResponse("internal_error", "Failed to list plans", 503, requestId);
    }

    const body: ListPlansResponse = { plans: result.value.map(mapPlanToPublic) };
    return successResponse(body, requestId);
  } catch {
    return errorResponse("internal_error", "Failed to list plans", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
