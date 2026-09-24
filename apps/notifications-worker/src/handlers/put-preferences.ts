import type { Env } from "../env.js";
import type { InternalActor } from "../router.js";
import type {
  NotificationPreference,
  UpdateNotificationPreferencesRequest,
  UpdateNotificationPreferencesResponse,
} from "@saas/contracts/notifications";
import { NOTIFICATION_EVENT_TYPES } from "@saas/contracts/notifications";
import { createSqlExecutor } from "@saas/db/d1";
import {
  createNotificationsRepository,
  type NotificationsRepository,
  type StoredNotificationPreference,
} from "@saas/db/notifications";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgIdInput } from "../ids.js";
import { emitEvent } from "../events-client.js";

const ALLOWED_KIND = new Set(["user", "organization"]);
const ALLOWED_CATEGORIES = new Set(["invitation", "billing", "security", "support", "product"]);

function toPreference(p: StoredNotificationPreference): NotificationPreference {
  return {
    subjectKind: p.subjectKind as NotificationPreference["subjectKind"],
    subjectId: p.subjectId,
    orgId: p.orgId,
    channel: p.channel as NotificationPreference["channel"],
    categories: p.categories as NotificationPreference["categories"],
    updatedAt: p.updatedAt.toISOString(),
  };
}

export interface PutPreferencesDeps {
  repo?: NotificationsRepository;
  now?: () => Date;
  generateUuid?: () => string;
  emit?: typeof emitEvent;
}

function validate(body: unknown): { ok: true; value: UpdateNotificationPreferencesRequest } | { ok: false; errors: Record<string, string[]> } {
  const errors: Record<string, string[]> = {};
  if (!body || typeof body !== "object") return { ok: false, errors: { _root: ["Body must be a JSON object"] } };
  const b = body as Record<string, unknown>;
  if (typeof b.orgId !== "string" || !b.orgId) errors.orgId = ["Required"];
  if (typeof b.subjectKind !== "string" || !ALLOWED_KIND.has(b.subjectKind)) errors.subjectKind = ['Must be "user" or "organization"'];
  if (typeof b.subjectId !== "string" || !b.subjectId) errors.subjectId = ["Required"];
  if (b.channel !== "email") errors.channel = ['Only "email" is supported in V1'];
  if (!b.categories || typeof b.categories !== "object" || Array.isArray(b.categories)) {
    errors.categories = ["Must be an object"];
  } else {
    for (const [k, v] of Object.entries(b.categories as Record<string, unknown>)) {
      if (!ALLOWED_CATEGORIES.has(k)) errors[`categories.${k}`] = ["Unknown category"];
      else if (v !== null && typeof v !== "boolean") errors[`categories.${k}`] = ["Must be boolean or null"];
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: b as unknown as UpdateNotificationPreferencesRequest };
}

export async function handlePutPreferences(
  request: Request,
  env: Env,
  requestId: string,
  actor: InternalActor,
  deps?: PutPreferencesDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const validated = validate(body);
  if (!validated.ok) return validationError(requestId, validated.errors);
  const input = validated.value;

  // notification_preferences.org_id is a UUID column; decode the public
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

    const upsert = await repo.upsertPreference({
      id: genUuid(),
      orgId: orgUuid,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      channel: input.channel,
      categories: input.categories as Record<string, boolean | null>,
      updatedAt: now,
    });
    if (!upsert.ok) {
      return errorResponse("internal_error", "Failed to update preferences", 500, requestId);
    }

    await emit(env, {
      type: NOTIFICATION_EVENT_TYPES.PREFERENCE_UPDATED,
      notificationId: upsert.value.id,
      orgId: orgUuid,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      actorType: actor.subjectType,
      actorId: actor.subjectId,
      requestId,
      category: "notifications",
      description: `Notification preferences updated for ${input.subjectKind}:${input.subjectId}`,
      payload: {
        orgId: orgUuid,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        channel: input.channel,
        categories: input.categories,
      },
      occurredAt: now,
    });

    const response: UpdateNotificationPreferencesResponse = { preference: toPreference(upsert.value) };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
