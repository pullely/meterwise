import type {
  AuthorizationRequest,
  AuthorizationResponse,
  EffectivePermissionsRequest,
  EffectivePermissionsResponse,
  EffectivePermission,
  RoleAssignmentValidationRequest,
  RoleAssignmentValidationResponse,
  MembershipFact,
  OrganizationRole,
  ProjectRole,
} from "@saas/contracts/policy";

export { POLICY_VERSION } from "@saas/contracts/policy";
import { POLICY_VERSION } from "@saas/contracts/policy";

const ORG_ROLE_PERMISSIONS: Record<OrganizationRole, readonly string[]> = {
  owner: [
    "organization.read",
    "organization.settings.update",
    "organization.invitation.create",
    "organization.invitation.list",
    "organization.invitation.revoke",
    "organization.member.list",
    "organization.member.remove",
    "organization.member.update_role",
    "organization.service_principal.binding.create",
    "organization.service_principal.binding.list",
    "organization.service_principal.binding.revoke",
    "organization.api_key.create",
    "organization.api_key.list",
    "organization.api_key.revoke",
    "project.create",
    "project.list",
    "project.read",
    "project.update",
    "project.delete",
    "environment.create",
    "environment.read",
    "environment.update",
    "environment.delete",
    "audit.read",
    "billing.read",
    "billing.manage",
    "organization.config.read",
    "organization.config.write",
    "organization.webhook.read",
    "organization.webhook.write",
    "project.config.read",
    "project.config.write",
    "project.webhook.read",
    "project.webhook.write",
    "organization.metering.read",
    "organization.metering.write",
    "organization.integration.read",
    "organization.integration.connect",
    "organization.integration.manage",
    "organization.integration.token.issue",
    "project.repo_link.write",
  ],
  admin: [
    "organization.read",
    "organization.settings.update",
    "organization.invitation.create",
    "organization.invitation.list",
    "organization.invitation.revoke",
    "organization.member.list",
    "organization.member.remove",
    "organization.member.update_role",
    "organization.service_principal.binding.create",
    "organization.service_principal.binding.list",
    "organization.service_principal.binding.revoke",
    "organization.api_key.create",
    "organization.api_key.list",
    "organization.api_key.revoke",
    "project.create",
    "project.list",
    "project.read",
    "project.update",
    "project.delete",
    "environment.create",
    "environment.read",
    "environment.update",
    "environment.delete",
    "audit.read",
    "organization.config.read",
    "organization.config.write",
    "organization.webhook.read",
    "organization.webhook.write",
    "project.config.read",
    "project.config.write",
    "project.webhook.read",
    "project.webhook.write",
    "organization.metering.read",
    "organization.metering.write",
    "organization.integration.read",
    "organization.integration.connect",
    "organization.integration.manage",
    "organization.integration.token.issue",
    "project.repo_link.write",
  ],
  builder: [
    "organization.read",
    "project.create",
    "project.list",
    "project.read",
    "project.update",
    "environment.create",
    "environment.read",
    "environment.update",
    "organization.config.read",
    "organization.webhook.read",
    "project.config.read",
    "project.webhook.read",
    "organization.metering.read",
    "organization.integration.read",
  ],
  viewer: [
    "organization.read",
    "project.list",
    "project.read",
    "environment.read",
    "organization.config.read",
    "organization.webhook.read",
    "project.config.read",
    "project.webhook.read",
    "organization.metering.read",
    "organization.integration.read",
  ],
  billing_admin: [
    "organization.read",
    "billing.read",
    "billing.manage",
  ],
};

const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, readonly string[]> = {
  project_admin: [
    "project.repo_link.write",
    "project.read",
    "project.update",
    "project.delete",
    "environment.create",
    "environment.read",
    "environment.update",
    "environment.delete",
    "organization.api_key.create",
    "organization.api_key.list",
    "organization.api_key.revoke",
    "project.config.read",
    "project.config.write",
    "project.webhook.read",
    "project.webhook.write",
  ],
  project_builder: [
    "project.read",
    "project.update",
    "environment.create",
    "environment.read",
    "environment.update",
    "project.config.read",
    "project.webhook.read",
  ],
  project_viewer: [
    "project.read",
    "environment.read",
    "project.config.read",
    "project.webhook.read",
  ],
};

const VALID_ORG_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "builder",
  "viewer",
  "billing_admin",
]);

const VALID_PROJECT_ROLES: ReadonlySet<string> = new Set([
  "project_admin",
  "project_builder",
  "project_viewer",
]);

const PROJECT_SCOPED_ACTIONS: ReadonlySet<string> = new Set([
  "project.repo_link.write",
  "project.read",
  "project.update",
  "project.delete",
  "environment.create",
  "environment.read",
  "environment.update",
  "environment.delete",
  "project.config.read",
  "project.config.write",
]);

// Actions that project roles can authorize when a projectId narrows the request.
// Unlike PROJECT_SCOPED_ACTIONS, these do NOT require projectId — they are org-level
// actions that project-admin can perform only when explicitly scoped to their project.
const PROJECT_GRANTABLE_ACTIONS: ReadonlySet<string> = new Set([
  "organization.api_key.create",
  "organization.api_key.list",
  "organization.api_key.revoke",
]);

const ALL_KNOWN_ACTIONS: ReadonlySet<string> = new Set([
  "organization.read",
  "organization.settings.update",
  "organization.invitation.create",
  "organization.invitation.list",
  "organization.invitation.revoke",
  "organization.member.list",
  "organization.member.remove",
  "organization.member.update_role",
  "organization.service_principal.binding.create",
  "organization.service_principal.binding.list",
  "organization.service_principal.binding.revoke",
  "organization.api_key.create",
  "organization.api_key.list",
  "organization.api_key.revoke",
  "project.create",
  "project.list",
  "project.read",
  "project.update",
  "project.delete",
  "environment.create",
  "environment.read",
  "environment.update",
  "environment.delete",
  "audit.read",
  "billing.read",
  "billing.manage",
  "organization.config.read",
  "organization.config.write",
  "organization.webhook.read",
  "organization.webhook.write",
  "project.config.read",
  "project.config.write",
  "project.webhook.read",
  "project.webhook.write",
  "organization.metering.read",
  "organization.metering.write",
  "organization.integration.read",
  "organization.integration.connect",
  "organization.integration.manage",
  "organization.integration.token.issue",
  "project.repo_link.write",
]);

function isOrgRole(role: string): role is OrganizationRole {
  return VALID_ORG_ROLES.has(role);
}

function isProjectRole(role: string): role is ProjectRole {
  return VALID_PROJECT_ROLES.has(role);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function isRoleAssignmentFact(fact: unknown): fact is MembershipFact {
  if (!isRecord(fact)) return false;
  if (fact.kind !== "role_assignment" || typeof fact.role !== "string") return false;
  if (!isRecord(fact.scope)) return false;
  return typeof fact.scope.kind === "string" && typeof fact.scope.orgId === "string";
}

function buildScope(orgId: string, projectId?: string): { orgId: string; projectId?: string } {
  if (typeof projectId === "string" && projectId.length > 0) return { orgId, projectId };
  return { orgId };
}

function deny(reason: string, orgId: string, projectId?: string): AuthorizationResponse {
  return { allow: false, reason, policyVersion: POLICY_VERSION, derivedScope: buildScope(orgId, projectId) };
}

function allow(reason: string, orgId: string, projectId?: string): AuthorizationResponse {
  return { allow: true, reason, policyVersion: POLICY_VERSION, derivedScope: buildScope(orgId, projectId) };
}

export function authorize(input: AuthorizationRequest): AuthorizationResponse {
  const { action, resource, context } = input;
  const orgId = resource.orgId;
  const projectId = typeof resource.projectId === "string" ? resource.projectId : undefined;

  if (!orgId) {
    return deny("invalid_scope", "");
  }

  if (!ALL_KNOWN_ACTIONS.has(action)) {
    return deny("unknown_action", orgId, projectId);
  }

  if (PROJECT_SCOPED_ACTIONS.has(action) && !projectId) {
    return deny("invalid_scope", orgId);
  }

  const relevantFacts = context.memberships.filter(isRoleAssignmentFact).filter(
    (f) => f.scope.orgId === orgId,
  );

  if (relevantFacts.length === 0) {
    return deny("no_matching_role", orgId, projectId);
  }

  for (const fact of relevantFacts) {
    if (fact.scope.kind === "organization" && isOrgRole(fact.role)) {
      const permissions = ORG_ROLE_PERMISSIONS[fact.role];
      if (permissions.includes(action)) {
        if (PROJECT_SCOPED_ACTIONS.has(action) && projectId) {
          return allow(`org_${fact.role}`, orgId, projectId);
        }
        if (!PROJECT_SCOPED_ACTIONS.has(action) || !projectId) {
          return allow(`org_${fact.role}`, orgId, projectId);
        }
      }
    }

    if (
      fact.scope.kind === "project" &&
      isProjectRole(fact.role) &&
      (PROJECT_SCOPED_ACTIONS.has(action) || PROJECT_GRANTABLE_ACTIONS.has(action))
    ) {
      if (!projectId || fact.scope.projectId !== projectId) {
        continue;
      }
      const permissions = PROJECT_ROLE_PERMISSIONS[fact.role];
      if (permissions.includes(action)) {
        return allow(fact.role, orgId, projectId);
      }
    }
  }

  return deny("no_matching_role", orgId, projectId);
}

export function listEffectivePermissions(
  input: EffectivePermissionsRequest,
): EffectivePermissionsResponse {
  const { resource, context } = input;
  const orgId = resource.orgId;
  const projectId = resource.projectId;

  const permissions: EffectivePermission[] = [];
  const seen = new Set<string>();

  for (const action of ALL_KNOWN_ACTIONS) {
    if (seen.has(action)) continue;

    const result = authorize({
      subject: input.subject,
      action,
      resource,
      context,
    });

    seen.add(action);
    permissions.push({
      action,
      allow: result.allow,
      reason: result.reason,
    });
  }

  return {
    permissions,
    policyVersion: POLICY_VERSION,
    derivedScope: buildScope(orgId, projectId),
  };
}

export function validateRoleAssignment(
  input: RoleAssignmentValidationRequest,
): RoleAssignmentValidationResponse {
  const { role, scope } = input;

  if (typeof scope.orgId !== "string" || scope.orgId.length === 0) {
    return { valid: false, reason: "missing_org_id", policyVersion: POLICY_VERSION };
  }

  if (scope.kind === "organization") {
    if (!VALID_ORG_ROLES.has(role)) {
      return { valid: false, reason: "invalid_role_for_scope", policyVersion: POLICY_VERSION };
    }
    return { valid: true, reason: "valid_org_role", policyVersion: POLICY_VERSION };
  }

  if (scope.kind === "project") {
    if (typeof scope.projectId !== "string" || scope.projectId.length === 0) {
      return { valid: false, reason: "missing_project_id", policyVersion: POLICY_VERSION };
    }
    if (!VALID_PROJECT_ROLES.has(role)) {
      return { valid: false, reason: "invalid_role_for_scope", policyVersion: POLICY_VERSION };
    }
    return { valid: true, reason: "valid_project_role", policyVersion: POLICY_VERSION };
  }

  return { valid: false, reason: "unknown_scope_kind", policyVersion: POLICY_VERSION };
}
