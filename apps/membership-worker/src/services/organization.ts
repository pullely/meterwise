import type { MembershipRepository, RoleAssignment } from "@saas/db/membership";
import type { Uuid } from "@saas/db/ids";
import { orgPublicId } from "../ids.js";

export type PolicyAuthorizer = (
  actor: ActorContext,
  action: string,
  orgId: string,
  roleAssignments: RoleAssignment[],
) => Promise<{ allow: boolean }>;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

export interface OrganizationServiceDeps {
  repo: Pick<MembershipRepository, "listRoleAssignments" | "getOrganizationById">;
  now: () => Date;
}

export type GetOrgResult =
  | { ok: true; value: { organization: { id: string; name: string; slug: string; createdAt: string } } }
  | { ok: false; code: string; message: string; status: number };

export function createOrganizationService(deps: OrganizationServiceDeps) {
  const { repo } = deps;

  return {
    async getOrganization(actor: ActorContext, orgUuid: Uuid, authorize?: PolicyAuthorizer): Promise<GetOrgResult> {
      const rolesResult = await repo.listRoleAssignments(orgUuid, actor.subjectId);
      if (!rolesResult.ok) {
        return { ok: false, code: "not_found", message: "Organization not found", status: 404 };
      }

      const roleAssignments = rolesResult.value;

      if (authorize) {
        const authResult = await authorize(actor, "organization.read", orgUuid, roleAssignments);
        if (!authResult.allow) {
          return { ok: false, code: "not_found", message: "Organization not found", status: 404 };
        }
      } else {
        // Fallback: fail closed when no authorizer is available
        return { ok: false, code: "not_found", message: "Organization not found", status: 404 };
      }

      const orgResult = await repo.getOrganizationById(orgUuid);
      if (!orgResult.ok) {
        return { ok: false, code: "not_found", message: "Organization not found", status: 404 };
      }

      const org = orgResult.value;
      return {
        ok: true,
        value: {
          organization: {
            id: orgPublicId(org.id),
            name: org.name,
            slug: org.slug,
            createdAt: org.createdAt.toISOString(),
          },
        },
      };
    },
  };
}
