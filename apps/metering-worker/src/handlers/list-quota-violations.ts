import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PublicQuotaViolation } from "@saas/contracts/metering";
import type { PolicyResource } from "@saas/contracts/policy";
import type { QuotaViolation } from "@saas/db/metering";
import { createSqlExecutor } from "@saas/db/d1";
import { createMeteringRepository } from "@saas/db/metering";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { listResponse, errorResponse, validationError } from "../http.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function mapViolationToPublic(v: QuotaViolation): PublicQuotaViolation {
  return {
    id: v.id,
    orgId: v.orgId,
    projectId: v.projectId,
    environmentId: v.environmentId,
    resourceId: v.resourceId,
    quotaId: v.quotaId,
    metric: v.metric,
    limitValue: v.limitValue,
    actualValue: v.actualValue,
    period: v.period,
    enforcement: v.enforcement,
    violatedAt: v.violatedAt.toISOString(),
    resolvedAt: v.resolvedAt?.toISOString() ?? null,
    metadata: v.metadata,
    createdAt: v.createdAt.toISOString(),
  };
}

export async function handleListQuotaViolations(
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

  // Parse pagination
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return validationError(requestId, `limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    limit = parsed;
  }

  const rawCursor = url.searchParams.get("cursor");
  let cursor: { createdAt: string; id: string } | null = null;
  if (rawCursor) {
    try {
      const decoded = JSON.parse(atob(rawCursor));
      if (decoded && typeof decoded.createdAt === "string" && typeof decoded.id === "string") {
        cursor = decoded;
      } else {
        return validationError(requestId, "Invalid cursor format");
      }
    } catch {
      return validationError(requestId, "Invalid cursor encoding");
    }
  }

  // Parse optional filters
  const projectId = url.searchParams.get("projectId");
  const environmentId = url.searchParams.get("environmentId");
  const resourceId = url.searchParams.get("resourceId");
  const metric = url.searchParams.get("metric");

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

  // Query violations
  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createMeteringRepository(executor);

  const result = await repo.listQuotaViolations(
    {
      orgId,
      ...(projectId != null ? { projectId } : {}),
      ...(environmentId != null ? { environmentId } : {}),
      ...(resourceId != null ? { resourceId } : {}),
      ...(metric != null ? { metric } : {}),
    },
    { limit, cursor },
  );

  if (!result.ok) {
    return errorResponse("internal_error", "Failed to list quota violations", 500, requestId);
  }

  const violations = result.value.items.map(mapViolationToPublic);
  const nextCursor = result.value.nextCursor
    ? btoa(JSON.stringify(result.value.nextCursor))
    : null;

  return listResponse(
    { violations },
    requestId,
    nextCursor,
  );
}
