import type { MembershipFact, TenancyRole, RoleScopeKind } from "@saas/contracts/policy";
import type { RoleAssignment } from "@saas/db/membership";

export function mapRoleAssignmentsToFacts(orgId: string, assignments: RoleAssignment[]): MembershipFact[] {
  return assignments.map((ra) => {
    const scope: MembershipFact["scope"] =
      ra.scopeKind === "project"
        ? { kind: "project" as RoleScopeKind, orgId, ...(ra.scopeRef ? { projectId: ra.scopeRef } : {}) }
        : { kind: "organization" as RoleScopeKind, orgId };
    return { kind: "role_assignment" as const, role: ra.role as TenancyRole, scope };
  });
}
