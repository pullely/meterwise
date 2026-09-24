import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PublicEnvironment } from "@saas/contracts/projects";
import type { ProjectsRepository, Environment, ProjectsResult } from "@saas/db/projects";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { createProjectsRepository } from "@saas/db/projects";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import {
  checkBillingEntitlement,
  decideEnvironmentsLimit,
} from "../billing-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId, projectPublicId, environmentPublicId } from "../ids.js";

const ENVIRONMENTS_LIMIT_ENTITLEMENT_KEY = "limit.environments";

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
    .slice(0, SLUG_MAX) || "environment";
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

export function toPublicEnvironment(env: { id: string; orgId: string; projectId: string; name: string; slug: string; status: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null }): PublicEnvironment {
  return {
    id: environmentPublicId(env.id),
    orgId: orgPublicId(env.orgId),
    projectId: projectPublicId(env.projectId),
    name: env.name,
    slug: env.slug,
    status: env.status,
    createdAt: env.createdAt.toISOString(),
    updatedAt: env.updatedAt.toISOString(),
    archivedAt: env.archivedAt ? env.archivedAt.toISOString() : null,
  };
}

export interface HandleCreateEnvironmentDeps {
  projectsRepo?: ProjectsRepository;
  eventsRepo?: EventsRepository;
  /**
   * Injectable billing entitlement check for tests. Defaults to a
   * real call against env.BILLING_WORKER.
   */
  checkEntitlement?: typeof checkBillingEntitlement;
}

export async function handleCreateEnvironment(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: HandleCreateEnvironmentDeps,
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
    "environment.create",
    { kind: "environment", orgId, projectId },
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  // ── Billing entitlement gate (Task 0081) ──────────────────────
  // Environment creation is gated on `limit.environments` after auth/
  // membership/policy allow and before any environment / event / audit
  // row is written or any UUID is generated. Fails closed on any
  // service/misconfiguration error.
  const entitlementResult = await (deps?.checkEntitlement ?? checkBillingEntitlement)(
    env.BILLING_WORKER,
    orgPublicId(orgId),
    ENVIRONMENTS_LIMIT_ENTITLEMENT_KEY,
    requestId,
  );
  if (entitlementResult.kind === "service_error") {
    return errorResponse(
      "internal_error",
      "Service unavailable",
      503,
      requestId,
    );
  }

  // For quantity limits we need the current active environment count
  // scoped to the parent project. Use the injected repo when present
  // (tests); otherwise build a transient non-transactional repo against
  // the same executor we'll use for the write transaction below.
  const preTxExecutor =
    deps?.projectsRepo && deps?.eventsRepo
      ? null
      : createSqlExecutor(env.PLATFORM_DB);
  let countRepo: Pick<ProjectsRepository, "countActiveEnvironments">;
  if (deps?.projectsRepo) {
    countRepo = deps.projectsRepo;
  } else {
    countRepo = createProjectsRepository(preTxExecutor!);
  }

  let activeCount: number;
  try {
    const countResult = await countRepo.countActiveEnvironments(orgId, projectId);
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

  const gate = decideEnvironmentsLimit(entitlementResult.decision, activeCount);
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
    const parentCheck = async (projectsRepo: ProjectsRepository) => {
      const parentResult = await projectsRepo.getProjectById(orgId, projectId);
      if (!parentResult.ok) return null;
      if (parentResult.value.status !== "active") return null;
      return parentResult.value;
    };

    const environmentId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const now = new Date();

    const doCreate = async (projectsRepo: ProjectsRepository, eventsRepo: EventsRepository) => {
      const parent = await parentCheck(projectsRepo);
      if (!parent) {
        return { ok: false as const, error: { kind: "not_found" as const } };
      }

      const createResult = await projectsRepo.createEnvironment({
        id: environmentId,
        orgId,
        projectId,
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
          type: "environment.created",
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
          subjectName: validation.name,
          requestId,
          payload: {
            environmentId: environmentPublicId(environmentId),
            projectId: projectPublicId(projectId),
            orgId: orgPublicId(orgId),
            name: validation.name,
            slug: validation.slug,
          },
        },
        audit: {
          id: auditId,
          category: "projects",
          description: `Created environment "${validation.name}"`,
          projectId,
          environmentId,
        },
      });

      if (!eventResult.ok) {
        throw new Error("event_append_failed");
      }

      return createResult;
    };

    let result: ProjectsResult<Environment>;
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
        return errorResponse("conflict", "An environment with this slug already exists", 409, requestId);
      }
      if (result.error.kind === "not_found") {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse({ environment: toPublicEnvironment(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
