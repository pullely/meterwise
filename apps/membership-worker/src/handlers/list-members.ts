import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository, PageQueryParams } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError, withTimings } from "../http.js";
import { parseOrgPublicId, memberPublicId } from "../ids.js";
import { parsePageParams, encodeCursor } from "../pagination.js";
import { createTimings } from "@saas/contracts/timing";

export interface ListMembersDeps {
  repo: Pick<
    MembershipRepository,
    "listRoleAssignments" | "listRoleAssignmentsForSubjects" | "listMembersPaged"
  >;
}

export async function handleListMembers(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  url?: URL,
  deps?: ListMembersDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  let pageParams: PageQueryParams = { limit: 50, cursor: null };
  if (url) {
    const pageResult = parsePageParams(url);
    if (!pageResult.ok) {
      return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
    }
    const { limit, cursor } = pageResult.value;
    pageParams = { limit, cursor: cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null };
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  if (!env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const policyWorker = env.POLICY_WORKER;
  const timings = createTimings();
  const endTotal = timings.start("total");
  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    // PERF4 (task 0133): the actor's role-assignment read (input to authz) and
    // the members page read are independent DB queries. Run them concurrently,
    // then apply the policy decision and discard the page on deny (deny-by-default).
    const [rolesResult, membersResult] = await Promise.all([
      timings.measure("authctx", () => repo.listRoleAssignments(orgUuid, actor.subjectId)),
      timings.measure("db", () => repo.listMembersPaged(orgUuid, pageParams)),
    ]);
    if (!rolesResult.ok) {
      endTotal();
      return withTimings(errorResponse("not_found", "Organization not found", 404, requestId), requestId, "members.list", timings);
    }

    const authResult = await timings.measure("policy", () =>
      authorizeViaPolicy(policyWorker, {
        actor,
        action: "organization.member.list",
        resource: { kind: "organization", id: orgUuid, orgId: orgUuid },
        orgId: orgUuid,
        roleAssignments: rolesResult.value,
        requestId,
      }),
    );

    if (!authResult.allow) {
      // Deny-by-default: never return the speculatively-read members page.
      endTotal();
      return withTimings(errorResponse("not_found", "Organization not found", 404, requestId), requestId, "members.list", timings);
    }

    if (!membersResult.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "An unexpected error occurred", 500, requestId), requestId, "members.list", timings);
    }

    const { items, nextCursor } = membersResult.value;

    // PERF3 (task 0132): one batched role-assignment query for the whole page
    // instead of one query per member (N+1). Falls back to the per-subject path
    // when the batched repo method is unavailable (e.g. older fakes).
    const rolesBySubject = new Map<string, { role: string; scopeKind: string }[]>();
    const endEnrich = timings.start("enrich");
    if (repo.listRoleAssignmentsForSubjects) {
      const pageRolesResult = await repo.listRoleAssignmentsForSubjects(
        orgUuid,
        items.map((m) => m.subjectId),
      );
      if (!pageRolesResult.ok) {
        endTotal();
        return withTimings(errorResponse("internal_error", "An unexpected error occurred", 500, requestId), requestId, "members.list", timings);
      }
      for (const [subjectId, ras] of pageRolesResult.value) {
        rolesBySubject.set(subjectId, ras.map((ra) => ({ role: ra.role, scopeKind: ra.scopeKind })));
      }
    } else {
      for (const member of items) {
        const r = await repo.listRoleAssignments(orgUuid, member.subjectId);
        if (!r.ok) {
          endTotal();
          return withTimings(errorResponse("internal_error", "An unexpected error occurred", 500, requestId), requestId, "members.list", timings);
        }
        rolesBySubject.set(
          member.subjectId,
          r.value.map((ra) => ({ role: ra.role, scopeKind: ra.scopeKind })),
        );
      }
    }
    endEnrich();

    const enriched = items.map((member) => ({
      id: memberPublicId(member.id),
      subjectType: member.subjectType,
      subjectId: member.subjectId,
      status: member.status,
      joinedAt: member.createdAt.toISOString(),
      roles: rolesBySubject.get(member.subjectId) ?? [],
    }));

    const cursorToken = nextCursor ? encodeCursor(nextCursor.createdAt, nextCursor.id) : null;
    endTotal();
    return withTimings(successResponse({ members: enriched }, requestId, 200, cursorToken), requestId, "members.list", timings);
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "An unexpected error occurred", 500, requestId), requestId, "members.list", timings);
  } finally {
    if (executor) await executor.dispose();
  }
}
