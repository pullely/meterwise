import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { createOrganizationService } from "../services/organization.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse } from "../http.js";
import { parseOrgPublicId } from "../ids.js";

export async function handleGetOrganization(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  if (!env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const policyWorker = env.POLICY_WORKER;

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createMembershipRepository(executor);
    const service = createOrganizationService({ repo, now: () => new Date() });

    const authorize = async (
      actorCtx: ActorContext,
      action: string,
      orgId: string,
      roleAssignments: Parameters<typeof authorizeViaPolicy>[1]["roleAssignments"],
    ) => {
      return authorizeViaPolicy(policyWorker, {
        actor: actorCtx,
        action,
        resource: { kind: "organization", id: orgId, orgId },
        orgId,
        roleAssignments,
        requestId,
      });
    };

    const result = await service.getOrganization(actor, orgUuid, authorize);

    if (!result.ok) {
      return errorResponse(result.code, result.message, result.status, requestId);
    }

    return successResponse(result.value, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
