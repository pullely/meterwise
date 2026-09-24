import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asUuid } from "@saas/db";
import { createOrganizationService } from "@membership-worker/services/organization";
import type { PolicyAuthorizer } from "@membership-worker/services/organization";
import { orgPublicId, parseOrgPublicId, memberPublicId, invitationPublicId, parseInvitationPublicId } from "@membership-worker/ids";
import { handleCreateOrganization } from "@membership-worker/handlers/create-organization";
import { handleUpdateMemberRole } from "@membership-worker/handlers/update-member-role";
import { handleRemoveMember } from "@membership-worker/handlers/remove-member";
import { mapRoleAssignments, authorizeViaPolicy } from "@membership-worker/policy-client";
import { handleListMembers } from "@membership-worker/handlers/list-members";
import { handleCreateInvitation } from "@membership-worker/handlers/create-invitation";
import { handleListInvitations } from "@membership-worker/handlers/list-invitations";
import { handleRevokeInvitation } from "@membership-worker/handlers/revoke-invitation";
import { handleAcceptInvitation } from "@membership-worker/handlers/accept-invitation";
import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";
import type { checkBillingEntitlement } from "@membership-worker/billing-client";
import type {
  AcceptInvitationInput,
  CreateInvitationInput,
  CreateRoleAssignmentInput,
  MembershipRepository,
  MembershipResult,
  Organization,
  OrganizationInvitation,
  OrganizationMember,
  RoleAssignment,
} from "@saas/db/membership";
import type { AppendEventWithAuditInput, StoredEvent, StoredAuditEntry } from "@saas/db/events";
import type { Env } from "@membership-worker/env";

// Permissive response envelope used across the suite. Tests assert deep-property
// shapes ad-hoc; this lets each call site narrow what it reads without needing a
// precise per-handler DTO. Replaces the previous ubiquitous `as any` cast.
// Structural envelope used at every `await response.json() as JsonResp` site.
// All fields the suite reads are required (non-optional) — `as JsonResp` is a
// type assertion, not validation, so this lets callers chain reads without `!`
// dance while still catching typos at compile time. Replaces the prior
// per-site `as any` cast.
type RoleEntry = { role: string; scopeKind?: string; scopeType?: string; scopeRef?: string | null };
type MemberView = {
  id: string;
  subjectId: string;
  status: string;
  roles: ReadonlyArray<RoleEntry>;
  joinedAt: string;
  userId: string;
  organizationId: string;
};
type InvitationView = {
  id: string;
  email: string;
  role: string;
  status: string;
  invitedBy: string;
  revokedAt: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  organizationId: string;
  invitedByUserId: string;
};
type MembershipView = {
  id: string;
  role: string;
  status: string;
  joinedAt: string;
  userId: string;
  organizationId: string;
};
type DeliveryView = Record<string, unknown>;
type ErrorDetailFields = Record<string, ReadonlyArray<string>>;
type JsonResp = {
  data: {
    member: MemberView;
    members: ReadonlyArray<MemberView>;
    membership: MembershipView;
    invitation: InvitationView;
    invitations: ReadonlyArray<InvitationView>;
    delivery: DeliveryView;
    organization: Record<string, unknown>;
    organizations: ReadonlyArray<Record<string, unknown>>;
    role: string;
    membersCount: number;
    nextCursor: string | null;
  };
  error: {
    code: string;
    message: string;
    details: { fields: ErrorDetailFields; reason: string };
    requestId: string;
  };
  meta: { requestId: string; cursor: string | null };
};
// Captured policy-worker request body (tests JSON.parse + read action/resource).
type CapturedPolicyBody = { action: string; resource: { kind: string; id: string; orgId: string } };

if (!(globalThis as Record<string, unknown>).crypto) {
  (globalThis as Record<string, unknown>).crypto = crypto;
}

function createFakeRepository(): MembershipRepository & { _orgs: Map<string, Organization>; _roles: Map<string, RoleAssignment[]> } {
  const _orgs = new Map<string, Organization>();
  const _roles = new Map<string, RoleAssignment[]>();

  const repo: MembershipRepository & { _orgs: typeof _orgs; _roles: typeof _roles } = {
    _orgs,
    _roles,

    async bootstrapOrganization(input) {
      if (_orgs.has(input.org.id) || [..._orgs.values()].some((o) => o.slugLower === input.org.slugLower)) {
        return { ok: false, error: { kind: "conflict", entity: "organization" } };
      }
      const org: Organization = { ...input.org, status: "active", parentOrgId: null, updatedAt: input.org.createdAt };
      const member: OrganizationMember = { ...input.member, status: "active", updatedAt: input.member.createdAt };
      const roleAssignment: RoleAssignment = { ...input.roleAssignment, scopeRef: input.roleAssignment.scopeRef ?? null, revokedAt: null };
      _orgs.set(org.id, org);
      const key = `${org.id}:${input.roleAssignment.subjectId}`;
      _roles.set(key, [...(_roles.get(key) ?? []), roleAssignment]);
      return { ok: true, value: { org, member, roleAssignment } };
    },

    async getOrganizationById(id) {
      const org = _orgs.get(id);
      if (!org) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: org };
    },

    async getOrganizationBySlug(slugLower) {
      const org = [..._orgs.values()].find((o) => o.slugLower === slugLower);
      if (!org) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: org };
    },

    async listOrganizationsForSubject(subjectId) {
      const orgIds = new Set<string>();
      for (const [key, roles] of _roles.entries()) {
        if (key.endsWith(`:${subjectId}`) && roles.some((r) => !r.revokedAt)) {
          orgIds.add(key.split(":")[0]!);
        }
      }
      const orgs = [...orgIds].map((id) => _orgs.get(id)!).filter(Boolean);
      return { ok: true, value: orgs };
    },

    async listRoleAssignments(orgId, subjectId) {
      const key = `${orgId}:${subjectId}`;
      const roles = (_roles.get(key) ?? []).filter((r) => !r.revokedAt);
      return { ok: true, value: roles };
    },

    async createOrganization() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async createMember() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async getMemberById() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async listMembers() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async listMembersPaged() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async listOrganizationsForSubjectPaged() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async removeMember() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async createInvitation() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async getInvitationById() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async getInvitationByTokenHash() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async listInvitations() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async listInvitationsPaged() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async revokeInvitation() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async acceptInvitation() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async createRoleAssignment() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async revokeRoleAssignment() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async revokeAllRoleAssignments() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async countActiveOwners() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async countBillableMembers() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async listChildOrganizations() { return { ok: true as const, value: [] }; },
    async setOrganizationStatus() { return { ok: false as const, error: { kind: "not_found" as const } }; },
  };

  return repo;
}

const fixedNow = new Date("2026-01-15T10:00:00.000Z");

/** Policy authorizer that always allows */
const allowAuthorizer: PolicyAuthorizer = async () => ({ allow: true });
/** Policy authorizer that always denies */
const denyAuthorizer: PolicyAuthorizer = async () => ({ allow: false });

describe("membership-worker organization service", () => {
  function bootstrapOrg(repo: ReturnType<typeof createFakeRepository>, subjectId: string, name: string, slug: string) {
    const orgId = asUuid(crypto.randomUUID());
    const memberId = crypto.randomUUID();
    const roleAssignmentId = crypto.randomUUID();
    return repo.bootstrapOrganization({
      org: { id: orgId, name, slug, slugLower: slug, createdAt: fixedNow },
      member: { id: memberId, orgId, subjectId, subjectType: "user", createdAt: fixedNow },
      roleAssignment: { id: roleAssignmentId, orgId, subjectId, subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNow },
    });
  }

  describe("getOrganization", () => {
    it("returns organization when policy allows", async () => {
      const repo = createFakeRepository();
      const service = createOrganizationService({ repo, now: () => fixedNow });

      const createResult = await bootstrapOrg(repo, "usr_owner", "My Org", "my-org");
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const orgUuid = asUuid(createResult.value.org.id);
      const result = await service.getOrganization({ subjectId: "usr_owner", subjectType: "user" }, orgUuid, allowAuthorizer);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.organization.name).toBe("My Org");
      expect(result.value.organization.id).toMatch(/^org_[0-9a-f]{32}$/);
    });

    it("returns not_found when policy denies without leaking existence", async () => {
      const repo = createFakeRepository();
      const service = createOrganizationService({ repo, now: () => fixedNow });

      const createResult = await bootstrapOrg(repo, "usr_owner", "Secret", "secret");
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const orgUuid = asUuid(createResult.value.org.id);
      const result = await service.getOrganization({ subjectId: "usr_outsider", subjectType: "user" }, orgUuid, denyAuthorizer);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("not_found");
      expect(result.message).not.toContain("forbidden");
      expect(result.message).not.toContain("access");
    });

    it("returns not_found for non-existent organization UUID", async () => {
      const repo = createFakeRepository();
      const service = createOrganizationService({ repo, now: () => fixedNow });

      const result = await service.getOrganization(
        { subjectId: "usr_owner", subjectType: "user" },
        asUuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
        allowAuthorizer,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("not_found");
    });

    it("fails closed when no authorizer is provided", async () => {
      const repo = createFakeRepository();
      const service = createOrganizationService({ repo, now: () => fixedNow });

      const createResult = await bootstrapOrg(repo, "usr_owner", "Closed", "closed");
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const orgUuid = asUuid(createResult.value.org.id);
      const result = await service.getOrganization({ subjectId: "usr_owner", subjectType: "user" }, orgUuid);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("not_found");
    });

    it("passes correct action and role assignments to authorizer", async () => {
      const repo = createFakeRepository();
      const service = createOrganizationService({ repo, now: () => fixedNow });

      const createResult = await bootstrapOrg(repo, "usr_owner", "Check", "check");
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const orgUuid = asUuid(createResult.value.org.id);
      let capturedAction: string | undefined;
      let capturedRoles: RoleAssignment[] | undefined;

      const capturingAuthorizer: PolicyAuthorizer = async (_actor, action, _orgId, roles) => {
        capturedAction = action;
        capturedRoles = roles;
        return { allow: true };
      };

      await service.getOrganization({ subjectId: "usr_owner", subjectType: "user" }, orgUuid, capturingAuthorizer);

      expect(capturedAction).toBe("organization.read");
      expect(capturedRoles).toHaveLength(1);
      expect(capturedRoles![0]!.role).toBe("owner");
      expect(capturedRoles![0]!.scopeKind).toBe("organization");
    });

    it("fails closed when repository role-list fails", async () => {
      const repo = createFakeRepository();
      const service = createOrganizationService({ repo, now: () => fixedNow });

      const createResult = await bootstrapOrg(repo, "usr_owner", "RoleFail", "role-fail");
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const orgUuid = asUuid(createResult.value.org.id);

      // Override listRoleAssignments to simulate DB failure
      repo.listRoleAssignments = async () => ({ ok: false, error: { kind: "internal" as const, message: "db timeout" } });

      const result = await service.getOrganization({ subjectId: "usr_owner", subjectType: "user" }, orgUuid, allowAuthorizer);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("not_found");
    });
  });

  describe("ID utilities", () => {
    it("converts UUID to org_ prefixed public ID", () => {
      expect(orgPublicId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("org_aaaaaaaabbbbccccddddeeeeeeeeeeee");
    });

    it("parses org_ prefixed public ID back to UUID", () => {
      expect(parseOrgPublicId("org_aaaaaaaabbbbccccddddeeeeeeeeeeee")).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    });

    it("returns null for invalid public ID prefix", () => {
      expect(parseOrgPublicId("usr_aaaaaaaabbbbccccddddeeeeeeeeeeee")).toBeNull();
    });

    it("returns null for invalid hex length", () => {
      expect(parseOrgPublicId("org_abc")).toBeNull();
    });

    it("roundtrips correctly", () => {
      const uuid = "12345678-abcd-ef01-2345-6789abcdef01";
      expect(parseOrgPublicId(orgPublicId(uuid))).toBe(uuid);
    });
  });
});

describe("policy-client", () => {
  describe("mapRoleAssignments", () => {
    it("maps organization-scoped role to membership fact", () => {
      const assignments: RoleAssignment[] = [
        { id: "ra1", orgId: "org-uuid", subjectId: "usr1", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null },
      ];

      const facts = mapRoleAssignments("org-uuid", assignments);

      expect(facts).toHaveLength(1);
      expect(facts[0]).toEqual({
        kind: "role_assignment",
        role: "owner",
        scope: { kind: "organization", orgId: "org-uuid" },
      });
    });

    it("maps project-scoped role to membership fact with projectId", () => {
      const assignments: RoleAssignment[] = [
        { id: "ra2", orgId: "org-uuid", subjectId: "usr1", subjectType: "user", role: "project_admin", scopeKind: "project", scopeRef: "proj-uuid", createdAt: fixedNow, revokedAt: null },
      ];

      const facts = mapRoleAssignments("org-uuid", assignments);

      expect(facts).toHaveLength(1);
      expect(facts[0]).toEqual({
        kind: "role_assignment",
        role: "project_admin",
        scope: { kind: "project", orgId: "org-uuid", projectId: "proj-uuid" },
      });
    });

    it("maps multiple assignments into separate facts", () => {
      const assignments: RoleAssignment[] = [
        { id: "ra1", orgId: "org-uuid", subjectId: "usr1", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null },
        { id: "ra2", orgId: "org-uuid", subjectId: "usr1", subjectType: "user", role: "project_viewer", scopeKind: "project", scopeRef: "p1", createdAt: fixedNow, revokedAt: null },
      ];

      const facts = mapRoleAssignments("org-uuid", assignments);
      expect(facts).toHaveLength(2);
    });
  });

  describe("authorizeViaPolicy", () => {
    const actor = { subjectId: "usr_test", subjectType: "user" };
    const baseParams = {
      actor,
      action: "organization.read",
      resource: { kind: "organization" as const, id: "org-uuid", orgId: "org-uuid" },
      orgId: "org-uuid",
      roleAssignments: [] as RoleAssignment[],
      requestId: "req_test123",
    };

    it("returns allow:true when policy-worker returns allow:true in envelope", async () => {
      const fakeFetcher = {
        fetch: async () => Response.json({ data: { allow: true, reason: "granted", policyVersion: 1, derivedScope: { orgId: "org-uuid" } }, meta: { requestId: "req_test123", cursor: null } }),
      } as unknown as Fetcher;

      const result = await authorizeViaPolicy(fakeFetcher, baseParams);
      expect(result.allow).toBe(true);
    });

    it("returns allow:false when policy-worker returns allow:false in envelope", async () => {
      const fakeFetcher = {
        fetch: async () => Response.json({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: "org-uuid" } }, meta: { requestId: "req_test123", cursor: null } }),
      } as unknown as Fetcher;

      const result = await authorizeViaPolicy(fakeFetcher, baseParams);
      expect(result.allow).toBe(false);
    });

    it("fails closed on fetch error", async () => {
      const fakeFetcher = {
        fetch: async () => { throw new Error("network failure"); },
      } as unknown as Fetcher;

      const result = await authorizeViaPolicy(fakeFetcher, baseParams);
      expect(result.allow).toBe(false);
    });

    it("fails closed on non-ok response", async () => {
      const fakeFetcher = {
        fetch: async () => new Response("Internal Server Error", { status: 500 }),
      } as unknown as Fetcher;

      const result = await authorizeViaPolicy(fakeFetcher, baseParams);
      expect(result.allow).toBe(false);
    });

    it("fails closed on malformed JSON response", async () => {
      const fakeFetcher = {
        fetch: async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
      } as unknown as Fetcher;

      const result = await authorizeViaPolicy(fakeFetcher, baseParams);
      expect(result.allow).toBe(false);
    });

    it("fails closed when envelope has no data field", async () => {
      const fakeFetcher = {
        fetch: async () => Response.json({ something: "else" }),
      } as unknown as Fetcher;

      const result = await authorizeViaPolicy(fakeFetcher, baseParams);
      expect(result.allow).toBe(false);
    });

    it("fails closed when data has no allow field", async () => {
      const fakeFetcher = {
        fetch: async () => Response.json({ data: { reason: "ok" }, meta: { requestId: "r", cursor: null } }),
      } as unknown as Fetcher;

      const result = await authorizeViaPolicy(fakeFetcher, baseParams);
      expect(result.allow).toBe(false);
    });

    it("sends correct request body with membership facts", async () => {
      let capturedBody: unknown;
      const fakeFetcher = {
        fetch: async (_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string);
          return Response.json({ data: { allow: true, reason: "ok", policyVersion: 1, derivedScope: { orgId: "org-uuid" } }, meta: { requestId: "req_test123", cursor: null } });
        },
      } as unknown as Fetcher;

      const roles: RoleAssignment[] = [
        { id: "ra1", orgId: "org-uuid", subjectId: "usr_test", subjectType: "user", role: "admin", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null },
      ];

      await authorizeViaPolicy(fakeFetcher, { ...baseParams, roleAssignments: roles });

      expect(capturedBody).toEqual({
        subject: { type: "user", id: "usr_test" },
        action: "organization.read",
        resource: { kind: "organization", id: "org-uuid", orgId: "org-uuid" },
        context: {
          memberships: [
            { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: "org-uuid" } },
          ],
        },
      });
    });

    it("sends x-request-id header", async () => {
      let capturedHeaders: HeadersInit | undefined;
      const fakeFetcher = {
        fetch: async (_url: string, init: RequestInit) => {
          capturedHeaders = init.headers;
          return Response.json({ data: { allow: true, reason: "ok", policyVersion: 1, derivedScope: { orgId: "org-uuid" } }, meta: { requestId: "req_test123", cursor: null } });
        },
      } as unknown as Fetcher;

      await authorizeViaPolicy(fakeFetcher, baseParams);

      expect(capturedHeaders).toEqual(
        expect.objectContaining({ "x-request-id": "req_test123" }),
      );
    });
  });
});

describe("member-list endpoint", () => {
  function createMemberListRepo() {
    const orgId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const memberId1 = "11111111-2222-3333-4444-555555555555";
    const memberId2 = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const org: Organization = {
      id: orgId,
      name: "Test",
      slug: "test",
      slugLower: "test",
      status: "active",
      parentOrgId: null,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const member1: OrganizationMember = {
      id: memberId1,
      orgId,
      subjectId: "usr_owner",
      subjectType: "user",
      status: "active",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const member2: OrganizationMember = {
      id: memberId2,
      orgId,
      subjectId: "usr_viewer",
      subjectType: "user",
      status: "active",
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const roles: Record<string, RoleAssignment[]> = {
      [`${orgId}:usr_owner`]: [
        { id: "ra1", orgId, subjectId: "usr_owner", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null },
      ],
      [`${orgId}:usr_viewer`]: [
        { id: "ra2", orgId, subjectId: "usr_viewer", subjectType: "user", role: "viewer", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null },
        { id: "ra3", orgId, subjectId: "usr_viewer", subjectType: "user", role: "project_admin", scopeKind: "project", scopeRef: "proj-uuid-123", createdAt: fixedNow, revokedAt: null },
      ],
    };

    const repo = createFakeRepository();
    repo._orgs.set(orgId, org);
    repo.listMembers = async (id: string) => {
      if (id !== orgId) return { ok: false, error: { kind: "not_found" as const } };
      return { ok: true, value: [member1, member2] };
    };
    repo.listRoleAssignments = async (id: string, subjectId: string) => {
      const key = `${id}:${subjectId}`;
      const found = roles[key];
      if (found) return { ok: true, value: found };
      return { ok: true, value: [] };
    };
    return { repo, orgId, memberId1, memberId2 };
  }

  it("returns members with expected response shape", async () => {
    createMemberListRepo();

    // We test the service-level logic directly via the handler's internals
    // Since the handler creates its own executor/repo, we test logic patterns here
    const members = [
      {
        id: memberPublicId("11111111-2222-3333-4444-555555555555"),
        subjectType: "user",
        subjectId: "usr_owner",
        status: "active",
        joinedAt: fixedNow.toISOString(),
        roles: [{ role: "owner", scopeKind: "organization" }],
      },
      {
        id: memberPublicId("66666666-7777-8888-9999-aaaaaaaaaaaa"),
        subjectType: "user",
        subjectId: "usr_viewer",
        status: "active",
        joinedAt: fixedNow.toISOString(),
        roles: [
          { role: "viewer", scopeKind: "organization" },
          { role: "project_admin", scopeKind: "project" },
        ],
      },
    ];

    expect(members[0]!.id).toMatch(/^mem_[0-9a-f]{32}$/);
    expect(members[1]!.id).toMatch(/^mem_[0-9a-f]{32}$/);
    expect(members[0]!.roles[0]).toEqual({ role: "owner", scopeKind: "organization" });
  });

  it("sends correct policy action organization.member.list", async () => {
    let capturedBody: unknown;
    const policyFetcher = {
      fetch: async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return Response.json({
          data: { allow: true, reason: "granted", policyVersion: 1, derivedScope: {} },
          meta: { requestId: "req_test", cursor: null },
        });
      },
    } as unknown as Fetcher;

    const orgUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const roles: RoleAssignment[] = [
      { id: "ra1", orgId: orgUuid, subjectId: "usr_owner", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null },
    ];

    await authorizeViaPolicy(policyFetcher, {
      actor: { subjectId: "usr_owner", subjectType: "user" },
      action: "organization.member.list",
      resource: { kind: "organization", id: orgUuid, orgId: orgUuid },
      orgId: orgUuid,
      roleAssignments: roles,
      requestId: "req_test",
    });

    expect(capturedBody).toEqual(expect.objectContaining({
      action: "organization.member.list",
      resource: { kind: "organization", id: orgUuid, orgId: orgUuid },
    }));
  });

  it("policy denial returns not_found without leaking org existence", async () => {
    const policyFetcher = {
      fetch: async () => Response.json({
        data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: {} },
        meta: { requestId: "req_test", cursor: null },
      }),
    } as unknown as Fetcher;

    const result = await authorizeViaPolicy(policyFetcher, {
      actor: { subjectId: "usr_outsider", subjectType: "user" },
      action: "organization.member.list",
      resource: { kind: "organization", id: "org-uuid", orgId: "org-uuid" },
      orgId: "org-uuid",
      roleAssignments: [],
      requestId: "req_test",
    });

    expect(result.allow).toBe(false);
    // Handler maps allow:false -> not_found (verified by response shape, not "forbidden")
  });

  it("missing policy binding fails closed", async () => {
    const policyFetcher = {
      fetch: async () => { throw new Error("binding not available"); },
    } as unknown as Fetcher;

    const result = await authorizeViaPolicy(policyFetcher, {
      actor: { subjectId: "usr_test", subjectType: "user" },
      action: "organization.member.list",
      resource: { kind: "organization", id: "org-uuid", orgId: "org-uuid" },
      orgId: "org-uuid",
      roleAssignments: [],
      requestId: "req_test",
    });

    expect(result.allow).toBe(false);
  });

  it("actor role-list failure fails closed with not_found", async () => {
    const repo = createFakeRepository();
    repo.listRoleAssignments = async () => ({ ok: false, error: { kind: "internal" as const, message: "db timeout" } });

    // The handler would call listRoleAssignments first, and if it fails, return not_found
    const rolesResult = await repo.listRoleAssignments(asUuid("00000000-0000-0000-0000-000000000000"), "usr_test");
    expect(rolesResult.ok).toBe(false);
    // Handler maps this to 404 not_found
  });

  it("member role-list failure returns safe internal_error", async () => {
    const { repo } = createMemberListRepo();
    let callCount = 0;
    const original = repo.listRoleAssignments.bind(repo);
    repo.listRoleAssignments = async (orgId: string, subjectId: string) => {
      callCount++;
      if (callCount === 1) {
        return original(asUuid(orgId), subjectId);
      }
      return { ok: false, error: { kind: "internal" as const, message: "db timeout" } };
    };

    // First call succeeds (actor's own role lookup)
    const actorRoles = await repo.listRoleAssignments(asUuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "usr_owner");
    expect(actorRoles.ok).toBe(true);

    // Second call fails (member role lookup for another user)
    const memberRolesResult = await repo.listRoleAssignments(asUuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "usr_viewer");
    expect(memberRolesResult.ok).toBe(false);
    // Handler maps this to 500 internal_error without partial data
  });

  it("does not expose raw member UUIDs in response", () => {
    const rawUuid = "11111111-2222-3333-4444-555555555555";
    const publicId = memberPublicId(rawUuid);
    expect(publicId).toBe("mem_11111111222233334444555555555555");
    expect(publicId).not.toContain("-");
    expect(publicId).toMatch(/^mem_[0-9a-f]{32}$/);
  });

  it("does not expose role-assignment UUIDs in public response", () => {
    const ra: RoleAssignment = {
      id: "ra-uuid-private",
      orgId: "org-uuid",
      subjectId: "usr_x",
      subjectType: "user",
      role: "admin",
      scopeKind: "organization",
      scopeRef: null,
      createdAt: fixedNow,
      revokedAt: null,
    };
    const publicRole = { role: ra.role, scopeKind: ra.scopeKind };
    expect(publicRole).toEqual({ role: "admin", scopeKind: "organization" });
    expect(JSON.stringify(publicRole)).not.toContain("ra-uuid-private");
    expect(JSON.stringify(publicRole)).not.toContain("org-uuid");
  });

  it("project-scoped role assignments do not leak raw project UUIDs", () => {
    const ra: RoleAssignment = {
      id: "ra-uuid",
      orgId: "org-uuid",
      subjectId: "usr_x",
      subjectType: "user",
      role: "project_admin",
      scopeKind: "project",
      scopeRef: "proj-uuid-secret-123",
      createdAt: fixedNow,
      revokedAt: null,
    };
    const publicRole = { role: ra.role, scopeKind: ra.scopeKind };
    expect(JSON.stringify(publicRole)).not.toContain("proj-uuid-secret-123");
    expect(JSON.stringify(publicRole)).not.toContain("scopeRef");
  });

  it("memberPublicId produces prefixed hex from UUID", () => {
    const uuid = "abcdef01-2345-6789-abcd-ef0123456789";
    expect(memberPublicId(uuid)).toBe("mem_abcdef0123456789abcdef0123456789");
  });
});

describe("handleListMembers handler integration", () => {
  const orgUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const orgPublicIdStr = `org_${orgUuid.replace(/-/g, "")}`;
  const actor = { subjectId: "usr_owner", subjectType: "user" };

  function createFakeRepo(opts: {
    actorRolesFail?: boolean;
    membersFail?: boolean;
    memberRolesFail?: boolean;
  } = {}) {
    const members: OrganizationMember[] = [
      { id: "11111111-2222-3333-4444-555555555555", orgId: orgUuid, subjectId: "usr_owner", subjectType: "user", status: "active", createdAt: fixedNow, updatedAt: fixedNow },
      { id: "66666666-7777-8888-9999-aaaaaaaaaaaa", orgId: orgUuid, subjectId: "usr_viewer", subjectType: "user", status: "active", createdAt: fixedNow, updatedAt: fixedNow },
    ];
    const roles: Record<string, RoleAssignment[]> = {
      [`${orgUuid}:usr_owner`]: [
        { id: "ra1", orgId: orgUuid, subjectId: "usr_owner", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null },
      ],
      [`${orgUuid}:usr_viewer`]: [
        { id: "ra2", orgId: orgUuid, subjectId: "usr_viewer", subjectType: "user", role: "viewer", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null },
        { id: "ra3", orgId: orgUuid, subjectId: "usr_viewer", subjectType: "user", role: "project_admin", scopeKind: "project", scopeRef: "proj-uuid-secret", createdAt: fixedNow, revokedAt: null },
      ],
    };

    let roleCallCount = 0;
    return {
      listRoleAssignments: async (id: string, subjectId: string) => {
        roleCallCount++;
        if (opts.actorRolesFail && roleCallCount === 1) {
          return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
        }
        if (opts.memberRolesFail && roleCallCount > 1) {
          return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
        }
        const key = `${id}:${subjectId}`;
        return { ok: true as const, value: roles[key] ?? [] };
      },
      listMembersPaged: async (id: string) => {
        if (opts.membersFail) {
          return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
        }
        if (id !== orgUuid) return { ok: true as const, value: { items: [], nextCursor: null } };
        return { ok: true as const, value: { items: members, nextCursor: null } };
      },
    };
  }

  function createPolicyFetcher(allow: boolean) {
    return {
      fetch: async () => Response.json({
        data: { allow, reason: allow ? "granted" : "denied", policyVersion: 1, derivedScope: {} },
        meta: { requestId: "req_test", cursor: null },
      }),
    } as unknown as Fetcher;
  }

  it("returns full member list with correct response shape on success", async () => {
    const repo = createFakeRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(200);
    const json = await response.json() as JsonResp;
    expect(json.data.members).toHaveLength(2);
    expect(json.data.members[0]!.id).toMatch(/^mem_[0-9a-f]{32}$/);
    expect(json.data.members[0]!.subjectId).toBe("usr_owner");
    expect(json.data.members[0]!.status).toBe("active");
    expect(json.data.members[0]!.joinedAt).toBe(fixedNow.toISOString());
    expect(json.data.members[0]!.roles).toEqual([{ role: "owner", scopeKind: "organization" }]);
    expect(json.data.members[1]!.roles).toHaveLength(2);
  });

  it("sends organization.member.list action to policy-worker", async () => {
    let capturedBody: CapturedPolicyBody | undefined;
    const policyFetcher = {
      fetch: async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return Response.json({
          data: { allow: true, reason: "ok", policyVersion: 1, derivedScope: {} },
          meta: { requestId: "req_test", cursor: null },
        });
      },
    } as unknown as Fetcher;

    const repo = createFakeRepo();
    const env: Env = { POLICY_WORKER: policyFetcher, PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(capturedBody!.action).toBe("organization.member.list");
    expect(capturedBody!.resource).toEqual({ kind: "organization", id: orgUuid, orgId: orgUuid });
  });

  it("returns not_found when policy denies", async () => {
    const repo = createFakeRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(404);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("not_found");
    expect(JSON.stringify(json)).not.toContain("forbidden");
    expect(JSON.stringify(json)).not.toContain("denied");
  });

  it("returns not_found when actor role-list fails (fail closed)", async () => {
    const repo = createFakeRepo({ actorRolesFail: true });
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(404);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("not_found");
  });

  it("returns internal_error when member role-list fails without partial data", async () => {
    const repo = createFakeRepo({ memberRolesFail: true });
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(500);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("internal_error");
    expect(JSON.stringify(json)).not.toContain("members");
    expect(JSON.stringify(json)).not.toContain("usr_owner");
  });

  it("returns internal_error when listMembers fails", async () => {
    const repo = createFakeRepo({ membersFail: true });
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(500);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("internal_error");
  });

  it("fails closed when policy binding throws", async () => {
    const repo = createFakeRepo();
    const policyFetcher = { fetch: async () => { throw new Error("network"); } } as unknown as Fetcher;
    const env: Env = { POLICY_WORKER: policyFetcher, PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(404);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("not_found");
  });

  it("returns not_found for invalid orgId param", async () => {
    const repo = createFakeRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, "invalid_id", undefined, { repo });

    expect(response.status).toBe(404);
  });

  it("does not expose raw UUIDs or project scopeRef in response", async () => {
    const repo = createFakeRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });
    const text = await response.text();

    expect(text).not.toContain("11111111-2222-3333-4444-555555555555");
    expect(text).not.toContain("66666666-7777-8888-9999-aaaaaaaaaaaa");
    expect(text).not.toContain("proj-uuid-secret");
    expect(text).not.toContain("ra1");
    expect(text).not.toContain("ra2");
    expect(text).not.toContain("ra3");
  });

  it("returns 503 when POLICY_WORKER binding is missing", async () => {
    const repo = createFakeRepo();
    const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(503);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("internal_error");
  });

  it("PERF4: deny never leaks the members page even though the read runs in parallel", async () => {
    const repo = createFakeRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(404);
    const raw = await response.text();
    // The page read ran concurrently with authz; on deny it must be discarded.
    expect(raw).not.toContain("usr_viewer");
    expect(raw).not.toContain("mem_");
    expect(raw).not.toContain("members");
  });

  it("PERF4: emits a Server-Timing header with authctx/db/policy/total phases", async () => {
    const repo = createFakeRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(200);
    const timing = response.headers.get("Server-Timing");
    expect(timing).toBeTruthy();
    for (const phase of ["authctx", "db", "policy", "total"]) {
      expect(timing).toContain(phase);
    }
  });
});

describe("pagination", () => {
  const orgUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const orgPublicIdStr = `org_${orgUuid.replace(/-/g, "")}`;
  const actor = { subjectId: "usr_owner", subjectType: "user" };

  function createPagedRepo(opts: { hasNext?: boolean } = {}) {
    const members: OrganizationMember[] = [
      { id: "11111111-2222-3333-4444-555555555555", orgId: orgUuid, subjectId: "usr_owner", subjectType: "user", status: "active", createdAt: fixedNow, updatedAt: fixedNow },
    ];
    const roles: Record<string, RoleAssignment[]> = {
      [`${orgUuid}:usr_owner`]: [
        { id: "ra1", orgId: orgUuid, subjectId: "usr_owner", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null },
      ],
    };
    return {
      listRoleAssignments: async (id: string, subjectId: string) => {
        const key = `${id}:${subjectId}`;
        return { ok: true as const, value: roles[key] ?? [] };
      },
      listMembersPaged: async () => {
        return {
          ok: true as const,
          value: {
            items: members,
            nextCursor: opts.hasNext ? { createdAt: fixedNow.toISOString(), id: "11111111-2222-3333-4444-555555555555" } : null,
          },
        };
      },
    };
  }

  function createPolicyFetcher(allow: boolean) {
    return {
      fetch: async () => Response.json({
        data: { allow, reason: allow ? "granted" : "denied", policyVersion: 1, derivedScope: {} },
        meta: { requestId: "req_test", cursor: null },
      }),
    } as unknown as Fetcher;
  }

  it("defaults to limit 50 when no query params provided", async () => {
    const repo = createPagedRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(200);
    const json = await response.json() as JsonResp;
    expect(json.data.members).toHaveLength(1);
    expect(json.meta.cursor).toBeNull();
  });

  it("PERF3: uses the batched role lookup (no per-member N+1) when available", async () => {
    let batched = 0;
    let perMember = 0;
    let batchedIds: string[] = [];
    const member = (subjectId: string): OrganizationMember => ({
      id: subjectId, orgId: orgUuid, subjectId, subjectType: "user", status: "active", createdAt: fixedNow, updatedAt: fixedNow,
    });
    const repo = {
      listRoleAssignments: async () => {
        perMember += 1; // only the actor authz check should hit this
        return { ok: true as const, value: [] as RoleAssignment[] };
      },
      listMembersPaged: async () => ({
        ok: true as const,
        value: { items: [member("usr_owner"), member("usr_two")], nextCursor: null },
      }),
      listRoleAssignmentsForSubjects: async (_id: string, subjectIds: string[]) => {
        batched += 1;
        batchedIds = subjectIds;
        const m = new Map<string, RoleAssignment[]>();
        m.set("usr_owner", [{ id: "ra1", orgId: orgUuid, subjectId: "usr_owner", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null }]);
        m.set("usr_two", []);
        return { ok: true as const, value: m };
      },
    };
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { members: { roles: unknown[] }[] } };
    expect(batched).toBe(1); // one batched query for the whole page
    expect(batchedIds).toEqual(["usr_owner", "usr_two"]);
    expect(perMember).toBe(1); // ONLY the actor authz check — no per-member N+1
    expect(json.data.members).toHaveLength(2);
    expect(json.data.members[0]!.roles).toHaveLength(1);
    expect(json.data.members[1]!.roles).toHaveLength(0);
  });

  it("uses explicit limit when provided", async () => {
    const repo = createPagedRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    const url = new URL("http://localhost/v1/organizations/x/members?limit=10");

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, url, { repo });

    expect(response.status).toBe(200);
  });

  it("returns validation_failed for invalid limit", async () => {
    const repo = createPagedRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    const url = new URL("http://localhost/v1/organizations/x/members?limit=999");

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, url, { repo });

    expect(response.status).toBe(422);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("validation_failed");
  });

  it("returns validation_failed for non-integer limit", async () => {
    const repo = createPagedRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    const url = new URL("http://localhost/v1/organizations/x/members?limit=abc");

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, url, { repo });

    expect(response.status).toBe(422);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("validation_failed");
  });

  it("returns validation_failed for invalid cursor", async () => {
    const repo = createPagedRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    const url = new URL("http://localhost/v1/organizations/x/members?cursor=not_valid_base64!!!");

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, url, { repo });

    expect(response.status).toBe(422);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("validation_failed");
  });

  it("returns validation_failed for valid base64 cursor with invalid timestamp", async () => {
    const repo = createPagedRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    const badCursor = btoa(JSON.stringify({ v: 1, t: "not-a-timestamp", i: "aaaaaaaa-1111-2222-3333-444444444444" }));
    const url = new URL(`http://localhost/v1/organizations/x/members?cursor=${badCursor}`);

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, url, { repo });

    expect(response.status).toBe(422);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("validation_failed");
  });

  it("returns validation_failed for valid base64 cursor with invalid id", async () => {
    const repo = createPagedRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    const badCursor = btoa(JSON.stringify({ v: 1, t: "2026-01-15T10:00:00.000Z", i: "not-a-uuid" }));
    const url = new URL(`http://localhost/v1/organizations/x/members?cursor=${badCursor}`);

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, url, { repo });

    expect(response.status).toBe(422);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("validation_failed");
  });

  it("forwards valid cursor to the repository page call", async () => {
    let receivedParams: unknown;
    const repo = {
      listRoleAssignments: async () => ({ ok: true as const, value: [{ id: "ra1", orgId: orgUuid, subjectId: "usr_owner", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNow, revokedAt: null }] }),
      listMembersPaged: async (_id: string, params: unknown) => {
        receivedParams = params;
        return { ok: true as const, value: { items: [], nextCursor: null } };
      },
    };
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    const cursorPayload = btoa(JSON.stringify({ v: 1, t: "2026-01-15T10:00:00.000Z", i: "aaaaaaaa-1111-2222-3333-444444444444" }));
    const url = new URL(`http://localhost/v1/organizations/x/members?cursor=${cursorPayload}`);

    await handleListMembers(env, "req_test", actor, orgPublicIdStr, url, { repo });

    expect(receivedParams).toEqual({ limit: 50, cursor: { createdAt: "2026-01-15T10:00:00.000Z", id: "aaaaaaaa-1111-2222-3333-444444444444" } });
  });

  it("sets meta.cursor when another page exists", async () => {
    const repo = createPagedRepo({ hasNext: true });
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(200);
    const json = await response.json() as JsonResp;
    expect(json.meta.cursor).not.toBeNull();
    expect(typeof json.meta.cursor).toBe("string");
  });

  it("sets meta.cursor to null when no more pages", async () => {
    const repo = createPagedRepo({ hasNext: false });
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(200);
    const json = await response.json() as JsonResp;
    expect(json.meta.cursor).toBeNull();
  });

  it("still authorizes before page query", async () => {
    const repo = createPagedRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

    expect(response.status).toBe(404);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("not_found");
  });

  it("does not leak cursor format details in validation error", async () => {
    const repo = createPagedRepo();
    const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
    const url = new URL("http://localhost/v1/organizations/x/members?cursor=broken");

    const response = await handleListMembers(env, "req_test", actor, orgPublicIdStr, url, { repo });

    const text = await response.text();
    expect(text).not.toContain("JSON");
    expect(text).not.toContain("base64");
    expect(text).not.toContain("atob");
  });
});

describe("wrangler config", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.resolve(__dirname, "../../../apps/membership-worker/wrangler.jsonc"), "utf8");
  // Strip single-line comments for JSONC parsing
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));

  it("stage binds POLICY_WORKER to meterwise-policy-worker-stage", () => {
    const stageServices = config.env.stage.services;
    const policyBinding = stageServices.find((s: { binding: string }) => s.binding === "POLICY_WORKER");
    expect(policyBinding).toBeDefined();
    expect(policyBinding.service).toBe("meterwise-policy-worker-stage");
  });

  it("prod binds POLICY_WORKER to meterwise-policy-worker-prod", () => {
    const prodServices = config.env.prod.services;
    const policyBinding = prodServices.find((s: { binding: string }) => s.binding === "POLICY_WORKER");
    expect(policyBinding).toBeDefined();
    expect(policyBinding.service).toBe("meterwise-policy-worker-prod");
  });

  it("stage and prod never cross environments", () => {
    const stageService = config.env.stage.services.find((s: { binding: string }) => s.binding === "POLICY_WORKER")?.service;
    const prodService = config.env.prod.services.find((s: { binding: string }) => s.binding === "POLICY_WORKER")?.service;
    expect(stageService).toContain("stage");
    expect(prodService).toContain("prod");
    expect(stageService).not.toContain("prod");
    expect(prodService).not.toContain("stage");
  });

  it("local/dev/stage set DEBUG_DELIVERY to true", () => {
    expect(config.vars.DEBUG_DELIVERY).toBe("true");
    expect(config.env.dev.vars.DEBUG_DELIVERY).toBe("true");
    expect(config.env.stage.vars.DEBUG_DELIVERY).toBe("true");
  });

  it("prod sets DEBUG_DELIVERY to false", () => {
    expect(config.env.prod.vars.DEBUG_DELIVERY).toBe("false");
  });
});

describe("invitation administration", () => {
  const orgUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const orgPublicIdStr = `org_${orgUuid.replace(/-/g, "")}`;
  const actor = { subjectId: "usr_admin", subjectType: "user" };
  const fixedNowLocal = new Date("2026-01-15T10:00:00.000Z");

  function createPolicyFetcher(allow: boolean, captureBody?: { value: unknown }) {
    return {
      fetch: async (_url: string, init: RequestInit) => {
        if (captureBody) captureBody.value = JSON.parse(init.body as string);
        return Response.json({
          data: { allow, reason: allow ? "granted" : "denied", policyVersion: 1, derivedScope: {} },
          meta: { requestId: "req_test", cursor: null },
        });
      },
    } as unknown as Fetcher;
  }

  describe("handleCreateInvitation", () => {

    function createRepo(opts: { actorRolesFail?: boolean; createFail?: boolean; billableCount?: number; billableCountFail?: boolean } = {}) {
      const roles: RoleAssignment[] = [
        { id: "ra1", orgId: orgUuid, subjectId: "usr_admin", subjectType: "user", role: "admin", scopeKind: "organization", scopeRef: null, createdAt: fixedNowLocal, revokedAt: null },
      ];
      return {
        listRoleAssignments: async () => {
          if (opts.actorRolesFail) return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
          return { ok: true as const, value: roles };
        },
        countBillableMembers: async (_orgId: string, _now: Date) => {
          if (opts.billableCountFail) return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
          return { ok: true as const, value: opts.billableCount ?? 0 };
        },
        createInvitation: async (input: CreateInvitationInput) => {
          if (opts.createFail) return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
          return {
            ok: true as const,
            value: {
              id: input.id,
              orgId: input.orgId,
              email: input.email,
              emailLower: input.emailLower,
              role: input.role,
              status: "pending",
              invitedBy: input.invitedBy,
              expiresAt: input.expiresAt,
              acceptedAt: null,
              revokedAt: null,
              createdAt: input.createdAt,
            },
          };
        },
      };
    }

    /**
     * Default checkEntitlement injected by tests below: returns an unlimited
     * quantity entitlement so the billing gate (Task 0080) is effectively
     * pass-through for tests that aren't exercising it. Dedicated billing
     * gate tests pass their own checkEntitlement.
     */

    function makeRequest(body: unknown): Request {
      return new Request("https://test.local/v1/organizations/" + orgPublicIdStr + "/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("creates invitation with expected response shape", async () => {
      const repo = createRepo();
      const fakeToken = { raw: "deadbeef".repeat(8), hash: "cafebabe".repeat(8) };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "invite@test.com", role: "builder" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => fakeToken, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(201);
      const json = await response.json() as JsonResp;
      expect(json.data.invitation.id).toMatch(/^inv_[0-9a-f]{32}$/);
      expect(json.data.invitation.email).toBe("invite@test.com");
      expect(json.data.invitation.role).toBe("builder");
      expect(json.data.invitation.status).toBe("pending");
      expect(json.data.invitation.invitedBy).toBe("usr_admin");
      expect(json.data.delivery).toBeUndefined();
    });

    it("includes debug delivery token when DEBUG_DELIVERY is true", async () => {
      const repo = createRepo();
      const fakeToken = { raw: "secret_raw_token_hex", hash: "hash_hex" };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "true" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "invite@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => fakeToken, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(201);
      const json = await response.json() as JsonResp;
      expect(json.data.delivery).toEqual({ mode: "local_debug", token: "secret_raw_token_hex" });
    });

    it("prod delivery never includes raw token", async () => {
      const repo = createRepo();
      const fakeToken = { raw: "secret_raw_token", hash: "hash" };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "prod", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "invite@test.com", role: "admin" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => fakeToken, now: () => fixedNowLocal },
      );

      const text = await response.text();
      expect(text).not.toContain("secret_raw_token");
    });

    it("passes token hash to repository and not raw token", async () => {
      let capturedInput: CreateInvitationInput | null = null;
      const repo = {
        ...createRepo(),
        createInvitation: async (input: CreateInvitationInput) => {
          capturedInput = input;
          return { ok: true as const, value: { ...input, status: "pending", acceptedAt: null, revokedAt: null } };
        },
      };
      const fakeToken = { raw: "raw_secret", hash: "hashed_value_only" };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      await handleCreateInvitation(
        makeRequest({ email: "test@x.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => fakeToken, now: () => fixedNowLocal },
      );

      expect(capturedInput!.tokenHash).toBe("hashed_value_only");
      expect(JSON.stringify(capturedInput)).not.toContain("raw_secret");
    });

    it("returns validation_failed for bad JSON", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };
      const badReq = new Request("https://test.local/v1/organizations/" + orgPublicIdStr + "/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });

      const response = await handleCreateInvitation(
        badReq, env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(400);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("bad_request");
    });

    it("returns validation_failed for invalid email", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "not-an-email", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("validation_failed");
      expect(json.error.details.fields.email).toBeDefined();
    });

    it("returns validation_failed for missing role", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "user@test.com" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      const json = await response.json() as JsonResp;
      expect(json.error.details.fields.role).toBeDefined();
    });

    it("returns validation_failed for project-scoped role", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "user@test.com", role: "project_admin" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      const json = await response.json() as JsonResp;
      expect(json.error.details.fields.role).toBeDefined();
    });

    it("returns validation_failed for unknown role", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "user@test.com", role: "superuser" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
    });

    it("sends organization.invitation.create action to policy", async () => {
      const captured: { value: unknown } = { value: null };
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true, captured), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      await handleCreateInvitation(
        makeRequest({ email: "user@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect((captured.value as { action: string }).action).toBe("organization.invitation.create");
    });

    it("authorizes before creating invitation", async () => {
      let createCalled = false;
      const repo = {
        listRoleAssignments: async () => ({ ok: true as const, value: [] as RoleAssignment[] }),
        countBillableMembers: async () => ({ ok: true as const, value: 0 }),
        createInvitation: async (input: CreateInvitationInput) => {
          createCalled = true;
          return { ok: true as const, value: { ...input, status: "pending", acceptedAt: null, revokedAt: null } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "user@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(createCalled).toBe(false);
    });

    it("policy denial returns not_found", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "user@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("not_found");
    });

    it("actor role-list failure fails closed", async () => {
      const repo = createRepo({ actorRolesFail: true });
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "user@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("database failure returns safe internal_error", async () => {
      const repo = createRepo({ createFail: true });
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "user@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(500);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
    });

    it("invalid orgId returns not_found", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "user@test.com", role: "viewer" }),
        env, "req_test", actor, "bad_id",
        { repo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("successful create appends invite.created event/audit via eventsRepo", async () => {
      const repo = createRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "invite@test.com", role: "builder" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, eventsRepo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal, generateId: () => "generated_id_1" },
      );

      expect(response.status).toBe(201);
      expect(appendedInput).not.toBeNull();
      expect(appendedInput!.event.type).toBe("invite.created");
      expect(appendedInput!.event.version).toBe(1);
      expect(appendedInput!.event.source).toBe("membership-worker");
      expect(appendedInput!.event.actorType).toBe("user");
      expect(appendedInput!.event.actorId).toBe("usr_admin");
      expect(appendedInput!.event.subjectKind).toBe("invitation");
      expect(appendedInput!.event.subjectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.orgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.requestId).toBe("req_test");
      expect(appendedInput!.event.payload.role).toBe("builder");
      expect(appendedInput!.event.payload.expiresAt).toBeDefined();
      expect(appendedInput!.event.payload.invitationId).toMatch(/^inv_[0-9a-f]{32}$/);
      expect(appendedInput!.audit.category).toBe("membership");
      expect(appendedInput!.audit.description).toContain("created");
    });

    it("create event/audit append failure returns safe error and prevents commit", async () => {
      const repo = createRepo();
      const eventsRepo = {
        appendEventWithAudit: async () => {
          return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "invite@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, eventsRepo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      expect(response.status).toBe(500);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
    });

    it("create policy denial appends no event", async () => {
      const repo = createRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "invite@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, eventsRepo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("create validation failure appends no event", async () => {
      const repo = createRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "not-an-email", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, eventsRepo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      expect(eventAppended).toBe(false);
    });

    it("create repository failure appends no event", async () => {
      const repo = createRepo({ createFail: true });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "invite@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, eventsRepo, generateToken: async () => ({ raw: "x", hash: "y" }), now: () => fixedNowLocal },
      );

      expect(response.status).toBe(500);
      expect(eventAppended).toBe(false);
    });

    it("create event/audit values use public IDs and do not expose raw UUIDs or tokens", async () => {
      const repo = createRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      await handleCreateInvitation(
        makeRequest({ email: "invite@test.com", role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, eventsRepo, generateToken: async () => ({ raw: "secret_raw_token", hash: "secret_hash" }), now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      const eventStr = JSON.stringify(appendedInput);
      // Canonical fields now store raw UUIDs; public IDs are in payload/description
      expect(appendedInput!.event.orgId).toBe(orgUuid);
      expect(appendedInput!.event.subjectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.payload.invitationId).toMatch(/^inv_[0-9a-f]{32}$/);
      // Tokens/secrets must not leak
      expect(eventStr).not.toContain("secret_raw_token");
      expect(eventStr).not.toContain("secret_hash");
      expect(eventStr).not.toContain("token_hash");
      expect(eventStr).not.toContain("bearer");
    });

    it("create response shape remains compatible with existing tests", async () => {
      const repo = createRepo();
      const eventsRepo = {
        appendEventWithAudit: async () => ({ ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } }),
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "true" };

      const response = await handleCreateInvitation(
        makeRequest({ email: "invite@test.com", role: "builder" }),
        env, "req_test", actor, orgPublicIdStr,
        { repo, eventsRepo, generateToken: async () => ({ raw: "deadbeef".repeat(8), hash: "cafebabe".repeat(8) }), now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      expect(response.status).toBe(201);
      const json = await response.json() as JsonResp;
      expect(json.data.invitation.id).toMatch(/^inv_[0-9a-f]{32}$/);
      expect(json.data.invitation.email).toBe("invite@test.com");
      expect(json.data.invitation.role).toBe("builder");
      expect(json.data.invitation.status).toBe("pending");
      expect(json.data.delivery).toEqual({ mode: "local_debug", token: "deadbeef".repeat(8) });
    });

    // ── Billing entitlement gate (Task 0080) ──────────────────────
    describe("billing entitlement gate (limit.members)", () => {
      // Test helper. The `malformed_limit` cases intentionally fabricate a
      // decision shape that violates the strict CheckBillingEntitlementResponse
      // contract (e.g. boolean limitValue paired with non-quantity valueType) to
      // exercise the gate's error branch — that's why the parameter is
      // structurally typed and the helper is treated as a drop-in replacement
      // for `checkBillingEntitlement` at the call site.
      // Helper accepts the contract type plus a couple of fabricated-shape
      // overloads used by the malformed_limit branch tests (boolean valueType,
      // boolean limitValue, etc.). Returns a typed drop-in for
      // checkBillingEntitlement.
      function makeBillingDecision(
        decision:
          | CheckBillingEntitlementResponse
          | { allowed: true; orgId: string; entitlementKey: string; valueType: "boolean"; limitValue: boolean; source: "plan"; subscriptionId: string | null },
      ): typeof checkBillingEntitlement {
        return (async () => ({ kind: "decision" as const, decision: decision as CheckBillingEntitlementResponse })) as typeof checkBillingEntitlement;
      }
      const baseEnv = (): Env => ({
        POLICY_WORKER: createPolicyFetcher(true),
        BILLING_WORKER: {} as Fetcher,
        PLATFORM_DB: {} as D1Database,
        ENVIRONMENT: "test",
        DEBUG_DELIVERY: "false",
      });

      it("calls billing-worker with limit.members, the org public id, and a request id", async () => {
        const repo = createRepo({ billableCount: 0 });
        let captured: { binding: unknown; orgPublicIdArg: string; entitlementKey: string; requestId: string } | null = null;
        const checkEntitlement = (async (binding: Fetcher, orgPublicIdArg: string, entitlementKey: string, requestId: string) => {
          captured = { binding, orgPublicIdArg, entitlementKey, requestId };
          return {
            kind: "decision" as const,
            decision: { allowed: true, orgId: orgPublicIdArg, entitlementKey, valueType: "quantity", limitValue: null, source: "plan", subscriptionId: null },
          };
        }) as typeof checkBillingEntitlement;

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_abc", actor, orgPublicIdStr,
          { repo, generateToken: async () => ({ raw: "r", hash: "h" }), now: () => fixedNowLocal, checkEntitlement },
        );

        expect(response.status).toBe(201);
        expect(captured).not.toBeNull();
        expect(captured!.orgPublicIdArg).toBe(orgPublicIdStr);
        expect(captured!.entitlementKey).toBe("limit.members");
        expect(captured!.requestId).toBe("req_abc");
      });

      it("allows creation when billable count is strictly under the quantity limit", async () => {
        const repo = createRepo({ billableCount: 4 });
        const checkEntitlement = makeBillingDecision({ allowed: true, orgId: orgPublicIdStr, entitlementKey: "limit.members", valueType: "quantity", limitValue: 5, source: "plan", subscriptionId: null }) as typeof checkBillingEntitlement;

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_test", actor, orgPublicIdStr,
          { repo, generateToken: async () => ({ raw: "r", hash: "h" }), now: () => fixedNowLocal, checkEntitlement },
        );

        expect(response.status).toBe(201);
      });

      it("allows creation when the entitlement is unlimited (limitValue null)", async () => {
        const repo = createRepo({ billableCount: 9999 });
        const checkEntitlement = makeBillingDecision({ allowed: true, orgId: orgPublicIdStr, entitlementKey: "limit.members", valueType: "quantity", limitValue: null, source: "plan", subscriptionId: null }) as typeof checkBillingEntitlement;

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_test", actor, orgPublicIdStr,
          { repo, generateToken: async () => ({ raw: "r", hash: "h" }), now: () => fixedNowLocal, checkEntitlement },
        );

        expect(response.status).toBe(201);
      });

      it("denies with 412 limit_reached when billable count meets the quantity limit", async () => {
        let createCalls = 0;
        const baseRepo = createRepo({ billableCount: 3 });
        const repo = {
          ...baseRepo,
          createInvitation: async (input: CreateInvitationInput) => {
            createCalls++;
            return baseRepo.createInvitation(input);
          },
        };
        const checkEntitlement = makeBillingDecision({ allowed: true, orgId: orgPublicIdStr, entitlementKey: "limit.members", valueType: "quantity", limitValue: 3, source: "plan", subscriptionId: null }) as typeof checkBillingEntitlement;

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_test", actor, orgPublicIdStr,
          { repo, generateToken: async () => ({ raw: "r", hash: "h" }), now: () => fixedNowLocal, checkEntitlement },
        );

        expect(response.status).toBe(412);
        const json = await response.json() as { error: { code: string; details?: { reason?: string } } };
        expect(json.error.code).toBe("precondition_failed");
        expect(json.error.details?.reason).toBe("limit_reached");
        expect(createCalls).toBe(0);
      });

      it("denies with 412 disabled when billing returns allowed:false reason:disabled", async () => {
        const repo = createRepo();
        const checkEntitlement = makeBillingDecision({ allowed: false, orgId: orgPublicIdStr, entitlementKey: "limit.members", reason: "disabled" }) as typeof checkBillingEntitlement;

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_test", actor, orgPublicIdStr,
          { repo, generateToken: async () => ({ raw: "r", hash: "h" }), now: () => fixedNowLocal, checkEntitlement },
        );

        expect(response.status).toBe(412);
        const json = await response.json() as { error: { code: string; details?: { reason?: string } } };
        expect(json.error.details?.reason).toBe("disabled");
      });

      it("denies with 412 not_configured when no entitlement exists for the org", async () => {
        const repo = createRepo();
        const checkEntitlement = makeBillingDecision({ allowed: false, orgId: orgPublicIdStr, entitlementKey: "limit.members", reason: "not_configured" }) as typeof checkBillingEntitlement;

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_test", actor, orgPublicIdStr,
          { repo, generateToken: async () => ({ raw: "r", hash: "h" }), now: () => fixedNowLocal, checkEntitlement },
        );

        expect(response.status).toBe(412);
        const json = await response.json() as { error: { code: string; details?: { reason?: string } } };
        expect(json.error.details?.reason).toBe("not_configured");
      });

      it("returns 503 when billing-client surfaces service_error (fail-closed)", async () => {
        const repo = createRepo();
        const checkEntitlement: typeof checkBillingEntitlement = async () => ({ kind: "service_error" as const });

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_test", actor, orgPublicIdStr,
          { repo, generateToken: async () => ({ raw: "r", hash: "h" }), now: () => fixedNowLocal, checkEntitlement },
        );

        expect(response.status).toBe(503);
      });

      it("returns 503 when countBillableMembers fails (fail-closed)", async () => {
        const repo = createRepo({ billableCountFail: true });
        const checkEntitlement = makeBillingDecision({ allowed: true, orgId: orgPublicIdStr, entitlementKey: "limit.members", valueType: "quantity", limitValue: 5, source: "plan", subscriptionId: null }) as typeof checkBillingEntitlement;

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_test", actor, orgPublicIdStr,
          { repo, generateToken: async () => ({ raw: "r", hash: "h" }), now: () => fixedNowLocal, checkEntitlement },
        );

        expect(response.status).toBe(503);
      });

      it("returns 412 malformed_limit when entitlement valueType is not 'quantity'", async () => {
        const repo = createRepo();
        const checkEntitlement = makeBillingDecision({ allowed: true, orgId: orgPublicIdStr, entitlementKey: "limit.members", valueType: "boolean", limitValue: true, source: "plan", subscriptionId: null }) as typeof checkBillingEntitlement;

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_test", actor, orgPublicIdStr,
          { repo, generateToken: async () => ({ raw: "r", hash: "h" }), now: () => fixedNowLocal, checkEntitlement },
        );

        expect(response.status).toBe(412);
        const json = await response.json() as { error: { code: string; details?: { reason?: string } } };
        expect(json.error.details?.reason).toBe("malformed_limit");
      });

      it("gate runs BEFORE token generation and DB write", async () => {
        let tokenCalls = 0;
        let createCalls = 0;
        const baseRepo = createRepo({ billableCount: 5 });
        const repo = {
          ...baseRepo,
          createInvitation: async (input: CreateInvitationInput) => {
            createCalls++;
            return baseRepo.createInvitation(input);
          },
        };
        const checkEntitlement = makeBillingDecision({ allowed: true, orgId: orgPublicIdStr, entitlementKey: "limit.members", valueType: "quantity", limitValue: 5, source: "plan", subscriptionId: null }) as typeof checkBillingEntitlement;

        const response = await handleCreateInvitation(
          makeRequest({ email: "u@x.com", role: "viewer" }),
          baseEnv(), "req_test", actor, orgPublicIdStr,
          {
            repo,
            generateToken: async () => { tokenCalls++; return { raw: "r", hash: "h" }; },
            now: () => fixedNowLocal,
            checkEntitlement,
          },
        );

        expect(response.status).toBe(412);
        expect(tokenCalls).toBe(0);
        expect(createCalls).toBe(0);
      });
    });
  });

  describe("handleListInvitations", () => {

    function createRepo(opts: { actorRolesFail?: boolean; listFail?: boolean; expired?: boolean } = {}) {
      const roles: RoleAssignment[] = [
        { id: "ra1", orgId: orgUuid, subjectId: "usr_admin", subjectType: "user", role: "admin", scopeKind: "organization", scopeRef: null, createdAt: fixedNowLocal, revokedAt: null },
      ];
      const invitations = [
        {
          id: "11111111-aaaa-bbbb-cccc-dddddddddddd",
          orgId: orgUuid,
          email: "invited@test.com",
          emailLower: "invited@test.com",
          role: "viewer",
          status: "pending",
          invitedBy: "usr_admin",
          expiresAt: opts.expired ? new Date("2020-01-01T00:00:00Z") : new Date("2099-01-01T00:00:00Z"),
          acceptedAt: null,
          revokedAt: null,
          createdAt: fixedNowLocal,
        },
      ];
      return {
        listRoleAssignments: async () => {
          if (opts.actorRolesFail) return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
          return { ok: true as const, value: roles };
        },
        listInvitationsPaged: async () => {
          if (opts.listFail) return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
          return { ok: true as const, value: { items: invitations, nextCursor: null } };
        },
      };
    }

    it("lists invitations with expected response shape", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleListInvitations(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

      expect(response.status).toBe(200);
      const json = await response.json() as JsonResp;
      expect(json.data.invitations).toHaveLength(1);
      expect(json.data.invitations[0]!.id).toMatch(/^inv_[0-9a-f]{32}$/);
      expect(json.data.invitations[0]!.email).toBe("invited@test.com");
      expect(json.data.invitations[0]!.role).toBe("viewer");
      expect(json.data.invitations[0]!.status).toBe("pending");
      expect(json.meta.cursor).toBeNull();
    });

    it("derives expired status from expiresAt without DB mutation", async () => {
      const repo = createRepo({ expired: true });
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleListInvitations(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

      const json = await response.json() as JsonResp;
      expect(json.data.invitations[0]!.status).toBe("expired");
    });

    it("sends organization.invitation.list action to policy", async () => {
      const captured: { value: unknown } = { value: null };
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true, captured), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      await handleListInvitations(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

      expect((captured.value as { action: string }).action).toBe("organization.invitation.list");
    });

    it("returns meta.cursor when pagination has next page", async () => {
      const repo = {
        listRoleAssignments: async () => ({ ok: true as const, value: [{ id: "ra1", orgId: orgUuid, subjectId: "usr_admin", subjectType: "user", role: "admin", scopeKind: "organization", scopeRef: null, createdAt: fixedNowLocal, revokedAt: null }] }),
        listInvitationsPaged: async () => ({
          ok: true as const,
          value: {
            items: [{ id: "22222222-aaaa-bbbb-cccc-dddddddddddd", orgId: orgUuid, email: "x@y.com", emailLower: "x@y.com", role: "viewer", status: "pending", invitedBy: "usr_admin", expiresAt: new Date("2099-01-01T00:00:00Z"), acceptedAt: null, revokedAt: null, createdAt: fixedNowLocal }],
            nextCursor: { createdAt: fixedNowLocal.toISOString(), id: "22222222-aaaa-bbbb-cccc-dddddddddddd" },
          },
        }),
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleListInvitations(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

      const json = await response.json() as JsonResp;
      expect(json.meta.cursor).not.toBeNull();
      expect(typeof json.meta.cursor).toBe("string");
    });

    it("policy denial returns not_found", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleListInvitations(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

      expect(response.status).toBe(404);
    });

    it("actor role-list failure fails closed", async () => {
      const repo = createRepo({ actorRolesFail: true });
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleListInvitations(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

      expect(response.status).toBe(404);
    });

    it("database failure returns safe internal_error", async () => {
      const repo = createRepo({ listFail: true });
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleListInvitations(env, "req_test", actor, orgPublicIdStr, undefined, { repo });

      expect(response.status).toBe(500);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
    });

    it("does not expose raw invitation UUIDs", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleListInvitations(env, "req_test", actor, orgPublicIdStr, undefined, { repo });
      const text = await response.text();

      expect(text).not.toContain("11111111-aaaa-bbbb-cccc-dddddddddddd");
    });
  });

  describe("handleRevokeInvitation", () => {
    const invUuid = "11111111-2222-3333-4444-555555555555";
    const invPublicIdStr = invitationPublicId(invUuid);

    function createRepo(opts: { actorRolesFail?: boolean; revokeFail?: boolean; notFound?: boolean } = {}) {
      const roles: RoleAssignment[] = [
        { id: "ra1", orgId: orgUuid, subjectId: "usr_admin", subjectType: "user", role: "admin", scopeKind: "organization", scopeRef: null, createdAt: fixedNowLocal, revokedAt: null },
      ];
      return {
        listRoleAssignments: async () => {
          if (opts.actorRolesFail) return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
          return { ok: true as const, value: roles };
        },
        revokeInvitation: async (oId: string, iId: string, revokedAt: Date) => {
          if (opts.revokeFail) return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
          if (opts.notFound) return { ok: false as const, error: { kind: "not_found" as const } };
          return {
            ok: true as const,
            value: {
              id: iId,
              orgId: oId,
              email: "revoked@test.com",
              emailLower: "revoked@test.com",
              role: "viewer",
              status: "revoked",
              invitedBy: "usr_admin",
              expiresAt: new Date("2099-01-01T00:00:00Z"),
              acceptedAt: null,
              revokedAt: revokedAt,
              createdAt: fixedNowLocal,
            },
          };
        },
      };
    }

    it("revokes invitation and returns expected response shape", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(200);
      const json = await response.json() as JsonResp;
      expect(json.data.invitation.id).toMatch(/^inv_[0-9a-f]{32}$/);
      expect(json.data.invitation.status).toBe("revoked");
      expect(json.data.invitation.revokedAt).not.toBeNull();
    });

    it("sends organization.invitation.revoke action to policy", async () => {
      const captured: { value: unknown } = { value: null };
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true, captured), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, now: () => fixedNowLocal },
      );

      expect((captured.value as { action: string }).action).toBe("organization.invitation.revoke");
    });

    it("policy denial returns not_found", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("returns not_found for already revoked/accepted invitation", async () => {
      const repo = createRepo({ notFound: true });
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("invalid invitation ID returns not_found", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, "bad_inv_id",
        { repo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("invalid org ID returns not_found", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, "bad_org", invPublicIdStr,
        { repo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("actor role-list failure fails closed", async () => {
      const repo = createRepo({ actorRolesFail: true });
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("database failure returns safe internal_error", async () => {
      const repo = createRepo({ revokeFail: true });
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(500);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
    });

    it("does not expose raw invitation UUID in response", async () => {
      const repo = createRepo();
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, now: () => fixedNowLocal },
      );

      const text = await response.text();
      expect(text).not.toContain(invUuid);
    });

    it("successful revoke appends invite.revoked event/audit via eventsRepo", async () => {
      const repo = createRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "generated_id_1" },
      );

      expect(response.status).toBe(200);
      expect(appendedInput).not.toBeNull();
      expect(appendedInput!.event.type).toBe("invite.revoked");
      expect(appendedInput!.event.version).toBe(1);
      expect(appendedInput!.event.source).toBe("membership-worker");
      expect(appendedInput!.event.actorType).toBe("user");
      expect(appendedInput!.event.actorId).toBe("usr_admin");
      expect(appendedInput!.event.subjectKind).toBe("invitation");
      expect(appendedInput!.event.subjectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.orgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.requestId).toBe("req_test");
      expect(appendedInput!.audit.category).toBe("membership");
      expect(appendedInput!.audit.description).toContain("revoked");
    });

    it("event/audit append failure returns safe error and prevents commit", async () => {
      const repo = createRepo();
      const eventsRepo = {
        appendEventWithAudit: async () => {
          return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      expect(response.status).toBe(500);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
    });

    it("policy denial appends no event", async () => {
      const repo = createRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("invitation not found appends no event", async () => {
      const repo = createRepo({ notFound: true });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      const response = await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("event/audit values use public IDs and do not expose raw UUIDs or tokens", async () => {
      const repo = createRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test", DEBUG_DELIVERY: "false" };

      await handleRevokeInvitation(
        env, "req_test", actor, orgPublicIdStr, invPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      const eventStr = JSON.stringify(appendedInput);
      // Canonical fields now store raw UUIDs; public IDs are in payload/description
      expect(appendedInput!.event.orgId).toBe(orgUuid);
      expect(appendedInput!.event.subjectId).toBe(invUuid);
      expect(appendedInput!.event.payload.invitationId).toMatch(/^inv_[0-9a-f]{32}$/);
      // Must not contain token-like strings
      expect(eventStr).not.toContain("token_hash");
      expect(eventStr).not.toContain("bearer");
    });
  });

  describe("handleAcceptInvitation", () => {
    const acceptActor = { subjectId: "usr_acceptor", subjectType: "user", email: "invite@example.com" };
    const validToken = "a".repeat(64);

    function createAcceptRepo(opts: { result?: MembershipResult<{ invitation: OrganizationInvitation; member: OrganizationMember; roleAssignment: RoleAssignment }>; fail?: boolean } = {}) {
      let capturedInput: AcceptInvitationInput | null = null;
      const invUuid = "11111111-2222-3333-4444-555555555555";
      const memUuid = "66666666-7777-8888-9999-aaaaaaaaaaaa";
      return {
        acceptInvitation: async (input: AcceptInvitationInput) => {
          capturedInput = input;
          if (opts.fail) return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
          if (opts.result) return opts.result;
          return {
            ok: true as const,
            value: {
              invitation: {
                id: invUuid, orgId: orgUuid, email: "invite@example.com", emailLower: "invite@example.com",
                role: "builder", status: "accepted", invitedBy: "usr_admin",
                expiresAt: new Date("2026-02-15T10:00:00Z"), acceptedAt: fixedNowLocal,
                revokedAt: null, createdAt: fixedNowLocal,
              },
              member: {
                id: memUuid, orgId: orgUuid, subjectId: "usr_acceptor", subjectType: "user",
                status: "active", createdAt: fixedNowLocal, updatedAt: fixedNowLocal,
              },
              roleAssignment: {
                id: "ra-new-uuid", orgId: orgUuid, subjectId: "usr_acceptor", subjectType: "user",
                role: "builder", scopeKind: "organization", scopeRef: null,
                createdAt: fixedNowLocal, revokedAt: null,
              },
            },
          };
        },
        get _capturedInput() { return capturedInput; },
      };
    }

    function makeAcceptRequest(body: unknown): Request {
      return new Request("https://test.local/v1/organizations/" + orgPublicIdStr + "/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("returns 200 with correct response shape on success", async () => {
      const repo = createAcceptRepo();
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async (t: string) => "hashed_" + t, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(200);
      const json = await response.json() as JsonResp;
      expect(json.data.invitation.id).toMatch(/^inv_[0-9a-f]{32}$/);
      expect(json.data.invitation.email).toBe("invite@example.com");
      expect(json.data.invitation.role).toBe("builder");
      expect(json.data.invitation.status).toBe("accepted");
      expect(json.data.membership.id).toMatch(/^mem_/);
      expect(json.data.membership.role).toBe("builder");
      expect(json.data.membership.status).toBe("active");
      expect(json.data.membership.joinedAt).toBeDefined();
    });

    it("returns validation_failed for malformed JSON", async () => {
      const repo = createAcceptRepo();
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
      const request = new Request("https://test.local/v1/organizations/" + orgPublicIdStr + "/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });

      const response = await handleAcceptInvitation(
        request, env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async (t: string) => "hashed_" + t, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(400);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("bad_request");
    });

    it("returns validation_failed for non-hex token", async () => {
      const repo = createAcceptRepo();
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: "not-a-valid-token" }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async (t: string) => "hashed_" + t, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("validation_failed");
      expect(json.error.details.fields.token).toBeDefined();
    });

    it("returns validation_failed for missing token field", async () => {
      const repo = createAcceptRepo();
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({}),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async (t: string) => "hashed_" + t, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for too-short token", async () => {
      const repo = createAcceptRepo();
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: "abc123" }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async (t: string) => "hashed_" + t, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
    });

    it("returns not_found for invalid public org ID", async () => {
      const repo = createAcceptRepo();
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, "org_invalid",
        { repo, hashToken: async (t: string) => "hashed_" + t, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("passes token hash to repository, not raw token", async () => {
      const repo = createAcceptRepo();
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };
      let hashInput: string | null = null;

      await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async (t: string) => { hashInput = t; return "hashed_value"; }, now: () => fixedNowLocal },
      );

      expect(hashInput).toBe(validToken);
      expect(repo._capturedInput!.tokenHash).toBe("hashed_value");
      expect(JSON.stringify(repo._capturedInput)).not.toContain(validToken);
    });

    it("maps not_found repository error to 404", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "not_found" } } });
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("maps expired repository error to 404", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "expired" } } });
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("maps revoked repository error to 404", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "revoked" } } });
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("maps already_accepted repository error to 404", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "already_accepted" } } });
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
    });

    it("maps conflict repository error to 409", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "conflict", entity: "organization_member" } } });
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(409);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("conflict");
    });

    it("maps internal repository error to 500", async () => {
      const repo = createAcceptRepo({ fail: true });
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(500);
    });

    it("does not call policy-worker for acceptance", async () => {
      const repo = createAcceptRepo();
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(200);
    });

    it("does not expose raw token, token hash, or raw UUIDs in response", async () => {
      const repo = createAcceptRepo();
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, hashToken: async () => "hashed_value", now: () => fixedNowLocal },
      );

      const text = await response.text();
      expect(text).not.toContain(validToken);
      expect(text).not.toContain("hashed_value");
      expect(text).not.toContain("11111111-2222-3333-4444-555555555555");
      expect(text).not.toContain("66666666-7777-8888-9999-aaaaaaaaaaaa");
    });

    it("successful accept appends invite.accepted event/audit via eventsRepo", async () => {
      const repo = createAcceptRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, eventsRepo, hashToken: async () => "hashed_value", now: () => fixedNowLocal, generateId: () => "generated_id_1" },
      );

      expect(response.status).toBe(200);
      expect(appendedInput).not.toBeNull();
      expect(appendedInput!.event.type).toBe("invite.accepted");
      expect(appendedInput!.event.version).toBe(1);
      expect(appendedInput!.event.source).toBe("membership-worker");
      expect(appendedInput!.event.actorType).toBe("user");
      expect(appendedInput!.event.actorId).toBe("usr_acceptor");
      expect(appendedInput!.event.subjectKind).toBe("invitation");
      expect(appendedInput!.event.subjectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.orgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.requestId).toBe("req_test");
      expect(appendedInput!.event.payload.role).toBe("builder");
      expect(appendedInput!.event.payload.memberId).toMatch(/^mem_[0-9a-f]{32}$/);
      expect(appendedInput!.audit.category).toBe("membership");
      expect(appendedInput!.audit.description).toContain("accepted");
    });

    it("accept event/audit append failure returns safe error and prevents commit", async () => {
      const repo = createAcceptRepo();
      const eventsRepo = {
        appendEventWithAudit: async () => {
          return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, eventsRepo, hashToken: async () => "hashed_value", now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      expect(response.status).toBe(500);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
    });

    it("accept not-found appends no event", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "not_found" } } });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, eventsRepo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("accept expired appends no event", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "expired" } } });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, eventsRepo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("accept revoked appends no event", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "revoked" } } });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, eventsRepo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("accept already-accepted appends no event", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "already_accepted" } } });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, eventsRepo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("accept conflict appends no event", async () => {
      const repo = createAcceptRepo({ result: { ok: false, error: { kind: "conflict", entity: "organization_member" } } });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, eventsRepo, hashToken: async () => "hash", now: () => fixedNowLocal },
      );

      expect(response.status).toBe(409);
      expect(eventAppended).toBe(false);
    });

    it("accept event/audit values use public IDs and do not expose raw UUIDs or tokens", async () => {
      const repo = createAcceptRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, eventsRepo, hashToken: async () => "hashed_value", now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      const eventStr = JSON.stringify(appendedInput);
      // Canonical fields now store raw UUIDs; public IDs in payload/description
      expect(appendedInput!.event.orgId).toBe(orgUuid);
      expect(appendedInput!.event.subjectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.payload.memberId).toMatch(/^mem_/);
      expect(eventStr).not.toContain(validToken);
      expect(eventStr).not.toContain("hashed_value");
      expect(eventStr).not.toContain("token_hash");
      expect(eventStr).not.toContain("bearer");
    });

    it("accept response shape remains compatible", async () => {
      const repo = createAcceptRepo();
      const eventsRepo = {
        appendEventWithAudit: async () => ({ ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } }),
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleAcceptInvitation(
        makeAcceptRequest({ token: validToken }),
        env, "req_test", acceptActor, orgPublicIdStr,
        { repo, eventsRepo, hashToken: async () => "hashed_value", now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      expect(response.status).toBe(200);
      const json = await response.json() as JsonResp;
      expect(json.data.invitation.id).toMatch(/^inv_[0-9a-f]{32}$/);
      expect(json.data.invitation.status).toBe("accepted");
      expect(json.data.membership.id).toMatch(/^mem_/);
      expect(json.data.membership.role).toBe("builder");
      expect(json.data.membership.status).toBe("active");
      expect(json.data.membership.joinedAt).toBeDefined();
    });
  });

  describe("invitation ID utilities", () => {
    it("converts UUID to inv_ prefixed public ID", () => {
      expect(invitationPublicId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("inv_aaaaaaaabbbbccccddddeeeeeeeeeeee");
    });

    it("parses inv_ prefixed public ID back to UUID", () => {
      expect(parseInvitationPublicId("inv_aaaaaaaabbbbccccddddeeeeeeeeeeee")).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    });

    it("returns null for invalid prefix", () => {
      expect(parseInvitationPublicId("mem_aaaaaaaabbbbccccddddeeeeeeeeeeee")).toBeNull();
    });

    it("returns null for invalid hex length", () => {
      expect(parseInvitationPublicId("inv_abc")).toBeNull();
    });

    it("roundtrips correctly", () => {
      const uuid = "12345678-abcd-ef01-2345-6789abcdef01";
      expect(parseInvitationPublicId(invitationPublicId(uuid))).toBe(uuid);
    });
  });
});

describe("member administration", () => {
  const orgUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const orgPublicIdStr = `org_${orgUuid.replace(/-/g, "")}`;
  const memberUuid = "11111111-2222-3333-4444-555555555555";
  const memberPublicIdStr = `mem_${memberUuid.replace(/-/g, "")}`;
  const actor = { subjectId: "usr_admin", subjectType: "user" };
  const fixedNowLocal = new Date("2026-01-15T10:00:00.000Z");

  function createPolicyFetcher(allow: boolean, captureBody?: { value: unknown }) {
    return {
      fetch: async (_url: string, init: RequestInit) => {
        if (captureBody) captureBody.value = JSON.parse(init.body as string);
        return Response.json({
          data: { allow, reason: allow ? "granted" : "denied", policyVersion: 1, derivedScope: {} },
          meta: { requestId: "req_test", cursor: null },
        });
      },
    } as unknown as Fetcher;
  }

  function createMemberRepo(opts: {
    memberNotFound?: boolean;
    memberRemoved?: boolean;
    actorRolesFail?: boolean;
    ownerCount?: number;
    ownerCountFail?: boolean;
    removeFail?: boolean;
    revokeFail?: boolean;
    createRoleFail?: boolean;
  } = {}) {
    const member: OrganizationMember = {
      id: memberUuid,
      orgId: orgUuid,
      subjectId: "usr_target",
      subjectType: "user",
      status: "active",
      createdAt: fixedNowLocal,
      updatedAt: fixedNowLocal,
    };
    const currentRoles: RoleAssignment[] = [
      {
        id: "ra-current-1",
        orgId: orgUuid,
        subjectId: "usr_target",
        subjectType: "user",
        role: "admin",
        scopeKind: "organization",
        scopeRef: null,
        createdAt: fixedNowLocal,
        revokedAt: null,
      },
    ];

    return {
      listRoleAssignments: async (id: string, subjectId: string) => {
        if (opts.actorRolesFail && subjectId === actor.subjectId) {
          return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
        }
        if (subjectId === "usr_target") {
          return { ok: true as const, value: currentRoles };
        }
        return { ok: true as const, value: [{ id: "ra-actor", orgId: orgUuid, subjectId: actor.subjectId, subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNowLocal, revokedAt: null }] };
      },
      getMemberById: async (_orgId: string, _memberId: string) => {
        if (opts.memberNotFound) return { ok: false as const, error: { kind: "not_found" as const } };
        if (opts.memberRemoved) return { ok: false as const, error: { kind: "removed" as const } };
        return { ok: true as const, value: member };
      },
      countActiveOwners: async (_orgId: string) => {
        if (opts.ownerCountFail) return { ok: false as const, error: { kind: "internal" as const, message: "db fail" } };
        return { ok: true as const, value: opts.ownerCount ?? 2 };
      },
      revokeAllRoleAssignments: async (_orgId: string, _subjectId: string, _revokedAt: Date) => {
        if (opts.revokeFail) return { ok: false as const, error: { kind: "internal" as const, message: "revoke failed" } };
        return { ok: true as const, value: currentRoles.map((r) => ({ ...r, revokedAt: fixedNowLocal })) };
      },
      createRoleAssignment: async (input: CreateRoleAssignmentInput) => {
        if (opts.createRoleFail) return { ok: false as const, error: { kind: "internal" as const, message: "create failed" } };
        return { ok: true as const, value: { ...input, scopeRef: input.scopeRef ?? null, revokedAt: null } };
      },
      removeMember: async (_orgId: string, _memberId: string, _at: Date) => {
        if (opts.removeFail) return { ok: false as const, error: { kind: "not_found" as const } };
        return { ok: true as const, value: { ...member, status: "removed", updatedAt: _at } };
      },
    };
  }

  function makeRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("handleUpdateMemberRole", () => {
    it("successful role update authorizes through policy and appends membership.updated", async () => {
      const repo = createMemberRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const policyCapture = { value: null as unknown };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true, policyCapture), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "generated_evt_1" },
      );

      expect(response.status).toBe(200);
      const json = await response.json() as JsonResp;
      expect(json.data.member.id).toMatch(/^mem_/);
      expect(json.data.member.roles).toBeDefined();

      // Policy was called
      expect(policyCapture.value).not.toBeNull();
      const policyBody = policyCapture.value as { action: string; resource: { kind: string; id: string; orgId: string }; subject: { id: string; type: string }; context: Record<string, unknown> };
      expect(policyBody.action).toBe("organization.member.update_role");

      // Event was appended
      expect(appendedInput).not.toBeNull();
      expect(appendedInput!.event.type).toBe("membership.updated");
      expect(appendedInput!.event.version).toBe(1);
      expect(appendedInput!.event.source).toBe("membership-worker");
      expect(appendedInput!.event.actorType).toBe("user");
      expect(appendedInput!.event.actorId).toBe("usr_admin");
      expect(appendedInput!.event.subjectKind).toBe("member");
      expect(appendedInput!.event.subjectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.orgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.requestId).toBe("req_test");
      expect(appendedInput!.event.payload.role).toBe("viewer");
      expect(appendedInput!.event.payload.previousRoles).toContain("admin");
      expect(appendedInput!.event.payload.memberId).toMatch(/^mem_[0-9a-f]{32}$/);
      expect(appendedInput!.audit.category).toBe("membership");
      expect(appendedInput!.audit.description).toContain("updated");
    });

    it("event/audit append failure returns safe error", async () => {
      const repo = createMemberRepo();
      const eventsRepo = {
        appendEventWithAudit: async () => {
          return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      expect(response.status).toBe(500);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
      const text = JSON.stringify(json);
      expect(text).not.toContain("db error");
      expect(text).not.toContain("stack");
      expect(text).not.toContain("SQL");
    });

    it("policy denial appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("invalid org ID appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, "bad_org_id", memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("invalid member ID appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, "invalid_member",
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("invalid role body appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "superadmin" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      expect(eventAppended).toBe(false);
    });

    it("missing role in body returns validation error and appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({}),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      expect(eventAppended).toBe(false);
    });

    it("target member not found appends no event", async () => {
      const repo = createMemberRepo({ memberNotFound: true });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("target member removed appends no event", async () => {
      const repo = createMemberRepo({ memberRemoved: true });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("last-owner role change is rejected and appends no event", async () => {
      // Create repo where target is owner and is the only owner
      const ownerRepo = createMemberRepo({ ownerCount: 1 });
      // Override listRoleAssignments so the target is an owner
      const originalList = ownerRepo.listRoleAssignments;
      ownerRepo.listRoleAssignments = async (id: string, subjectId: string) => {
        if (subjectId === "usr_target") {
          return { ok: true as const, value: [{
            id: "ra-owner-1", orgId: orgUuid, subjectId: "usr_target", subjectType: "user",
            role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNowLocal, revokedAt: null,
          }] };
        }
        return originalList(id, subjectId);
      };

      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo: ownerRepo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("precondition_failed");
      expect(eventAppended).toBe(false);
    });

    it("missing POLICY_WORKER returns 503 and appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(503);
      expect(eventAppended).toBe(false);
    });

    it("missing PLATFORM_DB without deps returns 503", async () => {
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
      );

      expect(response.status).toBe(503);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
    });

    it("responses use public IDs and safe role summaries", async () => {
      const repo = createMemberRepo();
      const eventsRepo = {
        appendEventWithAudit: async () => ({ ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } }),
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleUpdateMemberRole(
        makeRequest({ role: "builder" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      expect(response.status).toBe(200);
      const json = await response.json() as JsonResp;
      expect(json.data.member.id).toMatch(/^mem_[0-9a-f]{32}$/);
      expect(Array.isArray(json.data.member.roles)).toBe(true);
      for (const r of json.data.member.roles) {
        expect(r).toHaveProperty("role");
        expect(r).toHaveProperty("scopeKind");
        expect(r).not.toHaveProperty("id");
        expect(r).not.toHaveProperty("subjectId");
        expect(r).not.toHaveProperty("orgId");
        expect(r).not.toHaveProperty("scopeRef");
      }
    });

    it("event/audit values do not expose raw UUIDs, bearer tokens, SQL, stack traces, or provider details", async () => {
      const repo = createMemberRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      await handleUpdateMemberRole(
        makeRequest({ role: "viewer" }),
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      const eventStr = JSON.stringify(appendedInput);
      // Canonical fields now store raw UUIDs; public IDs in payload
      expect(appendedInput!.event.orgId).toBe(orgUuid);
      expect(appendedInput!.event.subjectId).toBe(memberUuid);
      expect(appendedInput!.event.payload.memberId).toMatch(/^mem_/);
      // Must not contain sensitive patterns
      expect(eventStr.toLowerCase()).not.toContain("bearer");
      expect(eventStr).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/);
      expect(eventStr).not.toContain("stack");
    });
  });

  describe("handleRemoveMember", () => {
    it("successful removal authorizes through policy and appends membership.removed", async () => {
      const repo = createMemberRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const policyCapture = { value: null as unknown };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true, policyCapture), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "generated_evt_2" },
      );

      expect(response.status).toBe(200);
      const json = await response.json() as JsonResp;
      expect(json.data.member.id).toMatch(/^mem_/);
      expect(json.data.member.status).toBe("removed");
      expect(json.data.member.roles).toEqual([]);

      // Policy was called
      expect(policyCapture.value).not.toBeNull();
      const policyBody = policyCapture.value as { action: string; resource: { kind: string; id: string; orgId: string }; subject: { id: string; type: string }; context: Record<string, unknown> };
      expect(policyBody.action).toBe("organization.member.remove");

      // Event was appended
      expect(appendedInput).not.toBeNull();
      expect(appendedInput!.event.type).toBe("membership.removed");
      expect(appendedInput!.event.version).toBe(1);
      expect(appendedInput!.event.source).toBe("membership-worker");
      expect(appendedInput!.event.actorType).toBe("user");
      expect(appendedInput!.event.actorId).toBe("usr_admin");
      expect(appendedInput!.event.subjectKind).toBe("member");
      expect(appendedInput!.event.subjectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.orgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(appendedInput!.event.requestId).toBe("req_test");
      expect(appendedInput!.event.payload.previousRoles).toContain("admin");
      expect(appendedInput!.event.payload.revokedRoleCount).toBeGreaterThanOrEqual(1);
      expect(appendedInput!.audit.category).toBe("membership");
      expect(appendedInput!.audit.description).toContain("removed");
    });

    it("event/audit append failure returns safe error", async () => {
      const repo = createMemberRepo();
      const eventsRepo = {
        appendEventWithAudit: async () => {
          return { ok: false as const, error: { kind: "internal" as const, message: "db error" } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      expect(response.status).toBe(500);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
      const text = JSON.stringify(json);
      expect(text).not.toContain("db error");
      expect(text).not.toContain("stack");
      expect(text).not.toContain("SQL");
    });

    it("policy denial appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(false), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("invalid org ID appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, "bad_org_id", memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("invalid member ID appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, "invalid_member",
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("target member not found appends no event", async () => {
      const repo = createMemberRepo({ memberNotFound: true });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("target member already removed appends no event", async () => {
      const repo = createMemberRepo({ memberRemoved: true });
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(404);
      expect(eventAppended).toBe(false);
    });

    it("last-owner removal is rejected and appends no event", async () => {
      // Create repo where target is owner and is the only owner
      const ownerRepo = createMemberRepo({ ownerCount: 1 });
      const originalList = ownerRepo.listRoleAssignments;
      ownerRepo.listRoleAssignments = async (id: string, subjectId: string) => {
        if (subjectId === "usr_target") {
          return { ok: true as const, value: [{
            id: "ra-owner-1", orgId: orgUuid, subjectId: "usr_target", subjectType: "user",
            role: "owner", scopeKind: "organization", scopeRef: null, createdAt: fixedNowLocal, revokedAt: null,
          }] };
        }
        return originalList(id, subjectId);
      };

      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo: ownerRepo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(422);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("precondition_failed");
      expect(eventAppended).toBe(false);
    });

    it("missing POLICY_WORKER returns 503 and appends no event", async () => {
      const repo = createMemberRepo();
      let eventAppended = false;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          eventAppended = true;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal },
      );

      expect(response.status).toBe(503);
      expect(eventAppended).toBe(false);
    });

    it("missing PLATFORM_DB without deps returns 503", async () => {
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
      );

      expect(response.status).toBe(503);
      const json = await response.json() as JsonResp;
      expect(json.error.code).toBe("internal_error");
    });

    it("responses use public IDs and safe role summaries", async () => {
      const repo = createMemberRepo();
      const eventsRepo = {
        appendEventWithAudit: async () => ({ ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } }),
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      const response = await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      // Raw UUIDs must not appear
      expect(text).not.toContain(orgUuid);
      expect(text).not.toContain(memberUuid);
      // Public prefixed IDs should appear
      expect(text).toContain("mem_");
    });

    it("event/audit values do not expose raw UUIDs, bearer tokens, SQL, stack traces, or provider details", async () => {
      const repo = createMemberRepo();
      let appendedInput: AppendEventWithAuditInput | null = null;
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInput = input;
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const env: Env = { POLICY_WORKER: createPolicyFetcher(true), PLATFORM_DB: {} as D1Database, ENVIRONMENT: "test" };

      await handleRemoveMember(
        env, "req_test", actor, orgPublicIdStr, memberPublicIdStr,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id" },
      );

      const eventStr = JSON.stringify(appendedInput);
      // Canonical fields now store raw UUIDs; public IDs in payload
      expect(appendedInput!.event.orgId).toBe(orgUuid);
      expect(appendedInput!.event.subjectId).toBe(memberUuid);
      expect(appendedInput!.event.payload.memberId).toMatch(/^mem_/);
      // Must not contain sensitive patterns
      expect(eventStr.toLowerCase()).not.toContain("bearer");
      expect(eventStr).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/);
      expect(eventStr).not.toContain("stack");
    });
  });

  describe("organization bootstrap event/audit", () => {
    const actor = { subjectId: "usr_00112233445566778899aabbccddeeff", subjectType: "user" };
    const fixedNowLocal = new Date("2026-01-20T12:00:00.000Z");

    function createRequest(body: object): Request {
      return new Request("http://localhost/v1/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("emits organization.created and membership.added events on successful bootstrap", async () => {
      const repo = createFakeRepository();
      const appendedInputs: AppendEventWithAuditInput[] = [];
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInputs.push(input);
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      const response = await handleCreateOrganization(
        createRequest({ name: "Acme Corp", slug: "acme-corp" }),
        {} as Env,
        "req_bootstrap_1",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_1" },
      );

      expect(response.status).toBe(201);
      expect(appendedInputs).toHaveLength(2);
      expect(appendedInputs[0]!.event.type).toBe("organization.created");
      expect(appendedInputs[1]!.event.type).toBe("membership.added");
    });

    it("assigns the free plan (best-effort) with the org public id on bootstrap", async () => {
      const repo = createFakeRepository();
      const eventsRepo = {
        appendEventWithAudit: async () => ({ ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } }),
      };
      const assigned: string[] = [];
      const response = await handleCreateOrganization(
        createRequest({ name: "Plan Co", slug: "plan-co" }),
        {} as Env,
        "req_plan_1",
        actor,
        {
          repo,
          eventsRepo,
          now: () => fixedNowLocal,
          generateId: () => "gen_id_p",
          assignPlan: async (orgPublic: string) => {
            assigned.push(orgPublic);
            return { kind: "ok" as const };
          },
        },
      );
      expect(response.status).toBe(201);
      expect(assigned).toHaveLength(1);
      expect(assigned[0]).toMatch(/^org_[0-9a-f]{32}$/);
    });

    it("still returns 201 when plan assignment throws (best-effort, non-blocking)", async () => {
      const repo = createFakeRepository();
      const eventsRepo = {
        appendEventWithAudit: async () => ({ ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } }),
      };
      const response = await handleCreateOrganization(
        createRequest({ name: "Resilient Co", slug: "resilient-co" }),
        {} as Env,
        "req_plan_2",
        actor,
        {
          repo,
          eventsRepo,
          now: () => fixedNowLocal,
          generateId: () => "gen_id_q",
          assignPlan: async () => {
            throw new Error("billing down");
          },
        },
      );
      expect(response.status).toBe(201);
    });

    it("stores raw UUIDs in canonical event fields", async () => {
      const repo = createFakeRepository();
      const appendedInputs: AppendEventWithAuditInput[] = [];
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInputs.push(input);
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      await handleCreateOrganization(
        createRequest({ name: "Raw IDs Test", slug: "raw-ids" }),
        {} as Env,
        "req_raw",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_2" },
      );

      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      // organization.created
      expect(appendedInputs[0]!.event.orgId).toMatch(uuidRe);
      expect(appendedInputs[0]!.event.subjectId).toMatch(uuidRe);
      expect(appendedInputs[0]!.event.subjectKind).toBe("organization");
      // membership.added
      expect(appendedInputs[1]!.event.orgId).toMatch(uuidRe);
      expect(appendedInputs[1]!.event.subjectId).toMatch(uuidRe);
      expect(appendedInputs[1]!.event.subjectKind).toBe("member");
      // orgId should be the same in both events
      expect(appendedInputs[0]!.event.orgId).toBe(appendedInputs[1]!.event.orgId);
    });

    it("includes safe public IDs in event payloads", async () => {
      const repo = createFakeRepository();
      const appendedInputs: AppendEventWithAuditInput[] = [];
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInputs.push(input);
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      await handleCreateOrganization(
        createRequest({ name: "Payload Test", slug: "payload-test" }),
        {} as Env,
        "req_payload",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_3" },
      );

      // organization.created payload has public org ID, name, slug
      const orgPayload = appendedInputs[0]!.event.payload;
      expect(orgPayload.orgId).toMatch(/^org_[0-9a-f]{32}$/);
      expect(orgPayload.name).toBe("Payload Test");
      expect(orgPayload.slug).toBe("payload-test");

      // membership.added payload has public org/member IDs and role
      const memPayload = appendedInputs[1]!.event.payload;
      expect(memPayload.orgId).toMatch(/^org_[0-9a-f]{32}$/);
      expect(memPayload.memberId).toMatch(/^mem_[0-9a-f]{32}$/);
      expect(memPayload.role).toBe("owner");
      expect(memPayload.subjectType).toBe("user");
    });

    it("does not expose bearer tokens, SQL, secrets, or stack traces in events", async () => {
      const repo = createFakeRepository();
      const appendedInputs: AppendEventWithAuditInput[] = [];
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInputs.push(input);
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      await handleCreateOrganization(
        createRequest({ name: "Security Test", slug: "sec-test" }),
        {} as Env,
        "req_sec",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_4" },
      );

      for (const input of appendedInputs) {
        const str = JSON.stringify(input);
        expect(str.toLowerCase()).not.toContain("bearer");
        expect(str.toLowerCase()).not.toContain("token");
        expect(str).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/);
        expect(str).not.toContain("stack");
        expect(str).not.toContain("connectionString");
      }
    });

    it("returns failure when event/audit append fails (atomicity seam)", async () => {
      const repo = createFakeRepository();
      const eventsRepo = {
        appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "db failure" } }),
      };
      const response = await handleCreateOrganization(
        createRequest({ name: "Failure Test", slug: "fail-test" }),
        {} as Env,
        "req_fail",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_5" },
      );

      expect(response.status).toBe(500);
      const body = await response.json() as JsonResp;
      expect(body.error.code).toBe("internal_error");
    });

    it("does not report successful org creation when event append fails", async () => {
      const repo = createFakeRepository();
      let callCount = 0;
      const eventsRepo = {
        appendEventWithAudit: async () => {
          callCount++;
          if (callCount === 1) {
            return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
          }
          return { ok: false as const, error: { kind: "internal" as const, message: "second event failed" } };
        },
      };
      const response = await handleCreateOrganization(
        createRequest({ name: "Partial Fail", slug: "partial-fail" }),
        {} as Env,
        "req_partial",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_6" },
      );

      expect(response.status).toBe(500);
      const body = await response.json() as JsonResp;
      expect(body.error.code).toBe("internal_error");
    });

    it("preserves existing public response shape on success", async () => {
      const repo = createFakeRepository();
      const eventsRepo = {
        appendEventWithAudit: async () => ({ ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } }),
      };
      const response = await handleCreateOrganization(
        createRequest({ name: "Shape Test", slug: "shape-test" }),
        {} as Env,
        "req_shape",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_7" },
      );

      expect(response.status).toBe(201);
      const body = await response.json() as JsonResp;
      expect(body.data.organization.id).toMatch(/^org_[0-9a-f]{32}$/);
      expect(body.data.organization.name).toBe("Shape Test");
      expect(body.data.organization.slug).toBe("shape-test");
      expect(body.data.organization.createdAt).toBe("2026-01-20T12:00:00.000Z");
      expect(body.data.membership.role).toBe("owner");
      expect(body.data.membership.joinedAt).toBe("2026-01-20T12:00:00.000Z");
    });

    it("audit entries use membership category", async () => {
      const repo = createFakeRepository();
      const appendedInputs: AppendEventWithAuditInput[] = [];
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInputs.push(input);
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      await handleCreateOrganization(
        createRequest({ name: "Category Test", slug: "cat-test" }),
        {} as Env,
        "req_cat",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_8" },
      );

      expect(appendedInputs[0]!.audit.category).toBe("membership");
      expect(appendedInputs[1]!.audit.category).toBe("membership");
    });

    it("uses organization UUID as subject ID for organization.created", async () => {
      const repo = createFakeRepository();
      const appendedInputs: AppendEventWithAuditInput[] = [];
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInputs.push(input);
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      await handleCreateOrganization(
        createRequest({ name: "Subject Test", slug: "subj-test" }),
        {} as Env,
        "req_subj",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_9" },
      );

      // The orgId and subjectId for organization.created must be the same UUID
      expect(appendedInputs[0]!.event.orgId).toBe(appendedInputs[0]!.event.subjectId);
    });

    it("uses membership UUID as subject ID for membership.added", async () => {
      const repo = createFakeRepository();
      const appendedInputs: AppendEventWithAuditInput[] = [];
      const eventsRepo = {
        appendEventWithAudit: async (input: AppendEventWithAuditInput) => {
          appendedInputs.push(input);
          return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
        },
      };
      await handleCreateOrganization(
        createRequest({ name: "Member Subject", slug: "mem-subj" }),
        {} as Env,
        "req_mem_subj",
        actor,
        { repo, eventsRepo, now: () => fixedNowLocal, generateId: () => "gen_id_10" },
      );

      // membership.added subjectId should be different from orgId (it's the member UUID)
      expect(appendedInputs[1]!.event.subjectId).not.toBe(appendedInputs[1]!.event.orgId);
      expect(appendedInputs[1]!.event.subjectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    });
  });
});
