import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { CheckQuotaRequest, CheckQuotaResponse } from "@saas/contracts/metering";
import type { PolicyResource } from "@saas/contracts/policy";
import { createSqlExecutor } from "@saas/db/d1";
import { createMeteringRepository } from "@saas/db/metering";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";

export async function handleCheckQuota(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, "Invalid JSON body");
  }

  if (!body || typeof body !== "object") {
    return validationError(requestId, "Request body must be an object");
  }

  const input = body as CheckQuotaRequest;

  if (!input.metric || typeof input.metric !== "string") {
    return validationError(requestId, "metric is required and must be a string");
  }

  // Authorization
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );

  if (!contextResult.ok) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const resource: PolicyResource = { kind: "organization", orgId };

  const authResult = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    "organization.metering.read",
    resource,
    contextResult.memberships,
    requestId,
  );

  if (!authResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  // Check quota
  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createMeteringRepository(executor);

  const result = await repo.checkQuota(orgId, input.metric, {
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
  });

  if (!result.ok) {
    return errorResponse("internal_error", "Failed to check quota", 500, requestId);
  }

  const response: CheckQuotaResponse = result.value;

  return successResponse(response, requestId);
}
