import {
  handleCreateServicePrincipalBinding,
  handleListServicePrincipalBindings,
  handleRevokeServicePrincipalBinding,
} from "@membership-worker/handlers/service-principal-bindings";
import type { CreateRoleAssignmentInput, MembershipRepository, MembershipResult, RoleAssignment } from "@saas/db/membership";
import type { Env } from "@membership-worker/env";
import { isServicePrincipalSubjectId, servicePrincipalSubjectId, parseServicePrincipalSubjectId } from "@saas/contracts/service-principal";

type BindingDTO = { id: string; orgId: string; subjectId: string; subjectType: string; role: string; scopeKind: string; scopeRef: string | null; createdAt: string; revokedAt: string | null };
type SuccessEnvelope<T> = { data: T; meta: { requestId: string; cursor: string | null } };

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const SP_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SP_SUBJECT_ID = servicePrincipalSubjectId(SP_UUID); // sp_aaaaaaaabbbbccccddddeeeeeeeeeeee

function createFakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: {} as unknown as D1Database,
    ...overrides,
  };
}

function makeRoleAssignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: "ra-1",
    orgId: ORG_ID,
    subjectId: SP_SUBJECT_ID,
    subjectType: "service_principal",
    role: "builder",
    scopeKind: "organization",
    scopeRef: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    revokedAt: null,
    ...overrides,
  };
}

function createFakeRepo(opts: {
  roleAssignments?: RoleAssignment[];
  createResult?: MembershipResult<RoleAssignment>;
  revokeResult?: MembershipResult<RoleAssignment>;
} = {}): MembershipRepository {
  const roleAssignments = opts.roleAssignments ?? [];
  return {
    async listRoleAssignments() {
      return { ok: true as const, value: roleAssignments };
    },
    async createRoleAssignment(input: CreateRoleAssignmentInput) {
      if (opts.createResult) return opts.createResult;
      return {
        ok: true as const,
        value: {
          id: input.id,
          orgId: input.orgId,
          subjectId: input.subjectId,
          subjectType: input.subjectType,
          role: input.role,
          scopeKind: input.scopeKind,
          scopeRef: input.scopeRef ?? null,
          createdAt: input.createdAt,
          revokedAt: null,
        },
      };
    },
    async revokeRoleAssignment(_orgId: string, assignmentId: string, _revokedAt?: Date) {
      if (opts.revokeResult) return opts.revokeResult;
      const found = roleAssignments.find((ra) => ra.id === assignmentId);
      if (!found) return { ok: false as const, error: { kind: "not_found" as const } };
      const revoked = { ...found, revokedAt: new Date() };
      return { ok: true as const, value: revoked };
    },
    // Stubs for interface compliance
    async bootstrapOrganization() { return { ok: false as const, error: { kind: "internal" as const, message: "stub" } }; },
    async createOrganization() { return { ok: false as const, error: { kind: "internal" as const, message: "stub" } }; },
    async getOrganizationById() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async getOrganizationBySlug() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async listOrganizationsForSubject() { return { ok: true as const, value: [] }; },
    async listOrganizationsForSubjectPaged() { return { ok: true as const, value: { items: [], nextCursor: null } }; },
    async createMember() { return { ok: false as const, error: { kind: "internal" as const, message: "stub" } }; },
    async getMemberById() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async listMembers() { return { ok: true as const, value: [] }; },
    async listMembersPaged() { return { ok: true as const, value: { items: [], nextCursor: null } }; },
    async removeMember() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async createInvitation() { return { ok: false as const, error: { kind: "internal" as const, message: "stub" } }; },
    async getInvitationById() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async getInvitationByTokenHash() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async listInvitations() { return { ok: true as const, value: [] }; },
    async listInvitationsPaged() { return { ok: true as const, value: { items: [], nextCursor: null } }; },
    async revokeInvitation() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async acceptInvitation() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async revokeAllRoleAssignments(_orgId: string, _subjectId: string, _revokedAt?: Date) { return { ok: true as const, value: [] }; },
    async countActiveOwners() { return { ok: true as const, value: 0 }; },
    async countBillableMembers() { return { ok: true as const, value: 0 }; },
    async listChildOrganizations() { return { ok: true as const, value: [] }; },
    async setOrganizationStatus() { return { ok: false as const, error: { kind: "not_found" as const } }; },
  };
}

describe("service-principal subject-ID helpers", () => {
  it("validates canonical sp_ format", () => {
    expect(isServicePrincipalSubjectId(SP_SUBJECT_ID)).toBe(true);
    expect(isServicePrincipalSubjectId("sp_aaaaaaaabbbbccccddddeeeeeeeeeeee")).toBe(true);
  });

  it("rejects invalid formats", () => {
    expect(isServicePrincipalSubjectId("")).toBe(false);
    expect(isServicePrincipalSubjectId("usr_abc123")).toBe(false);
    expect(isServicePrincipalSubjectId("sp_tooshort")).toBe(false);
    expect(isServicePrincipalSubjectId("sp_AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE")).toBe(false); // uppercase
    expect(isServicePrincipalSubjectId("sp_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(false); // dashes
  });

  it("builds from UUID with dashes", () => {
    expect(servicePrincipalSubjectId(SP_UUID)).toBe("sp_aaaaaaaabbbbccccddddeeeeeeeeeeee");
  });

  it("builds from UUID without dashes", () => {
    expect(servicePrincipalSubjectId("aaaaaaaabbbbccccddddeeeeeeeeeeee")).toBe("sp_aaaaaaaabbbbccccddddeeeeeeeeeeee");
  });

  it("parses valid sp_ ID to hex", () => {
    expect(parseServicePrincipalSubjectId("sp_aaaaaaaabbbbccccddddeeeeeeeeeeee")).toBe("aaaaaaaabbbbccccddddeeeeeeeeeeee");
  });

  it("returns null for invalid sp_ ID", () => {
    expect(parseServicePrincipalSubjectId("usr_abc")).toBeNull();
    expect(parseServicePrincipalSubjectId("sp_short")).toBeNull();
  });
});

describe("handleCreateServicePrincipalBinding", () => {
  const env = createFakeEnv();

  function makeCreateRequest(body: unknown): Request {
    return new Request("http://membership-worker/v1/internal/membership/service-principal-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates an org-scoped binding for a valid sp_ subject", async () => {
    const repo = createFakeRepo();
    const req = makeCreateRequest({
      orgId: ORG_ID,
      subjectId: SP_SUBJECT_ID,
      role: "builder",
      scopeKind: "organization",
    });

    const res = await handleCreateServicePrincipalBinding(req, env, "req-1", { repo });
    expect(res.status).toBe(201);

    const json = await res.json() as SuccessEnvelope<BindingDTO>;
    expect(json.data.subjectId).toBe(SP_SUBJECT_ID);
    expect(json.data.subjectType).toBe("service_principal");
    expect(json.data.role).toBe("builder");
    expect(json.data.scopeKind).toBe("organization");
  });

  it("creates a project-scoped binding with scopeRef", async () => {
    const repo = createFakeRepo();
    const req = makeCreateRequest({
      orgId: ORG_ID,
      subjectId: SP_SUBJECT_ID,
      role: "project_viewer",
      scopeKind: "project",
      scopeRef: "prj-uuid-1",
    });

    const res = await handleCreateServicePrincipalBinding(req, env, "req-2", { repo });
    expect(res.status).toBe(201);

    const json = await res.json() as SuccessEnvelope<BindingDTO>;
    expect(json.data.scopeKind).toBe("project");
    expect(json.data.scopeRef).toBe("prj-uuid-1");
  });

  it("rejects non-sp_ subject IDs", async () => {
    const repo = createFakeRepo();
    const req = makeCreateRequest({
      orgId: ORG_ID,
      subjectId: "usr_abc123",
      role: "builder",
      scopeKind: "organization",
    });

    const res = await handleCreateServicePrincipalBinding(req, env, "req-3", { repo });
    expect(res.status).toBe(422);
  });

  it("rejects invalid role for scope", async () => {
    const repo = createFakeRepo();
    const req = makeCreateRequest({
      orgId: ORG_ID,
      subjectId: SP_SUBJECT_ID,
      role: "project_admin",
      scopeKind: "organization", // project role in org scope
    });

    const res = await handleCreateServicePrincipalBinding(req, env, "req-4", { repo });
    expect(res.status).toBe(422);
  });

  it("rejects project scope without scopeRef", async () => {
    const repo = createFakeRepo();
    const req = makeCreateRequest({
      orgId: ORG_ID,
      subjectId: SP_SUBJECT_ID,
      role: "project_viewer",
      scopeKind: "project",
    });

    const res = await handleCreateServicePrincipalBinding(req, env, "req-5", { repo });
    expect(res.status).toBe(422);
  });

  it("rejects missing orgId", async () => {
    const repo = createFakeRepo();
    const req = makeCreateRequest({
      subjectId: SP_SUBJECT_ID,
      role: "builder",
      scopeKind: "organization",
    });

    const res = await handleCreateServicePrincipalBinding(req, env, "req-6", { repo });
    expect(res.status).toBe(422);
  });

  it("rejects invalid JSON", async () => {
    const req = new Request("http://membership-worker/v1/internal/membership/service-principal-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    const repo = createFakeRepo();
    const res = await handleCreateServicePrincipalBinding(req, env, "req-7", { repo });
    expect(res.status).toBe(422);
  });

  it("returns 409 on conflict", async () => {
    const repo = createFakeRepo({
      createResult: { ok: false, error: { kind: "conflict", entity: "role_assignment" } },
    });
    const req = makeCreateRequest({
      orgId: ORG_ID,
      subjectId: SP_SUBJECT_ID,
      role: "builder",
      scopeKind: "organization",
    });

    const res = await handleCreateServicePrincipalBinding(req, env, "req-8", { repo });
    expect(res.status).toBe(409);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const noDbEnv = { ENVIRONMENT: "test" } as Env;
    const req = makeCreateRequest({
      orgId: ORG_ID,
      subjectId: SP_SUBJECT_ID,
      role: "builder",
      scopeKind: "organization",
    });

    const res = await handleCreateServicePrincipalBinding(req, noDbEnv, "req-9");
    expect(res.status).toBe(503);
  });
});

describe("handleListServicePrincipalBindings", () => {
  const env = createFakeEnv();

  it("lists active sp bindings for a valid sp_ subject in org scope", async () => {
    const ra = makeRoleAssignment();
    const repo = createFakeRepo({ roleAssignments: [ra] });
    const url = new URL(`http://membership-worker/v1/internal/membership/service-principal-bindings?orgId=${ORG_ID}&subjectId=${SP_SUBJECT_ID}`);

    const res = await handleListServicePrincipalBindings(env, "req-10", url, { repo });
    expect(res.status).toBe(200);

    const json = await res.json() as SuccessEnvelope<BindingDTO[]>;
    expect(json.data).toHaveLength(1);
    expect(json.data[0]!.subjectId).toBe(SP_SUBJECT_ID);
  });

  it("filters out revoked bindings", async () => {
    const active = makeRoleAssignment({ id: "ra-1" });
    const revoked = makeRoleAssignment({ id: "ra-2", revokedAt: new Date() });
    const repo = createFakeRepo({ roleAssignments: [active, revoked] });
    const url = new URL(`http://membership-worker/v1/internal/membership/service-principal-bindings?orgId=${ORG_ID}&subjectId=${SP_SUBJECT_ID}`);

    const res = await handleListServicePrincipalBindings(env, "req-11", url, { repo });
    expect(res.status).toBe(200);

    const json = await res.json() as SuccessEnvelope<BindingDTO[]>;
    expect(json.data).toHaveLength(1);
    expect(json.data[0]!.id).toBe("ra-1");
  });

  it("filters out non-service_principal bindings", async () => {
    const spBinding = makeRoleAssignment({ id: "ra-1", subjectType: "service_principal" });
    const userBinding = makeRoleAssignment({ id: "ra-2", subjectType: "user" });
    const repo = createFakeRepo({ roleAssignments: [spBinding, userBinding] });
    const url = new URL(`http://membership-worker/v1/internal/membership/service-principal-bindings?orgId=${ORG_ID}&subjectId=${SP_SUBJECT_ID}`);

    const res = await handleListServicePrincipalBindings(env, "req-12", url, { repo });
    const json = await res.json() as SuccessEnvelope<BindingDTO[]>;
    expect(json.data).toHaveLength(1);
    expect(json.data[0]!.subjectType).toBe("service_principal");
  });

  it("rejects missing orgId", async () => {
    const url = new URL(`http://membership-worker/v1/internal/membership/service-principal-bindings?subjectId=${SP_SUBJECT_ID}`);
    const repo = createFakeRepo();

    const res = await handleListServicePrincipalBindings(env, "req-13", url, { repo });
    expect(res.status).toBe(422);
  });

  it("rejects invalid subjectId", async () => {
    const url = new URL(`http://membership-worker/v1/internal/membership/service-principal-bindings?orgId=${ORG_ID}&subjectId=usr_bad`);
    const repo = createFakeRepo();

    const res = await handleListServicePrincipalBindings(env, "req-14", url, { repo });
    expect(res.status).toBe(422);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const noDbEnv = { ENVIRONMENT: "test" } as Env;
    const url = new URL(`http://membership-worker/v1/internal/membership/service-principal-bindings?orgId=${ORG_ID}&subjectId=${SP_SUBJECT_ID}`);

    const res = await handleListServicePrincipalBindings(noDbEnv, "req-15", url);
    expect(res.status).toBe(503);
  });
});

describe("handleRevokeServicePrincipalBinding", () => {
  const env = createFakeEnv();

  it("revokes an existing binding", async () => {
    const ra = makeRoleAssignment({ id: "ra-1" });
    const repo = createFakeRepo({ roleAssignments: [ra] });
    const url = new URL(`http://membership-worker/v1/internal/membership/service-principal-bindings/ra-1?orgId=${ORG_ID}`);

    const res = await handleRevokeServicePrincipalBinding(env, "req-20", "ra-1", url, { repo });
    expect(res.status).toBe(200);

    const json = await res.json() as SuccessEnvelope<BindingDTO>;
    expect(json.data.id).toBe("ra-1");
    expect(json.data.revokedAt).toBeTruthy();
  });

  it("returns 404 for non-existent binding", async () => {
    const repo = createFakeRepo({ roleAssignments: [] });
    const url = new URL(`http://membership-worker/v1/internal/membership/service-principal-bindings/ra-999?orgId=${ORG_ID}`);

    const res = await handleRevokeServicePrincipalBinding(env, "req-21", "ra-999", url, { repo });
    expect(res.status).toBe(404);
  });

  it("rejects missing orgId", async () => {
    const url = new URL("http://membership-worker/v1/internal/membership/service-principal-bindings/ra-1");
    const repo = createFakeRepo();

    const res = await handleRevokeServicePrincipalBinding(env, "req-22", "ra-1", url, { repo });
    expect(res.status).toBe(422);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const noDbEnv = { ENVIRONMENT: "test" } as Env;
    const url = new URL(`http://membership-worker/v1/internal/membership/service-principal-bindings/ra-1?orgId=${ORG_ID}`);

    const res = await handleRevokeServicePrincipalBinding(noDbEnv, "req-23", "ra-1", url);
    expect(res.status).toBe(503);
  });
});

describe("router: service-principal-bindings routes", () => {
  it("returns 405 for unsupported methods on collection endpoint", async () => {
    const { route } = await import("@membership-worker/router");
    const env = createFakeEnv();
    const req = new Request("http://membership-worker/v1/internal/membership/service-principal-bindings", {
      method: "PUT",
    });

    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for unsupported methods on binding ID endpoint", async () => {
    const { route } = await import("@membership-worker/router");
    const env = createFakeEnv();
    const req = new Request("http://membership-worker/v1/internal/membership/service-principal-bindings/ra-1", {
      method: "POST",
    });

    const res = await route(req, env);
    expect(res.status).toBe(405);
  });
});
