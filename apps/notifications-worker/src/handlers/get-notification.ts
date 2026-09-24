import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createNotificationsRepository, type NotificationsRepository } from "@saas/db/notifications";
import { successResponse, errorResponse } from "../http.js";
import { getNotificationByPublicId } from "../services/notifications.js";

export interface GetNotificationDeps {
  repo?: NotificationsRepository;
}

export async function handleGetNotification(
  env: Env,
  requestId: string,
  publicId: string,
  deps?: GetNotificationDeps,
): Promise<Response> {
  if (!deps?.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }
  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNotificationsRepository(executor!);
    const result = await getNotificationByPublicId(repo, publicId);
    if ("error" in result) {
      return errorResponse(result.error.code, result.error.message, result.error.status, requestId);
    }
    return successResponse(result.response, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
