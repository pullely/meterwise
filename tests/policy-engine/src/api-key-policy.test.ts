import { authorize } from "@saas/policy-engine";
import type {
  AuthorizationRequest,
  MembershipFact,
  PolicyMembershipFact,
  PolicySubject,
  PolicyResource,
} from "@saas/contracts/policy";
import type { TenancyRole } from "@saas/contracts/tenancy";

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

const API_KEY_ACTIONS = [
  "organization.api_key.create",
  "organization.api_key.list",
  "organization.api_key.revoke",
] as const;

describe("authorize – api_key actions", () => {
  describe("owner role", () => {
    const facts = [orgFact("owner", "org_1")];

    for (const action of API_KEY_ACTIONS) {
      it(`allows ${action}`, () => {
        const result = authorize(authReq(action, "org_1", facts));
        expect(result.allow).toBe(true);
        expect(result.reason).toBe("org_owner");
      });
    }
  });

  describe("admin role", () => {
    const facts = [orgFact("admin", "org_1")];

    for (const action of API_KEY_ACTIONS) {
      it(`allows ${action}`, () => {
        const result = authorize(authReq(action, "org_1", facts));
        expect(result.allow).toBe(true);
        expect(result.reason).toBe("org_admin");
      });
    }
  });

  describe("project_admin with matching projectId", () => {
    const facts = [projectFact("project_admin", "org_1", "prj_1")];

    for (const action of API_KEY_ACTIONS) {
      it(`allows ${action} when resource projectId matches`, () => {
        const result = authorize(authReq(action, "org_1", facts, "prj_1"));
        expect(result.allow).toBe(true);
        expect(result.reason).toBe("project_admin");
      });
    }
  });

  describe("project_admin denied for org-wide", () => {
    const facts = [projectFact("project_admin", "org_1", "prj_1")];

    for (const action of API_KEY_ACTIONS) {
      it(`denies ${action} when resource has no projectId`, () => {
        const result = authorize(authReq(action, "org_1", facts));
        expect(result.allow).toBe(false);
      });
    }
  });

  describe("project_admin denied for mismatched projectId", () => {
    const facts = [projectFact("project_admin", "org_1", "prj_1")];

    for (const action of API_KEY_ACTIONS) {
      it(`denies ${action} when resource projectId differs`, () => {
        const result = authorize(authReq(action, "org_1", facts, "prj_2"));
        expect(result.allow).toBe(false);
      });
    }
  });

  describe("builder/viewer/billing_admin are denied", () => {
    for (const role of ["builder", "viewer", "billing_admin"]) {
      const facts = [orgFact(role, "org_1")];
      for (const action of API_KEY_ACTIONS) {
        it(`denies ${action} for ${role}`, () => {
          const result = authorize(authReq(action, "org_1", facts));
          expect(result.allow).toBe(false);
        });
      }
    }
  });

  describe("project_builder/project_viewer are denied", () => {
    for (const role of ["project_builder", "project_viewer"]) {
      const facts = [projectFact(role, "org_1", "prj_1")];
      for (const action of API_KEY_ACTIONS) {
        it(`denies ${action} for ${role} even with matching projectId`, () => {
          const result = authorize(authReq(action, "org_1", facts, "prj_1"));
          expect(result.allow).toBe(false);
        });
      }
    }
  });

  describe("cross-org membership is denied", () => {
    const facts = [orgFact("owner", "org_1")];

    for (const action of API_KEY_ACTIONS) {
      it(`denies ${action} when membership org differs from resource org`, () => {
        const result = authorize(authReq(action, "org_2", facts));
        expect(result.allow).toBe(false);
        expect(result.reason).toBe("no_matching_role");
      });
    }
  });

  describe("no memberships", () => {
    for (const action of API_KEY_ACTIONS) {
      it(`denies ${action} when memberships are empty`, () => {
        const result = authorize(authReq(action, "org_1", []));
        expect(result.allow).toBe(false);
        expect(result.reason).toBe("no_matching_role");
      });
    }
  });
});
