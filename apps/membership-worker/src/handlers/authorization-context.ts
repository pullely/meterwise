import type { Env } from "../env.js";
import type { AuthorizationContextRequest, AuthorizationContextResponse } from "@saas/contracts/policy";
import type { MembershipRepository } from "@saas/db/membership";
import { createMembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/d1";
import { asUuid } from "@saas/db/ids";
import { mapRoleAssignmentsToFacts } from "../membership-facts.js";
import { errorResponse, successResponse, validationError } from "../http.js";

const SUBJECT_TYPES = new Set(["user", "service_principal", "workflow", "system"]);

export interface HandleAuthorizationContextDeps {
  repo?: MembershipRepository;
}

export async function handleAuthorizationContext(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleAuthorizationContextDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be an object"] });
  }

  const req = body as Record<string, unknown>;

  if (!req.subject || typeof req.subject !== "object") {
    return validationError(requestId, { subject: ["Required"] });
  }
  const subject = req.subject as Record<string, unknown>;
  if (typeof subject.type !== "string" || !SUBJECT_TYPES.has(subject.type)) {
    return validationError(requestId, { "subject.type": ["Must be one of: user, service_principal, workflow, system"] });
  }
  if (typeof subject.id !== "string" || subject.id.length === 0) {
    return validationError(requestId, { "subject.id": ["Required"] });
  }

  if (typeof req.orgId !== "string" || req.orgId.length === 0) {
    return validationError(requestId, { orgId: ["Required"] });
  }

  const typedReq: AuthorizationContextRequest = {
    subject: { type: subject.type as AuthorizationContextRequest["subject"]["type"], id: subject.id },
    orgId: req.orgId,
  };

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB);
  const repo = deps?.repo ?? createMembershipRepository(executor!);

  try {
    const rolesResult = await repo.listRoleAssignments(asUuid(typedReq.orgId), typedReq.subject.id);
    if (!rolesResult.ok) {
      return errorResponse("internal_error", "Failed to retrieve authorization context", 500, requestId);
    }

    const memberships = mapRoleAssignmentsToFacts(typedReq.orgId, rolesResult.value);
    const responseBody: AuthorizationContextResponse = { memberships };

    return successResponse(responseBody, requestId);
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    console.error("[membership] authorization-context failed", {
      requestId,
      name: typeof e?.name === "string" ? e.name : undefined,
      message: typeof e?.message === "string" ? e.message : undefined,
      code: typeof e?.code === "string" ? e.code : undefined,
    });
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
