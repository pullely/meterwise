import type { OrganizationRole, ProjectRole, TenancyRole, RoleScopeKind } from "./tenancy.js";

export type SubjectType = "user" | "service_principal" | "workflow" | "system";

export interface PolicySubject {
  type: SubjectType;
  id: string;
}

export interface PolicyResource {
  kind: string;
  id?: string;
  orgId: string;
  projectId?: string;
  environmentId?: string;
}

export interface MembershipFact {
  kind: "role_assignment";
  role: TenancyRole;
  scope: {
    kind: RoleScopeKind;
    orgId: string;
    projectId?: string;
  };
}

export type PolicyMembershipFact = MembershipFact | Record<string, unknown>;

export interface PolicyContext {
  memberships: PolicyMembershipFact[];
  attributes?: Record<string, unknown>;
}

export interface AuthorizationRequest {
  subject: PolicySubject;
  action: string;
  resource: PolicyResource;
  context: PolicyContext;
}

export interface AuthorizationResponse {
  allow: boolean;
  reason: string;
  policyVersion: number;
  derivedScope: {
    orgId: string;
    projectId?: string;
  };
}

export interface EffectivePermissionsRequest {
  subject: PolicySubject;
  resource: PolicyResource;
  context: PolicyContext;
}

export interface EffectivePermission {
  action: string;
  allow: boolean;
  reason: string;
}

export interface EffectivePermissionsResponse {
  permissions: EffectivePermission[];
  policyVersion: number;
  derivedScope: {
    orgId: string;
    projectId?: string;
  };
}

export interface RoleAssignmentValidationRequest {
  role: string;
  scope: {
    kind: string;
    orgId: string;
    projectId?: string;
  };
}

export interface RoleAssignmentValidationResponse {
  valid: boolean;
  reason: string;
  policyVersion: number;
}

export const ORGANIZATION_ACTIONS = [
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
] as const;

export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];

export const POLICY_VERSION = 1;

export interface AuthorizationContextRequest {
  subject: PolicySubject;
  orgId: string;
}

export interface AuthorizationContextResponse {
  memberships: MembershipFact[];
}

export type { OrganizationRole, ProjectRole, TenancyRole, RoleScopeKind };
