// Tenancy contract types
// Every resource must be traceable to an organization.

export interface OrgScoped {
  orgId: string;
}

export interface ProjectScoped extends OrgScoped {
  projectId: string;
}

export interface TenantContext {
  orgId: string;
  projectId?: string;
  actorId: string;
  actorKind: "user" | "service_principal" | "workflow" | "system";
}

export type OrganizationRole =
  | "owner"
  | "admin"
  | "builder"
  | "viewer"
  | "billing_admin";

export type ProjectRole =
  | "project_admin"
  | "project_builder"
  | "project_viewer";

export type TenancyRole = OrganizationRole | ProjectRole;

export type RoleScopeKind = "organization" | "project";

export interface RoleAssignmentFact {
  role: TenancyRole;
  scope: {
    kind: RoleScopeKind;
    orgId: string;
    projectId?: string;
  };
  subjectId: string;
  subjectType: "user" | "service_principal";
}
