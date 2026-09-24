import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ProjectsRepository } from "@saas/db/projects";
import type { Uuid } from "@saas/db/ids";
import { createProjectsRepository } from "@saas/db/projects";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, validationError } from "../http.js";
import { toPublicEnvironment } from "./create-environment.js";
import { parsePageParams, encodeCursor } from "../pagination.js";

export interface HandleListEnvironmentsDeps {
  projectsRepo?: ProjectsRepository;
}

export async function handleListEnvironments(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: HandleListEnvironmentsDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const url = new URL(request.url);
  const pageResult = parsePageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }

  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    "environment.read",
    { kind: "environment", orgId, projectId },
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null;

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.projectsRepo ?? createProjectsRepository(executor);

    const parentResult = await repo.getProjectById(orgId, projectId);
    if (!parentResult.ok || parentResult.value.status !== "active") {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const result = await repo.listEnvironmentsPaged(orgId, projectId, { limit, cursor: dbCursor });

    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const environments = result.value.items.map(toPublicEnvironment);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return Response.json(
      {
        data: { environments },
        meta: { requestId, cursor: nextCursor },
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
