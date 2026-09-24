import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { GetEntitlementsResponse, PublicEntitlementSource } from "@saas/contracts/billing";
import type { EntitlementSource, ListEntitlementsQuery } from "@saas/db/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeBillingRead } from "../policy.js";
import { mapEntitlementToPublic } from "../mappers.js";
import { parseSubscriptionPublicId } from "../ids.js";

const VALID_SOURCE: ReadonlySet<PublicEntitlementSource> = new Set(["plan", "override"]);

export async function handleListEntitlements(
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

  let source: EntitlementSource | undefined;
  const rawSource = url.searchParams.get("source");
  if (rawSource) {
    if (!VALID_SOURCE.has(rawSource as PublicEntitlementSource)) {
      return validationError(requestId, "source must be 'plan' or 'override'");
    }
    source = rawSource as EntitlementSource;
  }

  let subscriptionId: string | undefined;
  const rawSub = url.searchParams.get("subscriptionId");
  if (rawSub) {
    const parsed = parseSubscriptionPublicId(rawSub);
    if (!parsed) {
      return validationError(requestId, "invalid subscriptionId");
    }
    subscriptionId = parsed;
  }

  const query: ListEntitlementsQuery = {
    orgId,
    ...(source ? { source } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
  };

  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createBillingRepository(executor);
  try {
    // PERF12: authorization and the read are independent — run concurrently,
    // then apply the decision. On deny the speculatively read entitlements are
    // discarded (deny-by-default), exactly as the PERF4 hot reads do.
    const [auth, result] = await Promise.all([
      authorizeBillingRead(env, actor, orgId, requestId),
      repo.listEntitlements(query),
    ]);
    if (!auth.ok) return auth.response;
    if (!result.ok) {
      return errorResponse("internal_error", "Failed to list entitlements", 503, requestId);
    }

    const body: GetEntitlementsResponse = { entitlements: result.value.map(mapEntitlementToPublic) };
    return successResponse(body, requestId);
  } catch {
    return errorResponse("internal_error", "Failed to list entitlements", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
