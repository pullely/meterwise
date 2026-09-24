import { authorize, listEffectivePermissions, validateRoleAssignment } from "@saas/policy-engine";
import type {
  AuthorizationRequest,
  EffectivePermissionsRequest,
  MembershipFact,
  PolicyMembershipFact,
  PolicySubject,
  PolicyResource,
} from "@saas/contracts/policy";
import type { TenancyRole, RoleScopeKind } from "@saas/contracts/tenancy";

const subject: PolicySubject = { type: "user", id: "usr_abc123" };

function orgFact(role: string, orgId: string): MembershipFact {
  return { kind: "role_assignment", role: role as TenancyRole, scope: { kind: "organization", orgId } };
}

function projectFact(role: string, orgId: string, projectId: string): MembershipFact {
  return {
    kind: "role_assignment",
    role: role as TenancyRole,
    scope: { kind: "project", orgId, projectId },
  };
}

function authReq(
  action: string,
  orgId: string,
  memberships: PolicyMembershipFact[],
  projectId?: string,
): AuthorizationRequest {
  const resource: PolicyResource = { kind: "organization", orgId };
  if (projectId) resource.projectId = projectId;
  return {
    subject,
    action,
    resource,
    context: { memberships },
  };
}

describe("authorize", () => {
  describe("deny-by-default", () => {
    it("denies when no memberships are present", () => {
      const result = authorize(authReq("organization.read", "org_1", []));
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("no_matching_role");
      expect(result.policyVersion).toBe(1);
    });

    it("denies unknown actions", () => {
      const result = authorize(authReq("organization.destroy", "org_1", [orgFact("owner", "org_1")]));
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("unknown_action");
    });

    it("denies when orgId is missing", () => {
      const result = authorize({
        subject,
        action: "organization.read",
        resource: { kind: "organization", orgId: "" },
        context: { memberships: [orgFact("owner", "org_1")] },
      });
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("invalid_scope");
    });

    it("denies project-scoped actions when projectId is missing", () => {
      for (const action of [
        "project.read",
        "project.update",
        "project.delete",
        "environment.read",
        "environment.update",
        "environment.delete",
      ]) {
        const result = authorize(authReq(action, "org_1", [orgFact("owner", "org_1")]));
        expect(result.allow).toBe(false);
        expect(result.reason).toBe("invalid_scope");
      }
    });
  });

  describe("cross-organization denial", () => {
    it("denies access when role is for a different organization", () => {
      const result = authorize(authReq("organization.read", "org_2", [orgFact("owner", "org_1")]));
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("no_matching_role");
    });

    it("denies project access when role org does not match resource org", () => {
      const result = authorize(
        authReq("project.read", "org_2", [projectFact("project_admin", "org_1", "prj_1")], "prj_1"),
      );
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("no_matching_role");
    });
  });

  describe("owner role", () => {
    const facts = [orgFact("owner", "org_1")];

    it("allows organization.read", () => {
      const result = authorize(authReq("organization.read", "org_1", facts));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_owner");
    });

    it("allows organization.settings.update", () => {
      const result = authorize(authReq("organization.settings.update", "org_1", facts));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_owner");
    });

    it("allows organization.invitation.create", () => {
      const result = authorize(authReq("organization.invitation.create", "org_1", facts));
      expect(result.allow).toBe(true);
    });

    it("allows organization.member.list", () => {
      const result = authorize(authReq("organization.member.list", "org_1", facts));
      expect(result.allow).toBe(true);
    });

    it("allows organization.member.remove", () => {
      const result = authorize(authReq("organization.member.remove", "org_1", facts));
      expect(result.allow).toBe(true);
    });

    it("allows organization.member.update_role", () => {
      const result = authorize(authReq("organization.member.update_role", "org_1", facts));
      expect(result.allow).toBe(true);
    });

    it("allows project.create", () => {
      const result = authorize(authReq("project.create", "org_1", facts));
      expect(result.allow).toBe(true);
    });

    it("allows project.read with projectId", () => {
      const result = authorize(authReq("project.read", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_owner");
    });

    it("allows project.update", () => {
      const result = authorize(authReq("project.update", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
    });

    it("allows project.delete", () => {
      const result = authorize(authReq("project.delete", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
    });

    it("allows environment.read", () => {
      const result = authorize(authReq("environment.read", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
    });

    it("allows environment.create", () => {
      const result = authorize(authReq("environment.create", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
    });

    it("allows environment.update", () => {
      const result = authorize(authReq("environment.update", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
    });

    it("allows environment.delete", () => {
      const result = authorize(authReq("environment.delete", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
    });

    it("allows billing.read", () => {
      const result = authorize(authReq("billing.read", "org_1", facts));
      expect(result.allow).toBe(true);
    });

    it("allows billing.manage", () => {
      const result = authorize(authReq("billing.manage", "org_1", facts));
      expect(result.allow).toBe(true);
    });
  });

  describe("admin role", () => {
    const facts = [orgFact("admin", "org_1")];

    it("allows organization.read", () => {
      const result = authorize(authReq("organization.read", "org_1", facts));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_admin");
    });

    it("allows organization.settings.update", () => {
      const result = authorize(authReq("organization.settings.update", "org_1", facts));
      expect(result.allow).toBe(true);
    });

    it("allows invitation management", () => {
      expect(authorize(authReq("organization.invitation.create", "org_1", facts)).allow).toBe(true);
      expect(authorize(authReq("organization.invitation.list", "org_1", facts)).allow).toBe(true);
      expect(authorize(authReq("organization.invitation.revoke", "org_1", facts)).allow).toBe(true);
    });

    it("allows member management", () => {
      expect(authorize(authReq("organization.member.list", "org_1", facts)).allow).toBe(true);
      expect(authorize(authReq("organization.member.remove", "org_1", facts)).allow).toBe(true);
      expect(authorize(authReq("organization.member.update_role", "org_1", facts)).allow).toBe(true);
    });

    it("allows project CRUD", () => {
      expect(authorize(authReq("project.create", "org_1", facts)).allow).toBe(true);
      expect(authorize(authReq("project.read", "org_1", facts, "prj_1")).allow).toBe(true);
      expect(authorize(authReq("project.update", "org_1", facts, "prj_1")).allow).toBe(true);
      expect(authorize(authReq("project.delete", "org_1", facts, "prj_1")).allow).toBe(true);
    });

    it("allows environment access", () => {
      expect(authorize(authReq("environment.create", "org_1", facts, "prj_1")).allow).toBe(true);
      expect(authorize(authReq("environment.read", "org_1", facts, "prj_1")).allow).toBe(true);
      expect(authorize(authReq("environment.update", "org_1", facts, "prj_1")).allow).toBe(true);
      expect(authorize(authReq("environment.delete", "org_1", facts, "prj_1")).allow).toBe(true);
    });

    it("denies billing.read", () => {
      expect(authorize(authReq("billing.read", "org_1", facts)).allow).toBe(false);
    });

    it("denies billing.manage", () => {
      expect(authorize(authReq("billing.manage", "org_1", facts)).allow).toBe(false);
    });
  });

  describe("builder role", () => {
    const facts = [orgFact("builder", "org_1")];

    it("allows organization.read", () => {
      expect(authorize(authReq("organization.read", "org_1", facts)).allow).toBe(true);
      expect(authorize(authReq("organization.read", "org_1", facts)).reason).toBe("org_builder");
    });

    it("allows project.create", () => {
      expect(authorize(authReq("project.create", "org_1", facts)).allow).toBe(true);
    });

    it("allows project.read and project.update", () => {
      expect(authorize(authReq("project.read", "org_1", facts, "prj_1")).allow).toBe(true);
      expect(authorize(authReq("project.update", "org_1", facts, "prj_1")).allow).toBe(true);
    });

    it("allows environment access", () => {
      expect(authorize(authReq("environment.create", "org_1", facts, "prj_1")).allow).toBe(true);
      expect(authorize(authReq("environment.read", "org_1", facts, "prj_1")).allow).toBe(true);
      expect(authorize(authReq("environment.update", "org_1", facts, "prj_1")).allow).toBe(true);
    });

    it("denies environment.delete", () => {
      expect(authorize(authReq("environment.delete", "org_1", facts, "prj_1")).allow).toBe(false);
    });

    it("denies organization.settings.update", () => {
      expect(authorize(authReq("organization.settings.update", "org_1", facts)).allow).toBe(false);
    });

    it("denies member management", () => {
      expect(authorize(authReq("organization.member.list", "org_1", facts)).allow).toBe(false);
      expect(authorize(authReq("organization.member.remove", "org_1", facts)).allow).toBe(false);
    });

    it("denies invitation management", () => {
      expect(authorize(authReq("organization.invitation.create", "org_1", facts)).allow).toBe(false);
    });

    it("denies billing", () => {
      expect(authorize(authReq("billing.read", "org_1", facts)).allow).toBe(false);
      expect(authorize(authReq("billing.manage", "org_1", facts)).allow).toBe(false);
    });

    it("denies project.delete", () => {
      expect(authorize(authReq("project.delete", "org_1", facts, "prj_1")).allow).toBe(false);
    });
  });

  describe("viewer role", () => {
    const facts = [orgFact("viewer", "org_1")];

    it("allows organization.read", () => {
      expect(authorize(authReq("organization.read", "org_1", facts)).allow).toBe(true);
      expect(authorize(authReq("organization.read", "org_1", facts)).reason).toBe("org_viewer");
    });

    it("allows project.read", () => {
      expect(authorize(authReq("project.read", "org_1", facts, "prj_1")).allow).toBe(true);
    });

    it("allows environment.read", () => {
      expect(authorize(authReq("environment.read", "org_1", facts, "prj_1")).allow).toBe(true);
    });

    it("denies all write actions", () => {
      expect(authorize(authReq("organization.settings.update", "org_1", facts)).allow).toBe(false);
      expect(authorize(authReq("project.create", "org_1", facts)).allow).toBe(false);
      expect(authorize(authReq("project.update", "org_1", facts, "prj_1")).allow).toBe(false);
      expect(authorize(authReq("project.delete", "org_1", facts, "prj_1")).allow).toBe(false);
      expect(authorize(authReq("environment.create", "org_1", facts, "prj_1")).allow).toBe(false);
      expect(authorize(authReq("environment.update", "org_1", facts, "prj_1")).allow).toBe(false);
      expect(authorize(authReq("environment.delete", "org_1", facts, "prj_1")).allow).toBe(false);
      expect(authorize(authReq("billing.read", "org_1", facts)).allow).toBe(false);
      expect(authorize(authReq("billing.manage", "org_1", facts)).allow).toBe(false);
    });
  });

  describe("billing_admin role", () => {
    const facts = [orgFact("billing_admin", "org_1")];

    it("allows organization.read", () => {
      expect(authorize(authReq("organization.read", "org_1", facts)).allow).toBe(true);
      expect(authorize(authReq("organization.read", "org_1", facts)).reason).toBe("org_billing_admin");
    });

    it("allows billing.read and billing.manage", () => {
      expect(authorize(authReq("billing.read", "org_1", facts)).allow).toBe(true);
      expect(authorize(authReq("billing.manage", "org_1", facts)).allow).toBe(true);
    });

    it("denies member management", () => {
      expect(authorize(authReq("organization.member.list", "org_1", facts)).allow).toBe(false);
    });

    it("denies project management", () => {
      expect(authorize(authReq("project.create", "org_1", facts)).allow).toBe(false);
      expect(authorize(authReq("project.read", "org_1", facts, "prj_1")).allow).toBe(false);
    });

    it("denies project.list", () => {
      expect(authorize(authReq("project.list", "org_1", facts)).allow).toBe(false);
    });

    it("denies settings", () => {
      expect(authorize(authReq("organization.settings.update", "org_1", facts)).allow).toBe(false);
    });
  });

  describe("project.list action", () => {
    it("allows owner to list projects", () => {
      const result = authorize(authReq("project.list", "org_1", [orgFact("owner", "org_1")]));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_owner");
    });

    it("allows admin to list projects", () => {
      const result = authorize(authReq("project.list", "org_1", [orgFact("admin", "org_1")]));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_admin");
    });

    it("allows builder to list projects", () => {
      const result = authorize(authReq("project.list", "org_1", [orgFact("builder", "org_1")]));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_builder");
    });

    it("allows viewer to list projects", () => {
      const result = authorize(authReq("project.list", "org_1", [orgFact("viewer", "org_1")]));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_viewer");
    });

    it("denies billing_admin from listing projects", () => {
      const result = authorize(authReq("project.list", "org_1", [orgFact("billing_admin", "org_1")]));
      expect(result.allow).toBe(false);
    });

    it("denies when no memberships", () => {
      const result = authorize(authReq("project.list", "org_1", []));
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("no_matching_role");
    });

    it("denies cross-org facts", () => {
      const result = authorize(authReq("project.list", "org_2", [orgFact("owner", "org_1")]));
      expect(result.allow).toBe(false);
    });

    it("project-scoped roles alone do not grant org-wide list", () => {
      const facts = [projectFact("project_admin", "org_1", "prj_1")];
      const result = authorize(authReq("project.list", "org_1", facts));
      expect(result.allow).toBe(false);
    });

    it("project.read still requires explicit projectId", () => {
      const result = authorize(authReq("project.read", "org_1", [orgFact("owner", "org_1")]));
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("invalid_scope");
    });
  });

  describe("project roles", () => {
    describe("project_admin", () => {
      const facts = [projectFact("project_admin", "org_1", "prj_1")];

      it("allows project.read for matching project", () => {
        const result = authorize(authReq("project.read", "org_1", facts, "prj_1"));
        expect(result.allow).toBe(true);
        expect(result.reason).toBe("project_admin");
      });

      it("allows project.update for matching project", () => {
        expect(authorize(authReq("project.update", "org_1", facts, "prj_1")).allow).toBe(true);
      });

      it("allows project.delete for matching project", () => {
        expect(authorize(authReq("project.delete", "org_1", facts, "prj_1")).allow).toBe(true);
      });

      it("allows environment access for matching project", () => {
        expect(authorize(authReq("environment.create", "org_1", facts, "prj_1")).allow).toBe(true);
        expect(authorize(authReq("environment.read", "org_1", facts, "prj_1")).allow).toBe(true);
        expect(authorize(authReq("environment.update", "org_1", facts, "prj_1")).allow).toBe(true);
        expect(authorize(authReq("environment.delete", "org_1", facts, "prj_1")).allow).toBe(true);
      });

      it("denies access to a different project", () => {
        expect(authorize(authReq("project.read", "org_1", facts, "prj_2")).allow).toBe(false);
      });

      it("denies organization-level actions", () => {
        expect(authorize(authReq("organization.read", "org_1", facts)).allow).toBe(false);
        expect(authorize(authReq("organization.settings.update", "org_1", facts)).allow).toBe(false);
      });
    });

    describe("project_builder", () => {
      const facts = [projectFact("project_builder", "org_1", "prj_1")];

      it("allows project.read and project.update", () => {
        expect(authorize(authReq("project.read", "org_1", facts, "prj_1")).allow).toBe(true);
        expect(authorize(authReq("project.update", "org_1", facts, "prj_1")).allow).toBe(true);
      });

      it("allows environment access", () => {
        expect(authorize(authReq("environment.create", "org_1", facts, "prj_1")).allow).toBe(true);
        expect(authorize(authReq("environment.read", "org_1", facts, "prj_1")).allow).toBe(true);
        expect(authorize(authReq("environment.update", "org_1", facts, "prj_1")).allow).toBe(true);
      });

      it("denies project.delete", () => {
        expect(authorize(authReq("project.delete", "org_1", facts, "prj_1")).allow).toBe(false);
      });

      it("denies environment.delete", () => {
        expect(authorize(authReq("environment.delete", "org_1", facts, "prj_1")).allow).toBe(false);
      });

      it("denies access to different project", () => {
        expect(authorize(authReq("project.read", "org_1", facts, "prj_2")).allow).toBe(false);
      });
    });

    describe("project_viewer", () => {
      const facts = [projectFact("project_viewer", "org_1", "prj_1")];

      it("allows project.read", () => {
        expect(authorize(authReq("project.read", "org_1", facts, "prj_1")).allow).toBe(true);
        expect(authorize(authReq("project.read", "org_1", facts, "prj_1")).reason).toBe("project_viewer");
      });

      it("allows environment.read", () => {
        expect(authorize(authReq("environment.read", "org_1", facts, "prj_1")).allow).toBe(true);
      });

      it("denies writes", () => {
        expect(authorize(authReq("project.update", "org_1", facts, "prj_1")).allow).toBe(false);
        expect(authorize(authReq("project.delete", "org_1", facts, "prj_1")).allow).toBe(false);
        expect(authorize(authReq("environment.create", "org_1", facts, "prj_1")).allow).toBe(false);
        expect(authorize(authReq("environment.update", "org_1", facts, "prj_1")).allow).toBe(false);
        expect(authorize(authReq("environment.delete", "org_1", facts, "prj_1")).allow).toBe(false);
      });
    });

    it("denies project role when orgId does not match", () => {
      const facts = [projectFact("project_admin", "org_1", "prj_1")];
      const result = authorize(authReq("project.read", "org_2", facts, "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("denies project role when projectId is missing from resource", () => {
      const facts = [projectFact("project_admin", "org_1", "prj_1")];
      const result = authorize(authReq("project.read", "org_1", facts));
      expect(result.allow).toBe(false);
    });
  });

  describe("environment.create action", () => {
    it("allows owner to create environments", () => {
      const result = authorize(authReq("environment.create", "org_1", [orgFact("owner", "org_1")], "prj_1"));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_owner");
    });

    it("allows admin to create environments", () => {
      const result = authorize(authReq("environment.create", "org_1", [orgFact("admin", "org_1")], "prj_1"));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_admin");
    });

    it("allows builder to create environments", () => {
      const result = authorize(authReq("environment.create", "org_1", [orgFact("builder", "org_1")], "prj_1"));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_builder");
    });

    it("denies viewer from creating environments", () => {
      const result = authorize(authReq("environment.create", "org_1", [orgFact("viewer", "org_1")], "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("denies billing_admin from creating environments", () => {
      const result = authorize(authReq("environment.create", "org_1", [orgFact("billing_admin", "org_1")], "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("allows project_admin to create environments for matching project", () => {
      const facts = [projectFact("project_admin", "org_1", "prj_1")];
      const result = authorize(authReq("environment.create", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("project_admin");
    });

    it("allows project_builder to create environments for matching project", () => {
      const facts = [projectFact("project_builder", "org_1", "prj_1")];
      const result = authorize(authReq("environment.create", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("project_builder");
    });

    it("denies project_viewer from creating environments", () => {
      const facts = [projectFact("project_viewer", "org_1", "prj_1")];
      const result = authorize(authReq("environment.create", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("requires projectId scope", () => {
      const result = authorize(authReq("environment.create", "org_1", [orgFact("owner", "org_1")]));
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("invalid_scope");
    });

    it("denies cross-org facts", () => {
      const result = authorize(authReq("environment.create", "org_2", [orgFact("owner", "org_1")], "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("denies wrong-project project role", () => {
      const facts = [projectFact("project_admin", "org_1", "prj_1")];
      const result = authorize(authReq("environment.create", "org_1", facts, "prj_2"));
      expect(result.allow).toBe(false);
    });
  });

  describe("environment.delete action", () => {
    it("allows owner to delete environments", () => {
      const result = authorize(authReq("environment.delete", "org_1", [orgFact("owner", "org_1")], "prj_1"));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_owner");
    });

    it("allows admin to delete environments", () => {
      const result = authorize(authReq("environment.delete", "org_1", [orgFact("admin", "org_1")], "prj_1"));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("org_admin");
    });

    it("denies builder from deleting environments", () => {
      const result = authorize(authReq("environment.delete", "org_1", [orgFact("builder", "org_1")], "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("denies viewer from deleting environments", () => {
      const result = authorize(authReq("environment.delete", "org_1", [orgFact("viewer", "org_1")], "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("denies billing_admin from deleting environments", () => {
      const result = authorize(authReq("environment.delete", "org_1", [orgFact("billing_admin", "org_1")], "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("allows project_admin to delete environments for matching project", () => {
      const facts = [projectFact("project_admin", "org_1", "prj_1")];
      const result = authorize(authReq("environment.delete", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("project_admin");
    });

    it("denies project_builder from deleting environments", () => {
      const facts = [projectFact("project_builder", "org_1", "prj_1")];
      const result = authorize(authReq("environment.delete", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("denies project_viewer from deleting environments", () => {
      const facts = [projectFact("project_viewer", "org_1", "prj_1")];
      const result = authorize(authReq("environment.delete", "org_1", facts, "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("requires projectId scope", () => {
      const result = authorize(authReq("environment.delete", "org_1", [orgFact("owner", "org_1")]));
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("invalid_scope");
    });

    it("denies cross-org facts", () => {
      const result = authorize(authReq("environment.delete", "org_2", [orgFact("owner", "org_1")], "prj_1"));
      expect(result.allow).toBe(false);
    });

    it("denies wrong-project project role", () => {
      const facts = [projectFact("project_admin", "org_1", "prj_1")];
      const result = authorize(authReq("environment.delete", "org_1", facts, "prj_2"));
      expect(result.allow).toBe(false);
    });
  });

  describe("unknown future facts", () => {
    it("ignores facts with unknown kind values", () => {
      const facts: PolicyMembershipFact[] = [
        { kind: "entitlement", tier: "premium", scope: { kind: "organization", orgId: "org_1" } },
      ];
      const result = authorize(authReq("organization.read", "org_1", facts));
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("no_matching_role");
    });

    it("ignores facts with unknown roles but does not widen access", () => {
      const facts: MembershipFact[] = [
        { kind: "role_assignment", role: "super_admin" as TenancyRole, scope: { kind: "organization", orgId: "org_1" } },
      ];
      const result = authorize(authReq("organization.read", "org_1", facts));
      expect(result.allow).toBe(false);
    });

    it("ignores malformed future fact objects without authorizing or throwing", () => {
      const malformedNull: unknown = null;
      const facts: PolicyMembershipFact[] = [
        { kind: "quota", limit: 100 },
        { kind: "role_assignment", role: "owner", scope: "org_1" },
        malformedNull as PolicyMembershipFact,
      ];
      const result = authorize(authReq("organization.read", "org_1", facts));
      expect(result.allow).toBe(false);
      expect(result.reason).toBe("no_matching_role");
    });
  });

  describe("policyVersion and derivedScope", () => {
    it("always returns policyVersion 1", () => {
      const result = authorize(authReq("organization.read", "org_1", [orgFact("owner", "org_1")]));
      expect(result.policyVersion).toBe(1);
    });

    it("returns derivedScope with orgId", () => {
      const result = authorize(authReq("organization.read", "org_1", [orgFact("owner", "org_1")]));
      expect(result.derivedScope.orgId).toBe("org_1");
    });

    it("returns derivedScope with projectId when present", () => {
      const result = authorize(authReq("project.read", "org_1", [orgFact("owner", "org_1")], "prj_1"));
      expect(result.derivedScope.projectId).toBe("prj_1");
    });
  });
});

describe("listEffectivePermissions", () => {
  it("returns all permissions for owner", () => {
    const input: EffectivePermissionsRequest = {
      subject,
      resource: { kind: "organization", orgId: "org_1" },
      context: { memberships: [orgFact("owner", "org_1")] },
    };
    const result = listEffectivePermissions(input);
    expect(result.policyVersion).toBe(1);
    expect(result.derivedScope.orgId).toBe("org_1");

    const allowed = result.permissions.filter((p) => p.allow);
    expect(allowed.length).toBe(31);
  });

  it("returns limited permissions for viewer", () => {
    const input: EffectivePermissionsRequest = {
      subject,
      resource: { kind: "organization", orgId: "org_1" },
      context: { memberships: [orgFact("viewer", "org_1")] },
    };
    const result = listEffectivePermissions(input);
    const allowed = result.permissions.filter((p) => p.allow);
    expect(allowed.map((p) => p.action).sort()).toEqual([
      "organization.config.read",
      "organization.integration.read",
      "organization.metering.read",
      "organization.read",
      "organization.webhook.read",
      "project.list",
      "project.webhook.read",
    ]);
  });

  it("returns billing permissions for billing_admin", () => {
    const input: EffectivePermissionsRequest = {
      subject,
      resource: { kind: "organization", orgId: "org_1" },
      context: { memberships: [orgFact("billing_admin", "org_1")] },
    };
    const result = listEffectivePermissions(input);
    const allowed = result.permissions.filter((p) => p.allow);
    expect(allowed.map((p) => p.action).sort()).toEqual([
      "billing.manage",
      "billing.read",
      "organization.read",
    ]);
  });

  it("returns no permissions when no facts match", () => {
    const input: EffectivePermissionsRequest = {
      subject,
      resource: { kind: "organization", orgId: "org_1" },
      context: { memberships: [] },
    };
    const result = listEffectivePermissions(input);
    const allowed = result.permissions.filter((p) => p.allow);
    expect(allowed.length).toBe(0);
  });

  it("combines org and project role permissions", () => {
    const input: EffectivePermissionsRequest = {
      subject,
      resource: { kind: "project", orgId: "org_1", projectId: "prj_1" },
      context: {
        memberships: [
          orgFact("viewer", "org_1"),
          projectFact("project_builder", "org_1", "prj_1"),
        ],
      },
    };
    const result = listEffectivePermissions(input);
    const allowed = result.permissions.filter((p) => p.allow);
    const actions = allowed.map((p) => p.action).sort();
    expect(actions).toContain("organization.read");
    expect(actions).toContain("project.read");
    expect(actions).toContain("project.update");
    expect(actions).toContain("environment.read");
    expect(actions).toContain("environment.update");
  });
});

describe("validateRoleAssignment", () => {
  describe("organization scope", () => {
    it("accepts valid org roles", () => {
      for (const role of ["owner", "admin", "builder", "viewer", "billing_admin"]) {
        const result = validateRoleAssignment({
          role,
          scope: { kind: "organization", orgId: "org_1" },
        });
        expect(result.valid).toBe(true);
        expect(result.reason).toBe("valid_org_role");
        expect(result.policyVersion).toBe(1);
      }
    });

    it("rejects project roles at org scope", () => {
      const result = validateRoleAssignment({
        role: "project_admin",
        scope: { kind: "organization", orgId: "org_1" },
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_role_for_scope");
    });

    it("rejects unknown roles", () => {
      const result = validateRoleAssignment({
        role: "super_admin",
        scope: { kind: "organization", orgId: "org_1" },
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_role_for_scope");
    });
  });

  describe("project scope", () => {
    it("accepts valid project roles with projectId", () => {
      for (const role of ["project_admin", "project_builder", "project_viewer"]) {
        const result = validateRoleAssignment({
          role,
          scope: { kind: "project", orgId: "org_1", projectId: "prj_1" },
        });
        expect(result.valid).toBe(true);
        expect(result.reason).toBe("valid_project_role");
      }
    });

    it("rejects project roles without projectId", () => {
      const result = validateRoleAssignment({
        role: "project_admin",
        scope: { kind: "project", orgId: "org_1" },
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("missing_project_id");
    });

    it("rejects org roles at project scope", () => {
      const result = validateRoleAssignment({
        role: "admin",
        scope: { kind: "project", orgId: "org_1", projectId: "prj_1" },
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_role_for_scope");
    });
  });

  describe("edge cases", () => {
    it("rejects missing orgId", () => {
      const result = validateRoleAssignment({
        role: "owner",
        scope: { kind: "organization", orgId: "" },
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("missing_org_id");
    });

    it("rejects unknown scope kind", () => {
      const result = validateRoleAssignment({
        role: "owner",
        scope: { kind: "environment" as RoleScopeKind, orgId: "org_1" },
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("unknown_scope_kind");
    });
  });
});

describe("audit.read authorization", () => {
  it("allows organization owner to read audit", () => {
    const result = authorize(authReq("audit.read", "org_1", [orgFact("owner", "org_1")]));
    expect(result.allow).toBe(true);
    expect(result.reason).toBe("org_owner");
  });

  it("allows organization admin to read audit", () => {
    const result = authorize(authReq("audit.read", "org_1", [orgFact("admin", "org_1")]));
    expect(result.allow).toBe(true);
    expect(result.reason).toBe("org_admin");
  });

  it("denies organization builder from reading audit", () => {
    const result = authorize(authReq("audit.read", "org_1", [orgFact("builder", "org_1")]));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("no_matching_role");
  });

  it("denies organization viewer from reading audit", () => {
    const result = authorize(authReq("audit.read", "org_1", [orgFact("viewer", "org_1")]));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("no_matching_role");
  });

  it("denies billing_admin from reading audit", () => {
    const result = authorize(authReq("audit.read", "org_1", [orgFact("billing_admin", "org_1")]));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("no_matching_role");
  });

  it("denies project-scoped roles from reading organization audit", () => {
    const result = authorize(authReq("audit.read", "org_1", [projectFact("project_admin", "org_1", "prj_1")]));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("no_matching_role");
  });

  it("denies project_builder from reading organization audit", () => {
    const result = authorize(authReq("audit.read", "org_1", [projectFact("project_builder", "org_1", "prj_1")]));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("no_matching_role");
  });

  it("denies project_viewer from reading organization audit", () => {
    const result = authorize(authReq("audit.read", "org_1", [projectFact("project_viewer", "org_1", "prj_1")]));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("no_matching_role");
  });

  it("denies when memberships are for a different org", () => {
    const result = authorize(authReq("audit.read", "org_1", [orgFact("owner", "org_other")]));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("no_matching_role");
  });

  it("denies malformed membership facts", () => {
    const malformed = { kind: "something_else", role: "owner" } as unknown as MembershipFact;
    const result = authorize(authReq("audit.read", "org_1", [malformed]));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("no_matching_role");
  });
});

describe("service-principal binding actions", () => {
  const spActions = [
    "organization.service_principal.binding.create",
    "organization.service_principal.binding.list",
    "organization.service_principal.binding.revoke",
  ];

  for (const action of spActions) {
    it(`owner can ${action}`, () => {
      const result = authorize(authReq(action, "org_1", [orgFact("owner", "org_1")]));
      expect(result.allow).toBe(true);
    });

    it(`admin can ${action}`, () => {
      const result = authorize(authReq(action, "org_1", [orgFact("admin", "org_1")]));
      expect(result.allow).toBe(true);
    });

    it(`builder cannot ${action}`, () => {
      const result = authorize(authReq(action, "org_1", [orgFact("builder", "org_1")]));
      expect(result.allow).toBe(false);
    });

    it(`viewer cannot ${action}`, () => {
      const result = authorize(authReq(action, "org_1", [orgFact("viewer", "org_1")]));
      expect(result.allow).toBe(false);
    });

    it(`billing_admin cannot ${action}`, () => {
      const result = authorize(authReq(action, "org_1", [orgFact("billing_admin", "org_1")]));
      expect(result.allow).toBe(false);
    });
  }
});

describe("integration actions (saas-integrations IG1)", () => {
  const ORG = "org-1";

  it("owner and admin can read, connect, and manage integrations", () => {
    for (const role of ["owner", "admin"]) {
      for (const action of [
        "organization.integration.read",
        "organization.integration.connect",
        "organization.integration.manage",
      ]) {
        expect(authorize(authReq(action, ORG, [orgFact(role, ORG)])).allow).toBe(true);
      }
    }
  });

  it("builder and viewer can only read integrations", () => {
    for (const role of ["builder", "viewer"]) {
      expect(
        authorize(authReq("organization.integration.read", ORG, [orgFact(role, ORG)])).allow,
      ).toBe(true);
      expect(
        authorize(authReq("organization.integration.connect", ORG, [orgFact(role, ORG)])).allow,
      ).toBe(false);
      expect(
        authorize(authReq("organization.integration.manage", ORG, [orgFact(role, ORG)])).allow,
      ).toBe(false);
    }
  });

  it("denies integration actions across org boundaries and for project roles", () => {
    expect(
      authorize(authReq("organization.integration.connect", ORG, [orgFact("owner", "org-2")])).allow,
    ).toBe(false);
    expect(
      authorize(
        authReq("organization.integration.connect", ORG, [projectFact("project_admin", ORG, "p1")]),
      ).allow,
    ).toBe(false);
  });
});

describe("project.repo_link.write (saas-integrations IG3)", () => {
  const ORG = "org-1";

  it("requires a projectId (project-scoped action)", () => {
    expect(
      authorize(authReq("project.repo_link.write", ORG, [orgFact("owner", ORG)])).allow,
    ).toBe(false);
    expect(
      authorize(authReq("project.repo_link.write", ORG, [orgFact("owner", ORG)], "p1")).allow,
    ).toBe(true);
  });

  it("grants org owner/admin and the project's own admin, denies the rest", () => {
    expect(
      authorize(authReq("project.repo_link.write", ORG, [orgFact("admin", ORG)], "p1")).allow,
    ).toBe(true);
    expect(
      authorize(
        authReq("project.repo_link.write", ORG, [projectFact("project_admin", ORG, "p1")], "p1"),
      ).allow,
    ).toBe(true);
    expect(
      authorize(
        authReq("project.repo_link.write", ORG, [projectFact("project_admin", ORG, "p2")], "p1"),
      ).allow,
    ).toBe(false);
    expect(
      authorize(authReq("project.repo_link.write", ORG, [orgFact("builder", ORG)], "p1")).allow,
    ).toBe(false);
    expect(
      authorize(
        authReq("project.repo_link.write", ORG, [projectFact("project_builder", ORG, "p1")], "p1"),
      ).allow,
    ).toBe(false);
  });
});
