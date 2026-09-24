import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ProjectsRepository } from "@saas/db/projects";
import type { Uuid } from "@saas/db/ids";
import { createProjectsRepository } from "@saas/db/projects";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, validationError, withTimings } from "../http.js";
import { toPublicProject } from "./create-project.js";
import { parsePageParams, encodeCursor } from "../pagination.js";
import { createTimings } from "@saas/contracts/timing";

export interface HandleListProjectsDeps {
  projectsRepo?: ProjectsRepository;
}

export async function handleListProjects(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleListProjectsDeps,
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

  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null;

  const timings = createTimings();
  const endTotal = timings.start("total");
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.projectsRepo ?? createProjectsRepository(executor);

    // PERF4 (task 0133): the authorization-context fetch (membership-worker) and
    // the resource read are independent — the read does not depend on the authz
    // result for WHAT to read, only on WHETHER to return it. Run them
    // concurrently, then apply the policy decision and discard the read on deny.
    const [contextResult, result] = await Promise.all([
      timings.measure("authctx", () =>
        fetchAuthorizationContext(
          env.MEMBERSHIP_WORKER!,
          actor.subjectId,
          actor.subjectType,
          orgId,
          requestId,
        ),
      ),
      timings.measure("db", () => repo.listProjectsPaged(orgId, { limit, cursor: dbCursor })),
    ]);

    if (!contextResult.ok) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "projects.list", timings);
    }

    const policyResult = await timings.measure("policy", () =>
      authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        "project.list",
        { kind: "organization", orgId },
        contextResult.memberships,
        requestId,
      ),
    );
    if (!policyResult.allow) {
      // Deny-by-default: never return the speculatively-read data.
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "projects.list", timings);
    }

    if (!result.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "projects.list", timings);
    }

    const projects = result.value.items.map(toPublicProject);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    endTotal();
    return withTimings(
      Response.json(
        {
          data: { projects },
          meta: { requestId, cursor: nextCursor },
        },
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      requestId,
      "projects.list",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "projects.list", timings);
  } finally {
    await executor.dispose();
  }
}
