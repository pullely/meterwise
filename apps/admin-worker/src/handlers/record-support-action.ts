import type { Env } from "../env.js";
import type { SupportActor } from "../support-auth.js";
import type { SupportRepository, StoredSupportActionRecord } from "@saas/db/support";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createSupportRepository } from "@saas/db/support";
import { createEventsRepository } from "@saas/db/events";
import { authorizeSupportAction } from "../support-auth.js";
import { appendSupportEvent } from "../support-events.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { supportActionPublicId, generateSupportActionUuid, parseOrgPublicId } from "../ids.js";

// Request-level support context resolved by the router from headers + body.
export interface SupportRequestContext {
  actor: SupportActor | null;
  supportRoleClaim: string | null;
  systemOverride: boolean;
}

export interface RecordSupportActionBody {
  targetOrgId: string;
  action: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

// Test seam. When provided, the handler runs against injected repos (no DB) and
// the non-transactional path; production uses the D1 executor + a real
// transaction so the record write and the audit-event append commit together.
export interface RecordSupportActionDeps {
  supportRepo: Pick<SupportRepository, "recordSupportAction">;
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit">;
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

function validateBody(body: unknown): { value: RecordSupportActionBody } | { errors: Record<string, string[]> } {
  if (!body || typeof body !== "object") {
    return { errors: { body: ["must be an object"] } };
  }
  const b = body as Record<string, unknown>;
  const errors: Record<string, string[]> = {};

  if (typeof b.targetOrgId !== "string" || b.targetOrgId.length === 0) {
    errors.targetOrgId = ["must be a non-empty string"];
  }
  if (typeof b.action !== "string" || b.action.length === 0) {
    errors.action = ["must be a non-empty string"];
  }
  if (typeof b.reason !== "string" || b.reason.trim().length === 0) {
    errors.reason = ["must be a non-empty string"];
  }
  if (b.metadata != null && (typeof b.metadata !== "object" || Array.isArray(b.metadata))) {
    errors.metadata = ["must be an object"];
  }

  if (Object.keys(errors).length > 0) return { errors };
  return {
    value: {
      targetOrgId: b.targetOrgId as string,
      action: b.action as string,
      reason: b.reason as string,
      metadata: (b.metadata as Record<string, unknown> | undefined) ?? {},
    },
  };
}

export async function handleRecordSupportAction(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  rawBody: unknown,
  deps?: RecordSupportActionDeps,
): Promise<Response> {
  const validated = validateBody(rawBody);
  if ("errors" in validated) {
    return validationError(requestId, validated.errors);
  }
  const body = validated.value;

  const now = deps?.now ? deps.now() : new Date();
  const genId = deps?.generateId ?? (() => generateSupportActionUuid());

  // Deny-by-default authorization.
  const decision = authorizeSupportAction({
    actor: ctx.actor,
    supportRoleClaim: ctx.supportRoleClaim,
    systemOverride: ctx.systemOverride,
  });

  if (!decision.allow) {
    // Audit the denial. We still need a subject + org; use the requested target
    // org so the denial is attributable to what was attempted. If no actor is
    // present we attribute the denial to an anonymous support principal.
    const denialActor: SupportActor = ctx.actor ?? { subjectId: "anonymous", subjectType: "user" };
    const denialInput = {
      actor: denialActor,
      targetOrgId: body.targetOrgId,
      attemptedAction: body.action,
      reason: decision.reason,
      requestId,
      occurredAt: now,
      genId,
    };
    // exactOptionalPropertyTypes: only attach `deps` when actually present.
    await emitAccessDenied(env, deps ? { ...denialInput, deps } : denialInput);
    return errorResponse("forbidden", "Support action denied", 403, requestId, { reason: decision.reason });
  }

  // ---- Authorized path: persist the record + emit support.action_recorded ----

  // Injected-deps (unit test) path: non-transactional, sequential.
  if (deps) {
    const recordResult = await deps.supportRepo.recordSupportAction({
      id: genId(),
      actorId: decision.grant === "system_override" ? ctx.actor!.subjectId : ctx.actor!.subjectId,
      actorType: ctx.actor!.subjectType,
      targetOrgId: body.targetOrgId,
      action: body.action,
      reason: body.reason,
      requestId,
      metadata: body.metadata ?? {},
      occurredAt: now,
    });
    if (!recordResult.ok) {
      return errorResponse("internal_error", "Failed to record support action", 500, requestId);
    }
    const appended = await appendSupportEvent(
      deps.eventsRepo,
      {
        type: "support.action_recorded",
        actor: ctx.actor!,
        orgId: body.targetOrgId,
        subjectKind: "support_action",
        subjectId: recordResult.value.id,
        requestId,
        occurredAt: now,
        payload: {
          supportActionId: supportActionPublicId(recordResult.value.id),
          action: body.action,
          grant: decision.grant,
        },
        auditDescription: `Support action '${body.action}' recorded against ${body.targetOrgId}`,
      },
      genId,
    );
    if (!appended) {
      return errorResponse("internal_error", "Failed to record support action", 500, requestId);
    }
    return successResponse({ supportAction: publicRecord(recordResult.value) }, requestId, 201);
  }

  // Production path: requires DB.
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    // Write the support-action row and append the audit event inside one
    // transaction — they commit or roll back together (mirrors membership-worker
    // atomicity for write + event).
    const result = await executor.transaction(async (txExec) => {
      const txSupportRepo = createSupportRepository(txExec);
      const txEventsRepo = createEventsRepository(txExec);

      const recordResult = await txSupportRepo.recordSupportAction({
        id: genId(),
        actorId: ctx.actor!.subjectId,
        actorType: ctx.actor!.subjectType,
        targetOrgId: body.targetOrgId,
        action: body.action,
        reason: body.reason,
        requestId,
        metadata: body.metadata ?? {},
        occurredAt: now,
      });
      if (!recordResult.ok) {
        return { recordResult };
      }

      const appended = await appendSupportEvent(
        txEventsRepo,
        {
          type: "support.action_recorded",
          actor: ctx.actor!,
          orgId: body.targetOrgId,
          subjectKind: "support_action",
          subjectId: recordResult.value.id,
          requestId,
          occurredAt: now,
          payload: {
            supportActionId: supportActionPublicId(recordResult.value.id),
            action: body.action,
            grant: decision.grant,
          },
          auditDescription: `Support action '${body.action}' recorded against ${body.targetOrgId}`,
        },
        genId,
      );
      if (!appended) {
        throw new Error("event_append_failed");
      }

      return { recordResult };
    });

    if (!result.recordResult.ok) {
      return errorResponse("internal_error", "Failed to record support action", 500, requestId);
    }
    return successResponse({ supportAction: publicRecord(result.recordResult.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Failed to record support action", 500, requestId);
  } finally {
    await executor.dispose();
  }
}

// ---------------------------------------------------------------------------
// Access-denied audit emission
// ---------------------------------------------------------------------------

interface AccessDeniedInput {
  actor: SupportActor;
  targetOrgId: string;
  attemptedAction: string;
  reason: string;
  requestId: string;
  occurredAt: Date;
  genId: () => string;
  deps?: RecordSupportActionDeps;
}

export async function emitAccessDenied(env: Env, input: AccessDeniedInput): Promise<void> {
  const eventInput = {
    type: "support.access_denied" as const,
    actor: input.actor,
    orgId: input.targetOrgId,
    subjectKind: "organization",
    subjectId: input.targetOrgId,
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    payload: {
      attemptedAction: input.attemptedAction,
      reason: input.reason,
    },
    auditDescription: `Support access denied (${input.reason}) for attempted '${input.attemptedAction}' on ${input.targetOrgId}`,
  };

  // Injected-deps path.
  if (input.deps) {
    await appendSupportEvent(input.deps.eventsRepo, eventInput, input.genId);
    return;
  }

  // Production path: best-effort audit of the denial. A missing DB must not turn
  // a (correct) 403 into a 500 — the denial decision stands regardless.
  if (!env.PLATFORM_DB) return;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const eventsRepo = createEventsRepository(executor);
    await appendSupportEvent(eventsRepo, eventInput, input.genId);
  } catch {
    // Swallow — denial already enforced; audit best-effort.
  } finally {
    await executor.dispose();
  }
}

// Exposed so the list handler and tests can build a parser-friendly id.
export { parseOrgPublicId };
