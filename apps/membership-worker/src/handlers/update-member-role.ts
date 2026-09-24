import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { ORGANIZATION_ROLES } from "@saas/contracts/membership";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, parseMemberPublicId, memberPublicId } from "../ids.js";

export interface UpdateMemberRoleDeps {
  repo: Pick<MembershipRepository, "listRoleAssignments" | "getMemberById" | "countActiveOwners" | "revokeAllRoleAssignments" | "createRoleAssignment">;
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

export async function handleUpdateMemberRole(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  memberIdParam: string,
  deps?: UpdateMemberRoleDeps,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  if (!body || typeof body !== "object" || !("role" in body)) {
    return validationError(requestId, { role: ["Role is required"] });
  }

  const role = (body as { role: unknown }).role;
  if (typeof role !== "string" || !(ORGANIZATION_ROLES as readonly string[]).includes(role)) {
    return validationError(requestId, { role: ["Must be a valid organization role"] });
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
      action: "organization.member.update_role",
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

        const orgRoles = targetRoles.value.filter((r) => r.scopeKind === "organization");
        const alreadyHasExactRole = orgRoles.length === 1 && orgRoles[0]!.role === role;
        if (alreadyHasExactRole) {
          return { noop: true, member, roles: targetRoles.value };
        }

        const isCurrentOwner = orgRoles.some((r) => r.role === "owner");
        if (isCurrentOwner && role !== "owner") {
          const ownerCount = await txRepo.countActiveOwners(orgUuid);
          if (!ownerCount.ok) {
            return { error: "internal" as const };
          }
          if (ownerCount.value <= 1) {
            return { error: "last_owner" as const };
          }
        }

        for (const orgRole of orgRoles) {
          const revokeResult = await txRepo.revokeRoleAssignment(orgUuid, orgRole.id, now);
          if (!revokeResult.ok) {
            throw new Error("role_revocation_failed");
          }
        }

        const newAssignment = await txRepo.createRoleAssignment({
          id: crypto.randomUUID(),
          orgId: orgUuid,
          subjectId: member.subjectId,
          subjectType: member.subjectType,
          role,
          scopeKind: "organization",
          createdAt: now,
        });

        if (!newAssignment.ok) {
          throw new Error("role_assignment_failed");
        }

        const previousRoles = orgRoles.map((r) => r.role);
        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "membership.updated",
            version: 1,
            source: "membership-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: orgUuid,
            subjectKind: "member",
            subjectId: memberUuid,
            requestId,
            payload: { memberId: memberPublicId(memberUuid), previousRoles, role },
          },
          audit: {
            id: genId(),
            category: "membership",
            description: `Member ${memberPublicId(memberUuid)} role updated to ${role}`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("event_append_failed");
        }

        const updatedRoles = await txRepo.listRoleAssignments(orgUuid, member.subjectId);
        return { member, roles: updatedRoles.ok ? updatedRoles.value : [newAssignment.value] };
      });

      if ("error" in result) {
        if (result.error === "not_found" || result.error === "removed") {
          return errorResponse("not_found", "Member not found", 404, requestId);
        }
        if (result.error === "last_owner") {
          return errorResponse("precondition_failed", "Cannot change role of the last active owner", 422, requestId);
        }
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }

      if ("noop" in result && result.noop) {
        const publicMember = {
          id: memberPublicId(result.member.id),
          subjectType: result.member.subjectType,
          subjectId: result.member.subjectId,
          status: result.member.status,
          joinedAt: result.member.createdAt.toISOString(),
          roles: result.roles.map((r) => ({ role: r.role, scopeKind: r.scopeKind })),
        };
        return successResponse({ member: publicMember }, requestId, 200);
      }

      const publicMember = {
        id: memberPublicId(result.member!.id),
        subjectType: result.member!.subjectType,
        subjectId: result.member!.subjectId,
        status: result.member!.status,
        joinedAt: result.member!.createdAt.toISOString(),
        roles: result.roles!.map((r) => ({ role: r.role, scopeKind: r.scopeKind })),
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

    const orgRoles = targetRoles.value.filter((r) => r.scopeKind === "organization");
    const alreadyHasExactRole = orgRoles.length === 1 && orgRoles[0]!.role === role;
    if (alreadyHasExactRole) {
      const publicMember = {
        id: memberPublicId(member.id),
        subjectType: member.subjectType,
        subjectId: member.subjectId,
        status: member.status,
        joinedAt: member.createdAt.toISOString(),
        roles: targetRoles.value.map((r) => ({ role: r.role, scopeKind: r.scopeKind })),
      };
      return successResponse({ member: publicMember }, requestId, 200);
    }

    const isCurrentOwner = orgRoles.some((r) => r.role === "owner");
    if (isCurrentOwner && role !== "owner") {
      const ownerCount = await repo.countActiveOwners(orgUuid);
      if (!ownerCount.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
      if (ownerCount.value <= 1) {
        return errorResponse("precondition_failed", "Cannot change role of the last active owner", 422, requestId);
      }
    }

    const revokeResult = await repo.revokeAllRoleAssignments(orgUuid, member.subjectId, now);
    if (!revokeResult.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    const previousRoles = orgRoles.map((r) => r.role);

    const newAssignment = await repo.createRoleAssignment({
      id: crypto.randomUUID(),
      orgId: orgUuid,
      subjectId: member.subjectId,
      subjectType: member.subjectType,
      role,
      scopeKind: "organization",
      createdAt: now,
    });

    if (!newAssignment.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    if (deps?.eventsRepo) {
      const eventResult = await deps.eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "membership.updated",
          version: 1,
          source: "membership-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId: orgUuid,
          subjectKind: "member",
          subjectId: memberUuid,
          requestId,
          payload: { memberId: memberPublicId(memberUuid), previousRoles, role },
        },
        audit: {
          id: genId(),
          category: "membership",
          description: `Member ${memberPublicId(memberUuid)} role updated to ${role}`,
        },
      });

      if (!eventResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
    }

    const updatedRoles = await repo.listRoleAssignments(orgUuid, member.subjectId);
    const finalRoles = updatedRoles.ok ? updatedRoles.value : [newAssignment.value];
    const publicMember = {
      id: memberPublicId(member.id),
      subjectType: member.subjectType,
      subjectId: member.subjectId,
      status: member.status,
      joinedAt: member.createdAt.toISOString(),
      roles: finalRoles.map((r) => ({ role: r.role, scopeKind: r.scopeKind })),
    };

    return successResponse({ member: publicMember }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
