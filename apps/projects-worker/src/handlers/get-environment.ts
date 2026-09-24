import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ProjectsRepository } from "@saas/db/projects";
import type { Uuid } from "@saas/db/ids";
import { createProjectsRepository } from "@saas/db/projects";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { toPublicEnvironment } from "./create-environment.js";

export interface HandleGetEnvironmentDeps {
  projectsRepo?: ProjectsRepository;
}

export async function handleGetEnvironment(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  environmentId: string,
  deps?: HandleGetEnvironmentDeps,
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
    { kind: "environment", id: environmentId, orgId, projectId, environmentId },
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.projectsRepo ?? createProjectsRepository(executor);

    const parentResult = await repo.getProjectById(orgId, projectId);
    if (!parentResult.ok || parentResult.value.status !== "active") {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const result = await repo.getEnvironmentById(orgId, projectId, environmentId);

    if (!result.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    return successResponse({ environment: toPublicEnvironment(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
