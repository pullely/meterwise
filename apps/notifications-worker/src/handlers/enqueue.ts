import type { Env } from "../env.js";
import type { InternalActor } from "../router.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createNotificationsRepository } from "@saas/db/notifications";
import { successResponse, errorResponse, validationError } from "../http.js";
import { resolveProvider } from "../providers/index.js";
import { enqueueNotification, validateEnqueueRequest } from "../services/notifications.js";
import type { NotificationsServiceDeps } from "../services/notifications.js";

export interface EnqueueDeps {
  /** Test-only override for the service deps. */
  service?: Partial<Omit<NotificationsServiceDeps, "actorType" | "actorId" | "requestId" | "env">>;
}

export async function handleEnqueueNotification(
  request: Request,
  env: Env,
  requestId: string,
  actor: InternalActor,
  deps?: EnqueueDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const validated = validateEnqueueRequest(body);
  if (!validated.ok) {
    return validationError(requestId, validated.errors);
  }

  if (!deps?.service?.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = deps?.service?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.service?.repo ?? createNotificationsRepository(executor!);
    const provider = deps?.service?.provider ?? resolveProvider(env);

    const result = await enqueueNotification(
      {
        repo,
        provider,
        env,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        requestId,
        now: deps?.service?.now,
        generateUuid: deps?.service?.generateUuid,
        emit: deps?.service?.emit,
      },
      validated.value!,
    );

    if ("error" in result) {
      return errorResponse(result.error.code, result.error.message, result.error.status, requestId);
    }
    const httpStatus = result.outcome.status === "idempotent_hit" ? 200 : 201;
    return successResponse(result.outcome.response, requestId, httpStatus);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
