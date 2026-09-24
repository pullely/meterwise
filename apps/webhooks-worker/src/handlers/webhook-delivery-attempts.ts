import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createWebhookRepository } from "@saas/db/webhooks";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, listResponse, validationError, withTimings } from "../http.js";
import { createTimings } from "@saas/contracts/timing";
import { toPublicDeliveryAttempt } from "../mappers.js";
import { parsePageParams, encodeCursor } from "../pagination.js";
import { replayDeliveryAttempt } from "../delivery.js";
import { createEncryptionAdapter } from "../encryption.js";
import type { PolicyResource } from "@saas/contracts/policy";

async function authorizeWebhookRead(
  env: Env,
  actor: ActorContext,
  orgId: string,
  requestId: string,
): Promise<Response | null> {
  return authorizeWebhookAction(env, actor, orgId, "organization.webhook.read", requestId);
}

/**
 * Org-scoped deny-by-default authorization for a webhook delivery-attempt
 * action. Mirrors the sibling delivery-attempt read authz (membership context
 * → policy check → 404-on-deny to avoid leaking existence), parameterized on
 * the policy action so the mutating replay path can demand
 * `organization.webhook.write` while the GETs keep `organization.webhook.read`.
 */
async function authorizeWebhookAction(
  env: Env,
  actor: ActorContext,
  orgId: string,
  action: "organization.webhook.read" | "organization.webhook.write",
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

  const resource: PolicyResource = { kind: "organization", orgId };

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

// ── Get ──────────────────────────────────────────────────────

export async function handleGetDeliveryAttempt(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  attemptId: string,
): Promise<Response> {
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  // PERF14b: phase timings — `authz` and `db` run concurrently (PERF12c), so
  // their overlap is directly visible in the Server-Timing breakdown.
  const timings = createTimings();
  const endTotal = timings.start("total");
  const route = "webhooks.attempts.get";
  try {
    const repo = createWebhookRepository(executor);
    // PERF12: org-scoped authz and the read are independent — run concurrently,
    // discard the speculatively read attempt on deny (deny-by-default).
    const [denied, result] = await Promise.all([
      timings.measure("authz", () => authorizeWebhookRead(env, actor, orgId, requestId)),
      timings.measure("db", () => repo.getDeliveryAttempt(orgId, attemptId)),
    ]);
    endTotal();
    if (denied) return withTimings(denied, requestId, route, timings);
    if (!result.ok) {
      return withTimings(errorResponse("not_found", "Delivery attempt not found", 404, requestId), requestId, route, timings);
    }

    return withTimings(successResponse({ deliveryAttempt: toPublicDeliveryAttempt(result.value) }, requestId), requestId, route, timings);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── List ─────────────────────────────────────────────────────

export async function handleListDeliveryAttempts(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  endpointId: string,
): Promise<Response> {
  const pageResult = parsePageParams(new URL(request.url));
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }

  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  // PERF14b: phase timings — `authz` and `db` run concurrently (PERF12c), so
  // their overlap is directly visible in the Server-Timing breakdown.
  const timings = createTimings();
  const endTotal = timings.start("total");
  const route = "webhooks.attempts.list";
  try {
    const repo = createWebhookRepository(executor);
    // PERF12: org-scoped authz and the read are independent — run concurrently,
    // discard the speculatively read attempts on deny (deny-by-default).
    const [denied, result] = await Promise.all([
      timings.measure("authz", () => authorizeWebhookRead(env, actor, orgId, requestId)),
      timings.measure("db", () => repo.listDeliveryAttempts(orgId, endpointId, { limit, cursor: dbCursor })),
    ]);
    endTotal();
    if (denied) return withTimings(denied, requestId, route, timings);
    if (!result.ok) {
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, route, timings);
    }

    const deliveryAttempts = result.value.items.map(toPublicDeliveryAttempt);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return withTimings(listResponse({ deliveryAttempts }, requestId, nextCursor), requestId, route, timings);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── Replay ───────────────────────────────────────────────────

/**
 * POST /v1/organizations/:orgId/webhooks/delivery-attempts/:id/replay
 *
 * Manually replay a past delivery attempt: re-send the SAME event to the SAME
 * endpoint through the existing signing/delivery seam, recording a fresh
 * attempt in history. Requires `organization.webhook.write` (replay triggers an
 * outbound delivery, a mutating side-effect — unlike the read-only GETs).
 *
 * Flow:
 *   1. Authorize (write); deny → 404 to avoid leaking existence.
 *   2. Load the original attempt; 404 if absent / wrong org.
 *   3. Rehydrate the full original event by id (best-effort — a missing event
 *      degrades to `data:{}`, same as the auto-retry path, rather than failing).
 *   4. Delegate to `replayDeliveryAttempt`, which creates a fresh attempt with a
 *      replay-distinct idempotency key and delivers it through the single
 *      `deliverAttempt` chokepoint (endpoint-disabled gating, signing, retry,
 *      lifecycle events, and auto-disable all inherited unchanged).
 *   5. Return the new `PublicWebhookDeliveryAttempt` (201 Created — a new
 *      delivery-attempt resource was created).
 *
 * No secret material, ciphertext, or raw event payload is ever returned: the
 * response carries only the safe public delivery-attempt projection.
 */
export async function handleReplayDeliveryAttempt(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  attemptId: string,
): Promise<Response> {
  const denied = await authorizeWebhookAction(env, actor, orgId, "organization.webhook.write", requestId);
  if (denied) return denied;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);

    const original = await repo.getDeliveryAttempt(orgId, attemptId);
    if (!original.ok) {
      return errorResponse("not_found", "Delivery attempt not found", 404, requestId);
    }

    // Rehydrate the full original event payload by id (best-effort). A missing
    // or unreadable event degrades to `data:{}` rather than failing the replay.
    let event = null;
    const eventResult = await eventsRepo.getEventById(orgId, original.value.eventId);
    if (eventResult.ok) {
      event = eventResult.value;
    }

    const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
    const ctx = { webhookRepo: repo, eventsRepo, encryption };

    const replayResult = await replayDeliveryAttempt(ctx, original.value, event);
    if (!replayResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse(
      { deliveryAttempt: toPublicDeliveryAttempt(replayResult.value) },
      requestId,
      201,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
