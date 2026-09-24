import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { parseOrgPublicId, parseInvitationPublicId, invitationPublicId } from "../ids.js";

export interface RevokeInvitationDeps {
  repo: Pick<MembershipRepository, "listRoleAssignments" | "revokeInvitation">;
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

export async function handleRevokeInvitation(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  invitationIdParam: string,
  deps?: RevokeInvitationDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  const invUuid = parseInvitationPublicId(invitationIdParam);
  if (!invUuid) {
    return errorResponse("not_found", "Invitation not found", 404, requestId);
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
      action: "organization.invitation.revoke",
      resource: { kind: "organization", id: orgUuid, orgId: orgUuid },
      orgId: orgUuid,
      roleAssignments: rolesResult.value,
      requestId,
    });

    if (!authResult.allow) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const now = deps?.now ? deps.now() : new Date();
    const genId = deps?.generateId ?? (() => randomHex(16));

    // If we have a transactional executor, use a transaction for atomicity.
    // Otherwise (unit tests with injected deps), run sequentially.
    if (executor && "transaction" in executor) {
      const result = await executor.transaction(async (txExec) => {
        const txRepo = createMembershipRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        const revokeResult = await txRepo.revokeInvitation(orgUuid, invUuid, now);
        if (!revokeResult.ok) {
          return { revokeResult };
        }

        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "invite.revoked",
            version: 1,
            source: "membership-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: orgUuid,
            subjectKind: "invitation",
            subjectId: invUuid,
            requestId,
            payload: { invitationId: invitationPublicId(invUuid), role: revokeResult.value.role },
          },
          audit: {
            id: genId(),
            category: "membership",
            description: `Invitation ${invitationPublicId(invUuid)} revoked`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("event_append_failed");
        }

        return { revokeResult };
      });

      if (!result.revokeResult.ok) {
        if (result.revokeResult.error.kind === "not_found") {
          return errorResponse("not_found", "Invitation not found", 404, requestId);
        }
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }

      const inv = result.revokeResult.value;
      const publicInv = {
        id: invitationPublicId(inv.id),
        email: inv.email,
        role: inv.role,
        status: "revoked",
        invitedBy: inv.invitedBy,
        expiresAt: inv.expiresAt.toISOString(),
        createdAt: inv.createdAt.toISOString(),
        acceptedAt: inv.acceptedAt ? inv.acceptedAt.toISOString() : null,
        revokedAt: inv.revokedAt ? inv.revokedAt.toISOString() : null,
      };

      return successResponse({ invitation: publicInv }, requestId, 200);
    }

    // Non-transactional path (unit tests with injected deps)
    const revokeResult = await repo.revokeInvitation(orgUuid, invUuid, now);
    if (!revokeResult.ok) {
      if (revokeResult.error.kind === "not_found") {
        return errorResponse("not_found", "Invitation not found", 404, requestId);
      }
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    // Append event/audit if eventsRepo is injected (test seam)
    if (deps?.eventsRepo) {
      const eventResult = await deps.eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "invite.revoked",
          version: 1,
          source: "membership-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId: orgUuid,
          subjectKind: "invitation",
          subjectId: invUuid,
          requestId,
          payload: { invitationId: invitationPublicId(invUuid), role: revokeResult.value.role },
        },
        audit: {
          id: genId(),
          category: "membership",
          description: `Invitation ${invitationPublicId(invUuid)} revoked`,
        },
      });

      if (!eventResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
    }

    const inv = revokeResult.value;
    const publicInv = {
      id: invitationPublicId(inv.id),
      email: inv.email,
      role: inv.role,
      status: "revoked",
      invitedBy: inv.invitedBy,
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
      acceptedAt: inv.acceptedAt ? inv.acceptedAt.toISOString() : null,
      revokedAt: inv.revokedAt ? inv.revokedAt.toISOString() : null,
    };

    return successResponse({ invitation: publicInv }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
