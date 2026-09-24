import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { IngestUsageBatchRequest, IngestUsageBatchResponse } from "@saas/contracts/metering";
import type { PolicyResource } from "@saas/contracts/policy";
import type { RecordUsageInput } from "@saas/db/metering";
import { createSqlExecutor } from "@saas/db/d1";
import { createMeteringRepository } from "@saas/db/metering";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { generateUsageRecordId, parseProjectPublicId, parseEnvironmentPublicId } from "../ids.js";
import { validateMetadata } from "../metadata.js";
import { mapToPublic } from "./record-usage.js";

const MAX_BATCH_SIZE = 100;

export async function handleIngestBatch(
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

  const input = body as IngestUsageBatchRequest;

  if (!Array.isArray(input.records) || input.records.length === 0) {
    return validationError(requestId, "records must be a non-empty array");
  }

  if (input.records.length > MAX_BATCH_SIZE) {
    return validationError(requestId, `Batch size exceeds maximum of ${MAX_BATCH_SIZE}`);
  }

  // Validate all records first
  const inputs: RecordUsageInput[] = [];
  for (let i = 0; i < input.records.length; i++) {
    const rec = input.records[i]!;
    if (!rec.metric || typeof rec.metric !== "string") {
      return validationError(requestId, `records[${i}].metric is required and must be a string`);
    }
    if (!rec.idempotencyKey || typeof rec.idempotencyKey !== "string") {
      return validationError(requestId, `records[${i}].idempotencyKey is required and must be a string`);
    }
    if (rec.quantity !== undefined && (typeof rec.quantity !== "number" || rec.quantity < 0)) {
      return validationError(requestId, `records[${i}].quantity must be a non-negative number`);
    }

    let projectId: string | null = null;
    let environmentId: string | null = null;

    if (rec.projectId) {
      projectId = parseProjectPublicId(rec.projectId);
      if (!projectId) {
        return validationError(requestId, `records[${i}].projectId has invalid format`);
      }
    }
    if (rec.environmentId) {
      if (!projectId) {
        return validationError(requestId, `records[${i}].environmentId requires projectId`);
      }
      environmentId = parseEnvironmentPublicId(rec.environmentId);
      if (!environmentId) {
        return validationError(requestId, `records[${i}].environmentId has invalid format`);
      }
    }

    const metaResult = validateMetadata(rec.metadata);
    if (!metaResult.ok) {
      return validationError(requestId, `records[${i}].metadata: ${metaResult.message}`);
    }

    inputs.push({
      id: rec.id || generateUsageRecordId(),
      orgId,
      projectId,
      environmentId,
      resourceId: rec.resourceId ?? null,
      metric: rec.metric,
      quantity: rec.quantity ?? 1,
      idempotencyKey: rec.idempotencyKey,
      ...(rec.recordedAt ? { recordedAt: new Date(rec.recordedAt) } : {}),
      metadata: metaResult.value,
    });
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
    "organization.metering.write",
    resource,
    contextResult.memberships,
    requestId,
  );

  if (!authResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  // Ingest batch
  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createMeteringRepository(executor);

  const batchResult = await repo.ingestUsageBatch(inputs);

  if (!batchResult.ok) {
    return errorResponse("internal_error", "Failed to ingest batch", 500, requestId);
  }

  const response: IngestUsageBatchResponse = {
    results: batchResult.value.results.map((r) => {
      if (r.ok) {
        return { ok: true as const, usageRecord: mapToPublic(r.value) };
      }
      return { ok: false as const, error: { kind: r.error.kind, message: r.error.kind === "conflict" ? "Duplicate idempotency key" : "Internal error" } };
    }),
  };

  return successResponse(response, requestId);
}
