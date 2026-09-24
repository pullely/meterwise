import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { GetUsageSummaryResponse, PublicUsageRollup } from "@saas/contracts/metering";
import type { PolicyResource } from "@saas/contracts/policy";
import type { UsageRollup, BucketType } from "@saas/db/metering";
import { createSqlExecutor } from "@saas/db/d1";
import { createMeteringRepository } from "@saas/db/metering";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseProjectPublicId, parseEnvironmentPublicId } from "../ids.js";

function mapRollupToPublic(r: UsageRollup): PublicUsageRollup {
  return {
    id: r.id,
    orgId: r.orgId,
    projectId: r.projectId,
    environmentId: r.environmentId,
    metric: r.metric,
    bucketType: r.bucketType,
    bucketStart: r.bucketStart.toISOString(),
    quantity: r.quantity,
    recordCount: r.recordCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function handleGetUsageSummary(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  const url = new URL(request.url);
  const metric = url.searchParams.get("metric");

  if (!metric) {
    return validationError(requestId, "metric query parameter is required");
  }

  let projectId: string | null = null;
  let environmentId: string | null = null;
  const rawProjectId = url.searchParams.get("projectId");
  const rawEnvironmentId = url.searchParams.get("environmentId");

  if (rawProjectId) {
    projectId = parseProjectPublicId(rawProjectId);
    if (!projectId) {
      return validationError(requestId, "Invalid projectId format");
    }
  }

  if (rawEnvironmentId) {
    if (!projectId) {
      return validationError(requestId, "environmentId requires projectId");
    }
    environmentId = parseEnvironmentPublicId(rawEnvironmentId);
    if (!environmentId) {
      return validationError(requestId, "Invalid environmentId format");
    }
  }

  const bucketType = url.searchParams.get("bucketType") as BucketType | null;
  if (bucketType && bucketType !== "hour" && bucketType !== "day") {
    return validationError(requestId, "bucketType must be 'hour' or 'day'");
  }

  const startTime = url.searchParams.get("startTime");
  const endTime = url.searchParams.get("endTime");

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

  const resource: PolicyResource = { kind: "organization", orgId, ...(projectId ? { projectId } : {}) };

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

  // Query usage summary
  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createMeteringRepository(executor);

  const result = await repo.getUsageSummary({
    orgId,
    metric,
    projectId,
    environmentId,
    ...(bucketType ? { bucketType } : {}),
    ...(startTime ? { startTime: new Date(startTime) } : {}),
    ...(endTime ? { endTime: new Date(endTime) } : {}),
  });

  if (!result.ok) {
    return errorResponse("internal_error", "Failed to get usage summary", 500, requestId);
  }

  const response: GetUsageSummaryResponse = {
    metric: result.value.metric,
    totalQuantity: result.value.totalQuantity,
    totalRecords: result.value.totalRecords,
    rollups: result.value.rollups.map(mapRollupToPublic),
  };

  return successResponse(response, requestId);
}
