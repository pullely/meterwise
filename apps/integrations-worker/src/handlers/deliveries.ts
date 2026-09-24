// Delivery log + replay (design §6): the console-facing window into the
// inbox. Safe projection only — raw payloads stay admin-visible. Replay
// re-runs attribute/normalize/emit from the PERSISTED row; it never
// re-trusts the wire.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import {
  INTEGRATION_POLICY_ACTIONS,
  type ListInboundDeliveriesResponse,
  type ReplayInboundDeliveryResponse,
} from "@saas/contracts/integrations";
import { createIntegrationsRepository } from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import type { Uuid } from "@saas/db/ids";
import type { SqlExecutor } from "@saas/db/d1";
import type { FetchLike } from "../github-app.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, listResponse, successResponse } from "../http.js";
import { toPublicInboundDelivery } from "../mappers.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { processDelivery } from "../drain.js";

export interface DeliveriesDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

async function authorizeDeliveries(
  env: Env,
  actor: ActorContext,
  orgId: string,
  action: string,
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

export async function handleListDeliveries(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: DeliveriesDeps,
): Promise<Response> {
  const denied = await authorizeDeliveries(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.READ,
    requestId,
  );
  if (denied) return denied;

  const page = parsePageParams(new URL(request.url));
  if (!page.ok) {
    return errorResponse("validation_failed", "Validation failed", 422, requestId, {
      fields: { [page.field]: [page.reason] },
    });
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    // Connection must exist in this org — the delivery log is connection-scoped.
    const connection = await repo.getConnection(orgId, connectionId);
    if (!connection.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const result = await repo.listInboundDeliveries(
      orgId,
      {
        limit: page.value.limit,
        cursor: page.value.cursor
          ? { createdAt: page.value.cursor.createdAt, id: page.value.cursor.id }
          : null,
      },
      { connectionId },
    );
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const payload: ListInboundDeliveriesResponse = {
      deliveries: result.value.items.map(toPublicInboundDelivery),
      nextCursor: result.value.nextCursor,
    };
    const cursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;
    return listResponse(payload, requestId, cursor);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}

export async function handleReplayDelivery(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deliveryId: Uuid,
  deps?: DeliveriesDeps,
): Promise<Response> {
  const denied = await authorizeDeliveries(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.MANAGE,
    requestId,
  );
  if (denied) return denied;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await repo.getConnection(orgId, connectionId);
    if (!connection.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const delivery = await repo.getInboundDelivery(deliveryId);
    if (!delivery.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    // Tenancy: the delivery must already belong to this org's connection (or
    // be unattributed traffic for the same installation — those re-attribute
    // through processDelivery and are still bounded by the installation row).
    if (delivery.value.orgId !== null && delivery.value.orgId !== orgId) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    if (delivery.value.connectionId !== null && delivery.value.connectionId !== connectionId) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    await processDelivery(
      {
        executor,
        repo,
        events: createEventsRepository(executor),
        now: () => new Date(),
      },
      delivery.value,
    );

    const after = await repo.getInboundDelivery(deliveryId);
    if (!after.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const payload: ReplayInboundDeliveryResponse = {
      delivery: toPublicInboundDelivery(after.value),
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
