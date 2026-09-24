import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ProjectsRepository, ProjectsResult, Project } from "@saas/db/projects";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { createProjectsRepository } from "@saas/db/projects";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { toPublicProject } from "./create-project.js";
import { orgPublicId, projectPublicId } from "../ids.js";

export interface HandleArchiveProjectDeps {
  projectsRepo?: ProjectsRepository;
  eventsRepo?: EventsRepository;
}

export async function handleArchiveProject(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: HandleArchiveProjectDeps,
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
    "project.delete",
    { kind: "project", id: projectId, orgId, projectId },
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
      const archiveResult = await projectsRepo.archiveProject(orgId, projectId, now);

      if (!archiveResult.ok) {
        return archiveResult;
      }

      const eventResult = await eventsRepo.appendEventWithAudit({
        event: {
          id: eventId,
          type: "project.archived",
          version: 1,
          source: "projects-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          projectId,
          subjectKind: "project",
          subjectId: projectId,
          subjectName: archiveResult.value.name,
          requestId,
          payload: {
            projectId: projectPublicId(projectId),
            orgId: orgPublicId(orgId),
            name: archiveResult.value.name,
          },
        },
        audit: {
          id: auditId,
          category: "projects",
          description: `Archived project "${archiveResult.value.name}"`,
          projectId,
        },
      });

      if (!eventResult.ok) {
        throw new Error("event_append_failed");
      }

      return archiveResult;
    };

    let result: ProjectsResult<Project>;
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

    return successResponse({ project: toPublicProject(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
