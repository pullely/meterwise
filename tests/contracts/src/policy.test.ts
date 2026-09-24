import type {
  AuthorizationContextRequest,
  AuthorizationContextResponse,
  MembershipFact,
  PolicySubject,
} from "@saas/contracts/policy";
import { ORGANIZATION_ACTIONS } from "@saas/contracts/policy";

describe("contracts: authorization-context types", () => {
  it("AuthorizationContextRequest accepts subject and orgId", () => {
    const req: AuthorizationContextRequest = {
      subject: { type: "user", id: "usr_abc123" },
      orgId: "org_001",
    };
    expect(req.subject.type).toBe("user");
    expect(req.subject.id).toBe("usr_abc123");
    expect(req.orgId).toBe("org_001");
  });

  it("AuthorizationContextRequest accepts service_principal subject type", () => {
    const req: AuthorizationContextRequest = {
      subject: { type: "service_principal", id: "svc_deploy" },
      orgId: "org_002",
    };
    expect(req.subject.type).toBe("service_principal");
  });

  it("AuthorizationContextResponse contains membership facts array", () => {
    const res: AuthorizationContextResponse = {
      memberships: [
        {
          kind: "role_assignment",
          role: "admin",
          scope: { kind: "organization", orgId: "org_001" },
        },
      ],
    };
    expect(res.memberships).toHaveLength(1);
    expect(res.memberships[0]!.kind).toBe("role_assignment");
    expect(res.memberships[0]!.role).toBe("admin");
    expect(res.memberships[0]!.scope.kind).toBe("organization");
  });

  it("AuthorizationContextResponse supports project-scoped facts", () => {
    const fact: MembershipFact = {
      kind: "role_assignment",
      role: "project_builder",
      scope: { kind: "project", orgId: "org_001", projectId: "prj_123" },
    };
    const res: AuthorizationContextResponse = { memberships: [fact] };
    expect(res.memberships[0]!.scope.projectId).toBe("prj_123");
  });

  it("AuthorizationContextResponse supports empty memberships", () => {
    const res: AuthorizationContextResponse = { memberships: [] };
    expect(res.memberships).toHaveLength(0);
  });

  it("PolicySubject type is structurally compatible with request subject", () => {
    const subject: PolicySubject = { type: "workflow", id: "wf_run_1" };
    const req: AuthorizationContextRequest = { subject, orgId: "org_003" };
    expect(req.subject.type).toBe("workflow");
  });
});

describe("contracts: ORGANIZATION_ACTIONS", () => {
  it("includes project.list as a known action", () => {
    expect(ORGANIZATION_ACTIONS).toContain("project.list");
  });

  it("includes project.read as a known action", () => {
    expect(ORGANIZATION_ACTIONS).toContain("project.read");
  });

  it("includes environment.create as a known action", () => {
    expect(ORGANIZATION_ACTIONS).toContain("environment.create");
  });

  it("includes environment.read as a known action", () => {
    expect(ORGANIZATION_ACTIONS).toContain("environment.read");
  });

  it("includes environment.delete as a known action", () => {
    expect(ORGANIZATION_ACTIONS).toContain("environment.delete");
  });

  it("includes audit.read as a known action", () => {
    expect(ORGANIZATION_ACTIONS).toContain("audit.read");
  });
});
