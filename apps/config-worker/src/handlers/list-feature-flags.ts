import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Scope } from "@saas/db/config";
import { createConfigRepository } from "@saas/db/config";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, listResponse, validationError, withTimings } from "../http.js";
import { createTimings } from "@saas/contracts/timing";
import { toPublicFeatureFlag } from "../mappers.js";
import { parsePageParams, encodeCursor } from "../pagination.js";
import type { PolicyResource } from "@saas/contracts/policy";

export async function handleListFeatureFlags(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
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

  const policyAction = scope.kind === "organization" ? "organization.config.read" : "project.config.read";
  const resource: PolicyResource = { kind: scope.kind === "organization" ? "organization" : "project", orgId: scope.orgId };
  if ("projectId" in scope) {
    resource.projectId = scope.projectId;
  }

  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null;

  const executor = createSqlExecutor(env.PLATFORM_DB);
  // PERF14b: phase timings — `authz_ctx` and `db` run concurrently (PERF12b),
  // so their overlap is directly visible in the Server-Timing breakdown.
  const timings = createTimings();
  const endTotal = timings.start("total");
  const route = "config.flags.list";
  try {
    const repo = createConfigRepository(executor);
    // PERF12: the authorization-context fetch (membership) and the read are
    // independent — run them concurrently, evaluate policy from the fetched
    // facts, and discard the speculatively read rows on deny (deny-by-default).
    const [contextResult, result] = await Promise.all([
      timings.measure("authz_ctx", () =>
        fetchAuthorizationContext(
          env.MEMBERSHIP_WORKER!,
          actor.subjectId,
          actor.subjectType,
          scope.orgId,
          requestId,
        ),
      ),
      timings.measure("db", () => repo.listFeatureFlags(scope, { limit, cursor: dbCursor })),
    ]);
    if (!contextResult.ok) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, route, timings);
    }

    const policyResult = await timings.measure("policy", () =>
      authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        policyAction,
        resource,
        contextResult.memberships,
        requestId,
      ),
    );
    if (!policyResult.allow) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, route, timings);
    }

    if (!result.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, route, timings);
    }

    const featureFlags = result.value.items.map(toPublicFeatureFlag);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    endTotal();
    return withTimings(listResponse({ featureFlags }, requestId, nextCursor), requestId, route, timings);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
