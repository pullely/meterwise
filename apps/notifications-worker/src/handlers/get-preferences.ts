import type { Env } from "../env.js";
import type {
  GetNotificationPreferencesResponse,
  NotificationPreference,
} from "@saas/contracts/notifications";
import { createSqlExecutor } from "@saas/db/d1";
import {
  createNotificationsRepository,
  type NotificationsRepository,
  type StoredNotificationPreference,
} from "@saas/db/notifications";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgIdInput } from "../ids.js";

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

export interface GetPreferencesDeps {
  repo?: NotificationsRepository;
}

const ALLOWED_KIND = new Set(["user", "organization"]);

export async function handleGetPreferences(
  env: Env,
  requestId: string,
  url: URL,
  deps?: GetPreferencesDeps,
): Promise<Response> {
  const orgId = url.searchParams.get("orgId");
  const subjectKind = url.searchParams.get("subjectKind");
  const subjectId = url.searchParams.get("subjectId");
  const channel = url.searchParams.get("channel");

  const errors: Record<string, string[]> = {};
  if (!orgId) errors.orgId = ["Required"];
  if (!subjectKind || !ALLOWED_KIND.has(subjectKind)) errors.subjectKind = ['Must be "user" or "organization"'];
  if (!subjectId) errors.subjectId = ["Required"];
  if (channel && channel !== "email") errors.channel = ['Only "email" is supported in V1'];
  if (Object.keys(errors).length > 0) return validationError(requestId, errors);

  // notification_preferences.org_id is a UUID column; accept the public
  // `org_<hex>` form (or a bare UUID) and decode before querying.
  const orgUuid = parseOrgIdInput(orgId!);
  if (!orgUuid) return validationError(requestId, { orgId: ["Invalid org id"] });

  if (!deps?.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNotificationsRepository(executor!);
    const list = await repo.listPreferences(orgUuid, subjectKind!, subjectId!, channel);
    if (!list.ok) {
      return errorResponse("internal_error", "Failed to list preferences", 500, requestId);
    }
    const response: GetNotificationPreferencesResponse = {
      preferences: list.value.map(toPreference),
    };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
