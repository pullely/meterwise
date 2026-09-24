import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ProjectsRepository, ProjectsResult, Environment } from "@saas/db/projects";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { createProjectsRepository } from "@saas/db/projects";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { toPublicEnvironment } from "./create-environment.js";
import { orgPublicId, projectPublicId, environmentPublicId } from "../ids.js";

export interface HandleArchiveEnvironmentDeps {
  projectsRepo?: ProjectsRepository;
  eventsRepo?: EventsRepository;
}

export async function handleArchiveEnvironment(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  environmentId: string,
  deps?: HandleArchiveEnvironmentDeps,
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
    "environment.delete",
    { kind: "environment", id: environmentId, orgId, projectId, environmentId },
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const executor = deps?.projectsRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const eventId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const now = new Date();

    const doArchive = async (projectsRepo: ProjectsRepository, eventsRepo: EventsRepository) => {
      const parentResult = await projectsRepo.getProjectById(orgId, projectId);
      if (!parentResult.ok || parentResult.value.status !== "active") {
        return { ok: false as const, error: { kind: "not_found" as const } };
      }

      const archiveResult = await projectsRepo.archiveEnvironment(orgId, projectId, environmentId, now);

      if (!archiveResult.ok) {
        return archiveResult;
      }

      const eventResult = await eventsRepo.appendEventWithAudit({
        event: {
          id: eventId,
          type: "environment.archived",
          version: 1,
          source: "projects-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          projectId,
          environmentId,
          subjectKind: "environment",
          subjectId: environmentId,
          subjectName: archiveResult.value.name,
          requestId,
          payload: {
            environmentId: environmentPublicId(environmentId),
            projectId: projectPublicId(projectId),
            orgId: orgPublicId(orgId),
            name: archiveResult.value.name,
          },
        },
        audit: {
          id: auditId,
          category: "projects",
          description: `Archived environment "${archiveResult.value.name}"`,
          projectId,
          environmentId,
        },
      });

      if (!eventResult.ok) {
        throw new Error("event_append_failed");
      }

      return archiveResult;
    };

    let result: ProjectsResult<Environment>;
    if (deps?.projectsRepo && deps?.eventsRepo) {
      result = await doArchive(deps.projectsRepo, deps.eventsRepo);
    } else {
      result = await executor!.transaction(async (txExecutor) => {
        const projectsRepo = createProjectsRepository(txExecutor);
        const eventsRepo = createEventsRepository(txExecutor);
        return doArchive(projectsRepo, eventsRepo);
      });
    }

    if (!result.ok) {
      if (result.error.kind === "not_found") {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse({ environment: toPublicEnvironment(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
