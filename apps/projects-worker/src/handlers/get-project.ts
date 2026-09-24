import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ProjectsRepository } from "@saas/db/projects";
import type { Uuid } from "@saas/db/ids";
import { createProjectsRepository } from "@saas/db/projects";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { toPublicProject } from "./create-project.js";

export interface HandleGetProjectDeps {
  projectsRepo?: ProjectsRepository;
}

export async function handleGetProject(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: HandleGetProjectDeps,
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
    "project.read",
    { kind: "project", id: projectId, orgId, projectId },
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.projectsRepo ?? createProjectsRepository(executor);
    const result = await repo.getProjectById(orgId, projectId);

    if (!result.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    return successResponse({ project: toPublicProject(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
