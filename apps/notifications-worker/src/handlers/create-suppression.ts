import type { Env } from "../env.js";
import type { InternalActor } from "../router.js";
import type {
  SuppressRecipientRequest,
  SuppressRecipientResponse,
} from "@saas/contracts/notifications";
import { NOTIFICATION_EVENT_TYPES } from "@saas/contracts/notifications";
import { createSqlExecutor } from "@saas/db/d1";
import {
  createNotificationsRepository,
  type NotificationsRepository,
} from "@saas/db/notifications";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgIdInput } from "../ids.js";
import { emitEvent } from "../events-client.js";

const ALLOWED_REASONS = new Set(["bounce", "complaint", "manual", "unsubscribe"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateSuppressionDeps {
  repo?: NotificationsRepository;
  now?: () => Date;
  generateUuid?: () => string;
  emit?: typeof emitEvent;
}

function validate(body: unknown): { ok: true; value: SuppressRecipientRequest } | { ok: false; errors: Record<string, string[]> } {
  const errors: Record<string, string[]> = {};
  if (!body || typeof body !== "object") return { ok: false, errors: { _root: ["Body must be a JSON object"] } };
  const b = body as Record<string, unknown>;
  if (typeof b.orgId !== "string" || !b.orgId) errors.orgId = ["Required"];
  if (b.channel !== "email") errors.channel = ['Only "email" is supported in V1'];
  if (typeof b.reason !== "string" || !ALLOWED_REASONS.has(b.reason)) errors.reason = ["Must be bounce, complaint, manual, or unsubscribe"];
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: b as unknown as SuppressRecipientRequest };
}

export async function handleCreateSuppression(
  request: Request,
  env: Env,
  requestId: string,
  actor: InternalActor,
  recipientFromPath: string,
  deps?: CreateSuppressionDeps,
): Promise<Response> {
  const recipient = decodeURIComponent(recipientFromPath);
  if (!EMAIL_RE.test(recipient)) {
    return validationError(requestId, { recipient: ["Must be a valid email address"] });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const validated = validate(body);
  if (!validated.ok) return validationError(requestId, validated.errors);
  const input = validated.value;

  // notification_suppressions.org_id is a UUID column; decode the public
  // `org_<hex>` form (or accept a bare UUID) before persistence.
  const orgUuid = parseOrgIdInput(input.orgId);
  if (!orgUuid) return validationError(requestId, { orgId: ["Invalid org id"] });

  if (!deps?.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNotificationsRepository(executor!);
    const now = deps?.now ? deps.now() : new Date();
    const genUuid = deps?.generateUuid ?? (() => crypto.randomUUID());
    const emit = deps?.emit ?? emitEvent;

    const created = await repo.createSuppression({
      id: genUuid(),
      orgId: orgUuid,
      channel: input.channel,
      address: recipient,
      reason: input.reason,
      createdAt: now,
    });
    if (!created.ok) {
      return errorResponse("internal_error", "Failed to create suppression", 500, requestId);
    }

    await emit(env, {
      type: NOTIFICATION_EVENT_TYPES.SUPPRESSED,
      notificationId: created.value.id,
      orgId: orgUuid,
      subjectKind: "suppression",
      subjectId: created.value.id,
      actorType: actor.subjectType,
      actorId: actor.subjectId,
      requestId,
      category: "notifications",
      description: `Recipient ${created.value.address} suppressed (${input.reason})`,
      payload: {
        orgId: orgUuid,
        channel: input.channel,
        recipient: created.value.address,
        reason: input.reason,
      },
      occurredAt: now,
    });

    const response: SuppressRecipientResponse = {
      suppression: {
        orgId: created.value.orgId,
        channel: created.value.channel as "email",
        address: created.value.address,
        reason: created.value.reason as SuppressRecipientRequest["reason"],
        createdAt: created.value.createdAt.toISOString(),
      },
    };
    return successResponse(response, requestId, 201);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
