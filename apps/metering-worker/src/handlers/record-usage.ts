import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { RecordUsageRequest, RecordUsageResponse, PublicUsageRecord } from "@saas/contracts/metering";
import type { PolicyResource } from "@saas/contracts/policy";
import type { UsageRecord } from "@saas/db/metering";
import { createSqlExecutor } from "@saas/db/d1";
import { createMeteringRepository } from "@saas/db/metering";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { generateUsageRecordId, parseProjectPublicId, parseEnvironmentPublicId } from "../ids.js";
import { validateMetadata } from "../metadata.js";

function mapToPublic(r: UsageRecord): PublicUsageRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    projectId: r.projectId,
    environmentId: r.environmentId,
    resourceId: r.resourceId,
    metric: r.metric,
    quantity: r.quantity,
    idempotencyKey: r.idempotencyKey,
    recordedAt: r.recordedAt.toISOString(),
    metadata: r.metadata,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function handleRecordUsage(
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

  const input = body as RecordUsageRequest;

  if (!input.metric || typeof input.metric !== "string") {
    return validationError(requestId, "metric is required and must be a string");
  }

  if (!input.idempotencyKey || typeof input.idempotencyKey !== "string") {
    return validationError(requestId, "idempotencyKey is required and must be a string");
  }

  if (input.quantity !== undefined && (typeof input.quantity !== "number" || input.quantity < 0)) {
    return validationError(requestId, "quantity must be a non-negative number");
  }

  // Validate project/environment scope - environmentId requires projectId
  let projectId: string | null = null;
  let environmentId: string | null = null;

  if (input.projectId) {
    projectId = parseProjectPublicId(input.projectId);
    if (!projectId) {
      return validationError(requestId, "Invalid projectId format");
    }
  }

  if (input.environmentId) {
    if (!projectId) {
      return validationError(requestId, "environmentId requires projectId");
    }
    environmentId = parseEnvironmentPublicId(input.environmentId);
    if (!environmentId) {
      return validationError(requestId, "Invalid environmentId format");
    }
  }

  // Validate metadata
  const metaResult = validateMetadata(input.metadata);
  if (!metaResult.ok) {
    return validationError(requestId, metaResult.message);
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

  const action = projectId ? "organization.metering.write" : "organization.metering.write";
  const resource: PolicyResource = { kind: "organization", orgId, ...(projectId ? { projectId } : {}) };

  const authResult = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    action,
    resource,
    contextResult.memberships,
    requestId,
  );

  if (!authResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  // Record usage
  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createMeteringRepository(executor);

  const recordId = input.id || generateUsageRecordId();

  const result = await repo.recordUsage({
    id: recordId,
    orgId,
    projectId,
    environmentId,
    resourceId: input.resourceId ?? null,
    metric: input.metric,
    quantity: input.quantity ?? 1,
    idempotencyKey: input.idempotencyKey,
    ...(input.recordedAt ? { recordedAt: new Date(input.recordedAt) } : {}),
    metadata: metaResult.value,
  });

  if (!result.ok) {
    if (result.error.kind === "conflict") {
      return errorResponse("conflict", "Duplicate idempotency key", 409, requestId);
    }
    return errorResponse("internal_error", "Failed to record usage", 500, requestId);
  }

  const response: RecordUsageResponse = {
    usageRecord: mapToPublic(result.value),
  };

  return successResponse(response, requestId, 201);
}

export { mapToPublic };
