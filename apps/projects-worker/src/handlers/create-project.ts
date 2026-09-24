import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PublicProject } from "@saas/contracts/projects";
import type { ProjectsRepository, Project, ProjectsResult } from "@saas/db/projects";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { createProjectsRepository } from "@saas/db/projects";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import {
  checkBillingEntitlement,
  decideProjectsLimit,
} from "../billing-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId, projectPublicId } from "../ids.js";

const PROJECTS_LIMIT_ENTITLEMENT_KEY = "limit.projects";

const NAME_MIN = 1;
const NAME_MAX = 100;
const SLUG_MIN = 2;
const SLUG_MAX = 63;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX) || "project";
}

function validateBody(body: unknown): { valid: true; name: string; slug: string } | { valid: false; fields: Record<string, string[]> } {
  if (!body || typeof body !== "object") {
    return { valid: false, fields: { body: ["Request body must be an object"] } };
  }

  const req = body as Record<string, unknown>;
  const fields: Record<string, string[]> = {};

  if (typeof req.name !== "string" || req.name.length < NAME_MIN || req.name.length > NAME_MAX) {
    fields.name = [`Must be a string between ${NAME_MIN} and ${NAME_MAX} characters`];
  }

  let slug: string;
  if (req.slug !== undefined && req.slug !== null) {
    if (typeof req.slug !== "string") {
      fields.slug = ["Must be a string"];
    } else if (req.slug.length < SLUG_MIN || req.slug.length > SLUG_MAX) {
      fields.slug = [`Must be between ${SLUG_MIN} and ${SLUG_MAX} characters`];
    } else if (!SLUG_RE.test(req.slug)) {
      fields.slug = ["Must contain only lowercase letters, numbers, and hyphens, starting and ending with an alphanumeric character"];
    }
    slug = typeof req.slug === "string" ? req.slug : "";
  } else {
    slug = deriveSlug(typeof req.name === "string" ? req.name : "");
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }

  return { valid: true, name: req.name as string, slug };
}

function toPublicProject(project: { id: string; orgId: string; name: string; slug: string; status: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null }): PublicProject {
  return {
    id: projectPublicId(project.id),
    orgId: orgPublicId(project.orgId),
    name: project.name,
    slug: project.slug,
    status: project.status,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    archivedAt: project.archivedAt ? project.archivedAt.toISOString() : null,
  };
}

export interface HandleCreateProjectDeps {
  projectsRepo?: ProjectsRepository;
  eventsRepo?: EventsRepository;
  /**
   * Injectable billing entitlement check for tests. Defaults to a
   * real call against env.BILLING_WORKER.
   */
  checkEntitlement?: typeof checkBillingEntitlement;
}

export async function handleCreateProject(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleCreateProjectDeps,
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
  if (!env.BILLING_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const validation = validateBody(body);
  if (!validation.valid) {
    return validationError(requestId, validation.fields);
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
    "project.create",
    { kind: "project", orgId },
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  // ── Billing entitlement gate (Task 0079) ──────────────────────
  // Project creation is gated on `limit.projects` after auth/membership/
  // policy allow and before any project / event / audit row is written.
  // Fails closed on any service/misconfiguration error.
  const entitlementCall = (deps?.checkEntitlement ?? checkBillingEntitlement)(
    env.BILLING_WORKER,
    orgPublicId(orgId),
    PROJECTS_LIMIT_ENTITLEMENT_KEY,
    requestId,
  );
  const entitlementResult = await entitlementCall;
  if (entitlementResult.kind === "service_error") {
    return errorResponse(
      "internal_error",
      "Service unavailable",
      503,
      requestId,
    );
  }

  // For quantity limits we need the current active project count. Use the
  // injected repo when present (tests); otherwise build a transient
  // non-transactional repo against the same executor we'll use for the
  // write transaction below.
  const preTxExecutor =
    deps?.projectsRepo && deps?.eventsRepo
      ? null
      : createSqlExecutor(env.PLATFORM_DB);
  let countRepo: Pick<ProjectsRepository, "countActiveProjects">;
  if (deps?.projectsRepo) {
    countRepo = deps.projectsRepo;
  } else {
    countRepo = createProjectsRepository(preTxExecutor!);
  }

  let activeCount: number;
  try {
    const countResult = await countRepo.countActiveProjects(orgId);
    if (!countResult.ok) {
      if (preTxExecutor) await preTxExecutor.dispose();
      return errorResponse(
        "internal_error",
        "Service unavailable",
        503,
        requestId,
      );
    }
    activeCount = countResult.value;
  } catch {
    if (preTxExecutor) await preTxExecutor.dispose();
    return errorResponse(
      "internal_error",
      "Service unavailable",
      503,
      requestId,
    );
  }

  const gate = decideProjectsLimit(entitlementResult.decision, activeCount);
  if (gate.kind === "service_error") {
    if (preTxExecutor) await preTxExecutor.dispose();
    return errorResponse(
      "internal_error",
      "Service unavailable",
      503,
      requestId,
    );
  }
  if (gate.kind === "deny") {
    if (preTxExecutor) await preTxExecutor.dispose();
    return errorResponse(
      "precondition_failed",
      gate.message,
      412,
      requestId,
      { reason: gate.reason },
    );
  }

  const executor = preTxExecutor;
  try {
    const projectId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const now = new Date();

    const doCreate = async (projectsRepo: ProjectsRepository, eventsRepo: EventsRepository) => {
      const createResult = await projectsRepo.createProject({
        id: projectId,
        orgId,
        name: validation.name,
        slug: validation.slug,
        slugLower: validation.slug.toLowerCase(),
        createdAt: now,
      });

      if (!createResult.ok) {
        return createResult;
      }

      const eventResult = await eventsRepo.appendEventWithAudit({
        event: {
          id: eventId,
          type: "project.created",
          version: 1,
          source: "projects-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          projectId,
          subjectKind: "project",
          subjectId: projectId,
          subjectName: validation.name,
          requestId,
          payload: {
            projectId: projectPublicId(projectId),
            orgId: orgPublicId(orgId),
            name: validation.name,
            slug: validation.slug,
          },
        },
        audit: {
          id: auditId,
          category: "projects",
          description: `Created project "${validation.name}"`,
          projectId,
        },
      });

      if (!eventResult.ok) {
        throw new Error("event_append_failed");
      }

      return createResult;
    };

    let result: ProjectsResult<Project>;
    if (deps?.projectsRepo && deps?.eventsRepo) {
      result = await doCreate(deps.projectsRepo, deps.eventsRepo);
    } else {
      result = await executor!.transaction(async (txExecutor) => {
        const projectsRepo = createProjectsRepository(txExecutor);
        const eventsRepo = createEventsRepository(txExecutor);
        return doCreate(projectsRepo, eventsRepo);
      });
    }

    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "A project with this slug already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse({ project: toPublicProject(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

export { toPublicProject };
