import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createWebhookRepository } from "@saas/db/webhooks";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, listResponse, validationError } from "../http.js";
import { toPublicWebhookSubscription } from "../mappers.js";
import { parsePageParams, encodeCursor } from "../pagination.js";
import { parseWebhookEndpointPublicId, parseProjectPublicId } from "../ids.js";
import type { Uuid } from "@saas/db/ids";
import type { PolicyResource } from "@saas/contracts/policy";
import type { UpdateWebhookSubscriptionInput } from "@saas/db/webhooks";

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

async function authorizeWebhook(
  env: Env,
  actor: ActorContext,
  orgId: string,
  projectId: string | null | undefined,
  action: "organization.webhook.read" | "organization.webhook.write" | "project.webhook.read" | "project.webhook.write",
  requestId: string,
): Promise<Response | null> {
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const resource: PolicyResource = projectId
    ? { kind: "project", orgId, projectId }
    : { kind: "organization", orgId };

  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    action,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  return null;
}

// ── Create ───────────────────────────────────────────────────

export async function handleCreateWebhookSubscription(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be a JSON object"] });
  }

  const { endpointId: rawEndpointId, eventType, enabled, projectId } = body as {
    endpointId?: unknown; eventType?: unknown; enabled?: unknown; projectId?: unknown;
  };
  const fields: Record<string, string[]> = {};

  if (typeof rawEndpointId !== "string") {
    fields.endpointId = ["endpointId is required"];
  }
  if (typeof eventType !== "string" || eventType.length === 0 || eventType.length > 255) {
    fields.eventType = ["A valid eventType is required"];
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    fields.enabled = ["Enabled must be a boolean"];
  }
  if (projectId !== undefined && projectId !== null && typeof projectId !== "string") {
    fields.projectId = ["Project ID must be a string or null"];
  }
  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  const endpointUuid = parseWebhookEndpointPublicId(rawEndpointId as string);
  if (!endpointUuid) {
    return validationError(requestId, { endpointId: ["Invalid endpoint ID format"] });
  }

  // webhook_subscriptions.project_id is a UUID column; decode the public
  // `prj_<hex>` form and reject invalid ids instead of binding the raw string.
  let resolvedProjectId: Uuid | null = null;
  if (typeof projectId === "string") {
    const parsed = parseProjectPublicId(projectId);
    if (!parsed) return validationError(requestId, { projectId: ["Invalid project id"] });
    resolvedProjectId = parsed;
  }

  const policyAction = resolvedProjectId
    ? "project.webhook.write" as const
    : "organization.webhook.write" as const;
  const denied = await authorizeWebhook(env, actor, orgId, resolvedProjectId, policyAction, requestId);
  if (denied) return denied;

  const subscriptionId = crypto.randomUUID();

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);

    const result = await repo.createSubscription({
      id: subscriptionId,
      orgId,
      endpointId: endpointUuid,
      projectId: resolvedProjectId,
      eventType: eventType as string,
      enabled: (enabled as boolean) ?? true,
    });

    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "Webhook subscription already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await eventsRepo.appendEventWithAudit({
      event: {
        id: randomHex(16),
        type: "webhook_subscription.created",
        version: 1,
        source: "webhooks-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: resolvedProjectId,
        subjectKind: "webhook_subscription",
        subjectId: subscriptionId,
        requestId,
        payload: { endpointId: rawEndpointId, eventType },
      },
      audit: {
        id: randomHex(16),
        category: "webhooks",
        description: `Webhook subscription created: ${eventType as string}`,
        projectId: resolvedProjectId,
      },
    });

    return successResponse({ subscription: toPublicWebhookSubscription(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── Get ──────────────────────────────────────────────────────

export async function handleGetWebhookSubscription(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  subscriptionId: string,
): Promise<Response> {
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const result = await repo.getSubscription(orgId, subscriptionId);
    if (!result.ok) {
      return errorResponse("not_found", "Webhook subscription not found", 404, requestId);
    }

    const policyAction = result.value.projectId
      ? "project.webhook.read" as const
      : "organization.webhook.read" as const;
    const denied = await authorizeWebhook(env, actor, orgId, result.value.projectId, policyAction, requestId);
    if (denied) return denied;

    return successResponse({ subscription: toPublicWebhookSubscription(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── List ─────────────────────────────────────────────────────

export async function handleListWebhookSubscriptions(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  endpointId: string,
): Promise<Response> {
  const denied = await authorizeWebhook(env, actor, orgId, null, "organization.webhook.read", requestId);
  if (denied) return denied;

  const pageResult = parsePageParams(new URL(request.url));
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }

  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const result = await repo.listSubscriptions(orgId, endpointId, { limit, cursor: dbCursor });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const subscriptions = result.value.items.map(toPublicWebhookSubscription);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return listResponse({ subscriptions }, requestId, nextCursor);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── Update ───────────────────────────────────────────────────

export async function handleUpdateWebhookSubscription(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  subscriptionId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be a JSON object"] });
  }

  const { enabled } = body as { enabled?: unknown };
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return validationError(requestId, { enabled: ["Enabled must be a boolean"] });
  }

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);

    const existing = await repo.getSubscription(orgId, subscriptionId);
    if (!existing.ok) {
      return errorResponse("not_found", "Webhook subscription not found", 404, requestId);
    }

    const policyAction = existing.value.projectId
      ? "project.webhook.write" as const
      : "organization.webhook.write" as const;
    const denied = await authorizeWebhook(env, actor, orgId, existing.value.projectId, policyAction, requestId);
    if (denied) return denied;

    const input: UpdateWebhookSubscriptionInput = {};
    if (typeof enabled === "boolean") input.enabled = enabled;

    const result = await repo.updateSubscription(orgId, subscriptionId, input);
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await eventsRepo.appendEventWithAudit({
      event: {
        id: randomHex(16),
        type: "webhook_subscription.updated",
        version: 1,
        source: "webhooks-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: existing.value.projectId,
        subjectKind: "webhook_subscription",
        subjectId: subscriptionId,
        requestId,
        payload: { enabled },
      },
      audit: {
        id: randomHex(16),
        category: "webhooks",
        description: "Webhook subscription updated",
        projectId: existing.value.projectId,
      },
    });

    return successResponse({ subscription: toPublicWebhookSubscription(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── Delete ───────────────────────────────────────────────────

export async function handleDeleteWebhookSubscription(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  subscriptionId: string,
): Promise<Response> {
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);

    const existing = await repo.getSubscription(orgId, subscriptionId);
    if (!existing.ok) {
      return errorResponse("not_found", "Webhook subscription not found", 404, requestId);
    }

    const policyAction = existing.value.projectId
      ? "project.webhook.write" as const
      : "organization.webhook.write" as const;
    const denied = await authorizeWebhook(env, actor, orgId, existing.value.projectId, policyAction, requestId);
    if (denied) return denied;

    const result = await repo.deleteSubscription(orgId, subscriptionId);
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await eventsRepo.appendEventWithAudit({
      event: {
        id: randomHex(16),
        type: "webhook_subscription.deleted",
        version: 1,
        source: "webhooks-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: existing.value.projectId,
        subjectKind: "webhook_subscription",
        subjectId: subscriptionId,
        requestId,
        payload: { eventType: existing.value.eventType },
      },
      audit: {
        id: randomHex(16),
        category: "webhooks",
        description: "Webhook subscription deleted",
        projectId: existing.value.projectId,
      },
    });

    return successResponse({ deleted: true }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
