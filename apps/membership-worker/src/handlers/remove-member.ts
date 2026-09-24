import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { parseOrgPublicId, parseMemberPublicId, memberPublicId } from "../ids.js";

export interface RemoveMemberDeps {
  repo: Pick<MembershipRepository, "listRoleAssignments" | "getMemberById" | "removeMember" | "countActiveOwners" | "revokeAllRoleAssignments">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function handleRemoveMember(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  memberIdParam: string,
  deps?: RemoveMemberDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  const memberUuid = parseMemberPublicId(memberIdParam);
  if (!memberUuid) {
    return errorResponse("not_found", "Member not found", 404, requestId);
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  if (!env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const policyWorker = env.POLICY_WORKER;
  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    const rolesResult = await repo.listRoleAssignments(orgUuid, actor.subjectId);
    if (!rolesResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const authResult = await authorizeViaPolicy(policyWorker, {
      actor,
      action: "organization.member.remove",
      resource: { kind: "member", id: memberUuid, orgId: orgUuid },
      orgId: orgUuid,
      roleAssignments: rolesResult.value,
      requestId,
    });

    if (!authResult.allow) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => randomHex(16));

    if (executor && "transaction" in executor) {
      const result = await executor.transaction(async (txExec) => {
        const txRepo = createMembershipRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        const memberResult = await txRepo.getMemberById(orgUuid, memberUuid);
        if (!memberResult.ok) {
          return { error: memberResult.error.kind === "removed" ? "removed" as const : "not_found" as const };
        }

        const member = memberResult.value;
        const targetRoles = await txRepo.listRoleAssignments(orgUuid, member.subjectId);
        if (!targetRoles.ok) {
          return { error: "internal" as const };
        }

        const isOwner = targetRoles.value.some((r) => r.scopeKind === "organization" && r.role === "owner");
        if (isOwner) {
          const ownerCount = await txRepo.countActiveOwners(orgUuid);
          if (!ownerCount.ok) {
            return { error: "internal" as const };
          }
          if (ownerCount.value <= 1) {
            return { error: "last_owner" as const };
          }
        }

        const removeResult = await txRepo.removeMember(orgUuid, memberUuid, now);
        if (!removeResult.ok) {
          return { error: "not_found" as const };
        }

        const revokedRoles = await txRepo.revokeAllRoleAssignments(orgUuid, member.subjectId, now);
        if (!revokedRoles.ok) {
          throw new Error("role_revocation_failed");
        }
        const revokedCount = revokedRoles.value.length;
        const previousRoles = targetRoles.value.filter((r) => r.scopeKind === "organization").map((r) => r.role);

        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "membership.removed",
            version: 1,
            source: "membership-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: orgUuid,
            subjectKind: "member",
            subjectId: memberUuid,
            requestId,
            payload: { memberId: memberPublicId(memberUuid), previousRoles, revokedRoleCount: revokedCount },
          },
          audit: {
            id: genId(),
            category: "membership",
            description: `Member ${memberPublicId(memberUuid)} removed from organization`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("event_append_failed");
        }

        return { member: removeResult.value };
      });

      if ("error" in result) {
        if (result.error === "not_found" || result.error === "removed") {
          return errorResponse("not_found", "Member not found", 404, requestId);
        }
        if (result.error === "last_owner") {
          return errorResponse("precondition_failed", "Cannot remove the last active owner", 422, requestId);
        }
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }

      const publicMember = {
        id: memberPublicId(result.member.id),
        subjectType: result.member.subjectType,
        subjectId: result.member.subjectId,
        status: "removed",
        joinedAt: result.member.createdAt.toISOString(),
        roles: [],
      };
      return successResponse({ member: publicMember }, requestId, 200);
    }

    // Non-transactional path (unit tests with injected deps)
    const memberResult = await repo.getMemberById(orgUuid, memberUuid);
    if (!memberResult.ok) {
      return errorResponse("not_found", "Member not found", 404, requestId);
    }

    const member = memberResult.value;
    const targetRoles = await repo.listRoleAssignments(orgUuid, member.subjectId);
    if (!targetRoles.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    const isOwner = targetRoles.value.some((r) => r.scopeKind === "organization" && r.role === "owner");
    if (isOwner) {
      const ownerCount = await repo.countActiveOwners(orgUuid);
      if (!ownerCount.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
      if (ownerCount.value <= 1) {
        return errorResponse("precondition_failed", "Cannot remove the last active owner", 422, requestId);
      }
    }

    const removeResult = await repo.removeMember(orgUuid, memberUuid, now);
    if (!removeResult.ok) {
      return errorResponse("not_found", "Member not found", 404, requestId);
    }

    const revokedRoles = await repo.revokeAllRoleAssignments(orgUuid, member.subjectId, now);
    const revokedCount = revokedRoles.ok ? revokedRoles.value.length : 0;
    const previousRoles = targetRoles.value.filter((r) => r.scopeKind === "organization").map((r) => r.role);

    if (deps?.eventsRepo) {
      const eventResult = await deps.eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "membership.removed",
          version: 1,
          source: "membership-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId: orgUuid,
          subjectKind: "member",
          subjectId: memberUuid,
          requestId,
          payload: { memberId: memberPublicId(memberUuid), previousRoles, revokedRoleCount: revokedCount },
        },
        audit: {
          id: genId(),
          category: "membership",
          description: `Member ${memberPublicId(memberUuid)} removed from organization`,
        },
      });

      if (!eventResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
    }

    const publicMember = {
      id: memberPublicId(member.id),
      subjectType: member.subjectType,
      subjectId: member.subjectId,
      status: "removed",
      joinedAt: member.createdAt.toISOString(),
      roles: [],
    };
    return successResponse({ member: publicMember }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
