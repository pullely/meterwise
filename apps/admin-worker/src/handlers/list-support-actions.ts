import type { Env } from "../env.js";
import type { SupportActor } from "../support-auth.js";
import type { SupportRepository, StoredSupportActionRecord } from "@saas/db/support";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createSupportRepository } from "@saas/db/support";
import { authorizeSupportAction } from "../support-auth.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { supportActionPublicId, parseOrgPublicId, generateSupportActionUuid } from "../ids.js";
import { parseSupportPageParams, encodeSupportCursor } from "../pagination.js";
import { emitAccessDenied } from "./record-support-action.js";
import type { SupportRequestContext } from "./record-support-action.js";

// Test seam. When provided, the handler runs against an injected repo (no DB).
export interface ListSupportActionsDeps {
  supportRepo: Pick<SupportRepository, "listSupportActions">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
}

function publicRecord(rec: StoredSupportActionRecord): Record<string, unknown> {
  return {
    id: supportActionPublicId(rec.id),
    actorId: rec.actorId,
    actorType: rec.actorType,
    targetOrgId: rec.targetOrgId,
    action: rec.action,
    reason: rec.reason,
    requestId: rec.requestId,
    metadata: rec.metadata,
    occurredAt: rec.occurredAt.toISOString(),
    createdAt: rec.createdAt.toISOString(),
  };
}

export async function handleListSupportActions(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  targetOrgIdParam: string,
  url?: URL,
  deps?: ListSupportActionsDeps,
): Promise<Response> {
  const targetOrgUuid = parseOrgPublicId(targetOrgIdParam);
  if (!targetOrgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const genId = deps?.generateId ?? (() => generateSupportActionUuid());

  // Deny-by-default authorization. Reading the support ledger is itself a
  // support action and must fail closed + audit the denial.
  const decision = authorizeSupportAction({
    actor: ctx.actor,
    supportRoleClaim: ctx.supportRoleClaim,
    systemOverride: ctx.systemOverride,
  });

  if (!decision.allow) {
    const denialActor: SupportActor = ctx.actor ?? { subjectId: "anonymous", subjectType: "user" };
    const denialInput = {
      actor: denialActor,
      targetOrgId: targetOrgUuid,
      attemptedAction: "support.actions.list",
      reason: decision.reason,
      requestId,
      occurredAt: now,
      genId,
    };
    // In the injected-deps (unit test) path, route the denial audit through the
    // injected events repo; otherwise the production best-effort path is used.
    if (deps?.eventsRepo) {
      await emitAccessDenied(env, { ...denialInput, deps: { supportRepo: {} as never, eventsRepo: deps.eventsRepo } });
    } else {
      await emitAccessDenied(env, denialInput);
    }
    return errorResponse("forbidden", "Support action denied", 403, requestId, { reason: decision.reason });
  }

  let pageParams = { limit: 50, cursor: null as { occurredAt: string; id: string } | null };
  if (url) {
    const pageResult = parseSupportPageParams(url);
    if (!pageResult.ok) {
      return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
    }
    pageParams = pageResult.value;
  }

  // Injected-deps (unit test) path.
  if (deps) {
    const listResult = await deps.supportRepo.listSupportActions(targetOrgUuid, pageParams);
    if (!listResult.ok) {
      return errorResponse("internal_error", "Failed to list support actions", 500, requestId);
    }
    const { items, nextCursor } = listResult.value;
    const cursorToken = nextCursor ? encodeSupportCursor(nextCursor.occurredAt, nextCursor.id) : null;
    return successResponse({ supportActions: items.map(publicRecord) }, requestId, 200, cursorToken);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createSupportRepository(executor);
    const listResult = await repo.listSupportActions(targetOrgUuid, pageParams);
    if (!listResult.ok) {
      return errorResponse("internal_error", "Failed to list support actions", 500, requestId);
    }
    const { items, nextCursor } = listResult.value;
    const cursorToken = nextCursor ? encodeSupportCursor(nextCursor.occurredAt, nextCursor.id) : null;
    return successResponse({ supportActions: items.map(publicRecord) }, requestId, 200, cursorToken);
  } catch {
    return errorResponse("internal_error", "Failed to list support actions", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
