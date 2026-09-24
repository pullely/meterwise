import type { Env } from "../env.js";
import type { MembershipRepository, CreateRoleAssignmentInput, RoleAssignment } from "@saas/db/membership";
import { createMembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/d1";
import { asUuid, isUuid } from "@saas/db/ids";
import { isServicePrincipalSubjectId } from "@saas/contracts/service-principal";
import { errorResponse, successResponse, validationError } from "../http.js";

const VALID_SCOPE_KINDS = new Set(["organization", "project"]);
const VALID_ORG_ROLES = new Set(["owner", "admin", "builder", "viewer", "billing_admin"]);
const VALID_PROJECT_ROLES = new Set(["project_admin", "project_builder", "project_viewer"]);

export interface ServicePrincipalBindingDeps {
  repo?: MembershipRepository;
}

function isValidRole(role: string, scopeKind: string): boolean {
  if (scopeKind === "organization") return VALID_ORG_ROLES.has(role);
  if (scopeKind === "project") return VALID_PROJECT_ROLES.has(role);
  return false;
}

// POST /v1/internal/membership/service-principal-bindings
export async function handleCreateServicePrincipalBinding(
  request: Request,
  env: Env,
  requestId: string,
  deps?: ServicePrincipalBindingDeps,
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

  const b = body as Record<string, unknown>;
  const errors: Record<string, string[]> = {};

  if (typeof b.orgId !== "string" || b.orgId.length === 0) {
    errors.orgId = ["Required"];
  } else if (!isUuid(b.orgId)) {
    errors.orgId = ["Must be a valid UUID"];
  }
  if (typeof b.subjectId !== "string" || !isServicePrincipalSubjectId(b.subjectId)) {
    errors.subjectId = ["Must be a valid service_principal subject ID (sp_<hex32>)"];
  }
  if (typeof b.role !== "string" || b.role.length === 0) {
    errors.role = ["Required"];
  }
  if (typeof b.scopeKind !== "string" || !VALID_SCOPE_KINDS.has(b.scopeKind)) {
    errors.scopeKind = ["Must be 'organization' or 'project'"];
  }
  if (b.scopeKind === "project" && (typeof b.scopeRef !== "string" || b.scopeRef.length === 0)) {
    errors.scopeRef = ["Required for project scope"];
  }

  if (Object.keys(errors).length > 0) {
    return validationError(requestId, errors);
  }

  const orgId = asUuid(b.orgId as string);
  const subjectId = b.subjectId as string;
  const role = b.role as string;
  const scopeKind = b.scopeKind as string;
  const scopeRef = scopeKind === "project" ? (b.scopeRef as string) : null;

  if (!isValidRole(role, scopeKind)) {
    return validationError(requestId, { role: [`Invalid role '${role}' for scope '${scopeKind}'`] });
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB);
  const repo = deps?.repo ?? createMembershipRepository(executor!);

  try {
    const id = crypto.randomUUID();
    const input: CreateRoleAssignmentInput = {
      id,
      orgId,
      subjectId,
      subjectType: "service_principal",
      role,
      scopeKind,
      scopeRef,
      createdAt: new Date(),
    };

    const result = await repo.createRoleAssignment(input);
    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "Role assignment already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Failed to create role assignment", 500, requestId);
    }

    return successResponse(sanitizeAssignment(result.value), requestId, 201);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// GET /v1/internal/membership/service-principal-bindings?orgId=X&subjectId=Y
export async function handleListServicePrincipalBindings(
  env: Env,
  requestId: string,
  url: URL,
  deps?: ServicePrincipalBindingDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const orgId = url.searchParams.get("orgId");
  const subjectId = url.searchParams.get("subjectId");

  if (!orgId || orgId.length === 0) {
    return validationError(requestId, { orgId: ["Required query parameter"] });
  }
  if (!subjectId || !isServicePrincipalSubjectId(subjectId)) {
    return validationError(requestId, { subjectId: ["Must be a valid service_principal subject ID (sp_<hex32>)"] });
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB);
  const repo = deps?.repo ?? createMembershipRepository(executor!);

  try {
    const result = await repo.listRoleAssignments(asUuid(orgId), subjectId);
    if (!result.ok) {
      return errorResponse("internal_error", "Failed to list role assignments", 500, requestId);
    }

    // Filter to only active (non-revoked) service_principal bindings
    const active = result.value.filter(
      (ra) => ra.subjectType === "service_principal" && ra.revokedAt === null,
    );

    return successResponse(active.map(sanitizeAssignment), requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// DELETE /v1/internal/membership/service-principal-bindings/:bindingId?orgId=X
export async function handleRevokeServicePrincipalBinding(
  env: Env,
  requestId: string,
  bindingId: string,
  url: URL,
  deps?: ServicePrincipalBindingDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const orgId = url.searchParams.get("orgId");
  if (!orgId || orgId.length === 0) {
    return validationError(requestId, { orgId: ["Required query parameter"] });
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB);
  const repo = deps?.repo ?? createMembershipRepository(executor!);

  try {
    const result = await repo.revokeRoleAssignment(asUuid(orgId), bindingId, new Date());
    if (!result.ok) {
      if (result.error.kind === "not_found") {
        return errorResponse("not_found", "Role assignment not found", 404, requestId);
      }
      return errorResponse("internal_error", "Failed to revoke role assignment", 500, requestId);
    }

    return successResponse(sanitizeAssignment(result.value), requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

function sanitizeAssignment(ra: RoleAssignment) {
  return {
    id: ra.id,
    orgId: ra.orgId,
    subjectId: ra.subjectId,
    subjectType: ra.subjectType,
    role: ra.role,
    scopeKind: ra.scopeKind,
    scopeRef: ra.scopeRef,
    createdAt: ra.createdAt.toISOString(),
    revokedAt: ra.revokedAt ? ra.revokedAt.toISOString() : null,
  };
}
