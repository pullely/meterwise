import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository, PageQueryParams } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, invitationPublicId } from "../ids.js";
import { parsePageParams, encodeCursor } from "../pagination.js";

export interface ListInvitationsDeps {
  repo: Pick<MembershipRepository, "listRoleAssignments" | "listInvitationsPaged">;
}

export async function handleListInvitations(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  url?: URL,
  deps?: ListInvitationsDeps,
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
  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    const rolesResult = await repo.listRoleAssignments(orgUuid, actor.subjectId);
    if (!rolesResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const authResult = await authorizeViaPolicy(policyWorker, {
      actor,
      action: "organization.invitation.list",
      resource: { kind: "organization", id: orgUuid, orgId: orgUuid },
      orgId: orgUuid,
      roleAssignments: rolesResult.value,
      requestId,
    });

    if (!authResult.allow) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const listResult = await repo.listInvitationsPaged(orgUuid, pageParams);
    if (!listResult.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    const { items, nextCursor } = listResult.value;
    const now = new Date();
    const invitations = items.map((inv) => ({
      id: invitationPublicId(inv.id),
      email: inv.email,
      role: inv.role,
      status: deriveStatus(inv, now),
      invitedBy: inv.invitedBy,
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
      acceptedAt: inv.acceptedAt ? inv.acceptedAt.toISOString() : null,
      revokedAt: inv.revokedAt ? inv.revokedAt.toISOString() : null,
    }));

    const cursorToken = nextCursor ? encodeCursor(nextCursor.createdAt, nextCursor.id) : null;
    return successResponse({ invitations }, requestId, 200, cursorToken);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

function deriveStatus(inv: { status: string; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }, now: Date): string {
  if (inv.revokedAt) return "revoked";
  if (inv.acceptedAt) return "accepted";
  if (inv.status === "pending" && inv.expiresAt < now) return "expired";
  return inv.status;
}
