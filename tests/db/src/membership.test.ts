import {
  createMembershipRepository,
} from "@saas/db/membership";
import { asUuid } from "@saas/db";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

const ORG1 = asUuid("00000000-0000-0000-0000-000000000001");
const ORG2 = asUuid("00000000-0000-0000-0000-000000000002");
const ORG999 = asUuid("00000000-0000-0000-0000-000000000099");
const ORG_EMPTY = asUuid("00000000-0000-0000-0000-0000000000ee");

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
  rowCount?: number;
  callResponses?: Array<{ rows?: Record<string, unknown>[]; rowCount?: number; error?: unknown }>;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  let callIndex = 0;
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });

      if (options?.callResponses && callIndex < options.callResponses.length) {
        const response = options.callResponses[callIndex]!;
        callIndex++;
        if (response.error) {
          throw response.error;
        }
        const rows = (response.rows ?? []) as unknown as T[];
        return { rows, rowCount: response.rowCount ?? rows.length };
      }

      if (options?.error) {
        throw options.error;
      }
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: options?.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-01-15T10:00:00Z");
const FUTURE = new Date("2099-01-15T11:00:00Z");
const PAST = new Date("2020-01-15T09:00:00Z");

const SAMPLE_ORG_ROW = {
  id: ORG1,
  name: "Acme Corp",
  slug: "acme-corp",
  slug_lower: "acme-corp",
  status: "active",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_MEMBER_ROW = {
  id: "mem-001",
  org_id: ORG1,
  subject_id: "usr-001",
  subject_type: "user",
  status: "active",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_INVITATION_ROW = {
  id: "inv-001",
  org_id: ORG1,
  email: "Invite@Example.com",
  email_lower: "invite@example.com",
  role: "builder",
  status: "pending",
  invited_by: "usr-001",
  expires_at: FUTURE.toISOString(),
  accepted_at: null,
  revoked_at: null,
  created_at: NOW.toISOString(),
};

const SAMPLE_ROLE_ASSIGNMENT_ROW = {
  id: "ra-001",
  org_id: ORG1,
  subject_id: "usr-001",
  subject_type: "user",
  role: "owner",
  scope_kind: "organization",
  scope_ref: null,
  created_at: NOW.toISOString(),
  revoked_at: null,
};

describe("MembershipRepository", () => {
  describe("createOrganization", () => {
    it("uses parameterized query for organization creation", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ORG_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.createOrganization({
        id: ORG1,
        name: "Acme Corp",
        slug: "acme-corp",
        slugLower: "acme-corp",
        createdAt: NOW,
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$2");
      expect(queries[0]!.text).toContain("$3");
      expect(queries[0]!.text).toContain("$4");
      expect(queries[0]!.params).toEqual([
        ORG1,
        "Acme Corp",
        "acme-corp",
        "acme-corp",
        NOW.toISOString(),
      ]);
    });

    it("maps returned row to Organization type", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_ORG_ROW] });
      const repo = createMembershipRepository(executor);

      const result = await repo.createOrganization({
        id: ORG1,
        name: "Acme Corp",
        slug: "acme-corp",
        slugLower: "acme-corp",
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(ORG1);
        expect(result.value.name).toBe("Acme Corp");
        expect(result.value.slugLower).toBe("acme-corp");
        expect(result.value.status).toBe("active");
        expect(result.value.createdAt).toEqual(NOW);
      }
    });

    it("returns conflict on duplicate organization", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createMembershipRepository(executor);

      const result = await repo.createOrganization({
        id: ORG1,
        name: "Acme Corp",
        slug: "acme-corp",
        slugLower: "acme-corp",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });

    it("returns conflict on unique violation error code", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.createOrganization({
        id: ORG2,
        name: "Acme Corp",
        slug: "acme-corp",
        slugLower: "acme-corp",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });

    it("maps generic errors to safe internal error (and logs the cause for diagnosis)", async () => {
      const { executor } = createFakeExecutor({
        error: Object.assign(new Error("connection to host 10.0.0.1:5432 refused"), { code: "ECONNREFUSED" }),
      });
      const repo = createMembershipRepository(executor);
      const originalError = console.error;
      const logged: unknown[][] = [];
      console.error = (...args: unknown[]) => { logged.push(args); };

      let result;
      try {
        result = await repo.createOrganization({
          id: ORG1,
          name: "Test",
          slug: "test",
          slugLower: "test",
          createdAt: NOW,
        });
      } finally {
        console.error = originalError;
      }

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
        // The user-facing error message must stay opaque (no host/port leak).
        expect((result.error as { kind: "internal"; message: string }).message).not.toContain("10.0.0.1");
        expect((result.error as { kind: "internal"; message: string }).message).not.toContain("5432");
      }
      // ...but the underlying cause is logged for ops diagnosis (name/message/code only).
      const hit = logged.find(
        (a) => typeof a[0] === "string" && a[0].includes("[membership-repo]") && (a[1] as { code?: string })?.code === "ECONNREFUSED",
      );
      expect(hit).toBeDefined();
    });
  });

  describe("getOrganizationById", () => {
    it("uses parameterized query for lookup", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ORG_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.getOrganizationById(ORG1);

      expect(queries[0]!.params).toEqual([ORG1]);
      expect(queries[0]!.text).toContain("$1");
    });

    it("returns not_found when no rows", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.getOrganizationById("org-missing");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("getOrganizationBySlug", () => {
    it("uses normalized slug in parameterized query", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ORG_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.getOrganizationBySlug("acme-corp");

      expect(queries[0]!.params).toEqual(["acme-corp"]);
      expect(queries[0]!.text).toContain("slug_lower");
    });

    it("returns not_found for unknown slug", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.getOrganizationBySlug("unknown-slug");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("listOrganizationsForSubject", () => {
    it("uses parameterized query with subject_id", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ORG_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.listOrganizationsForSubject("usr-001");

      expect(queries[0]!.params).toEqual(["usr-001"]);
      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("subject_id");
    });

    it("returns empty array when no organizations found", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.listOrganizationsForSubject("usr-missing");

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    });
  });

  describe("bootstrapOrganization", () => {
    it("creates org, member, and role assignment atomically in a single CTE statement", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{
          org: SAMPLE_ORG_ROW,
          member: SAMPLE_MEMBER_ROW,
          role_assignment: SAMPLE_ROLE_ASSIGNMENT_ROW,
        }],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.bootstrapOrganization({
        org: { id: ORG1, name: "Acme Corp", slug: "acme-corp", slugLower: "acme-corp", createdAt: NOW },
        member: { id: "mem-001", orgId: ORG1, subjectId: "usr-001", subjectType: "user", createdAt: NOW },
        roleAssignment: { id: "ra-001", orgId: ORG1, subjectId: "usr-001", subjectType: "user", role: "owner", scopeKind: "organization", createdAt: NOW },
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("WITH new_org AS");
      expect(queries[0]!.text).toContain("new_member AS");
      expect(queries[0]!.text).toContain("new_role AS");
      expect(queries[0]!.text).toContain("CROSS JOIN");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.org.id).toBe(ORG1);
        expect(result.value.member.subjectId).toBe("usr-001");
        expect(result.value.roleAssignment.role).toBe("owner");
      }
    });

    it("uses parameterized query with all 18 parameters", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{
          org: SAMPLE_ORG_ROW,
          member: SAMPLE_MEMBER_ROW,
          role_assignment: SAMPLE_ROLE_ASSIGNMENT_ROW,
        }],
      });
      const repo = createMembershipRepository(executor);

      await repo.bootstrapOrganization({
        org: { id: ORG1, name: "Acme Corp", slug: "acme-corp", slugLower: "acme-corp", createdAt: NOW },
        member: { id: "mem-001", orgId: ORG1, subjectId: "usr-001", subjectType: "user", createdAt: NOW },
        roleAssignment: { id: "ra-001", orgId: ORG1, subjectId: "usr-001", subjectType: "user", role: "owner", scopeKind: "organization", createdAt: NOW },
      });

      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$18");
      // $19 = parent_org_id (MO3); standalone bootstrap passes null.
      expect(queries[0]!.text).toContain("parent_org_id");
      expect(queries[0]!.params.length).toBe(19);
      expect(queries[0]!.params[18]).toBeNull();
    });

    it("returns conflict if organization already exists", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createMembershipRepository(executor);

      const result = await repo.bootstrapOrganization({
        org: { id: ORG1, name: "Acme Corp", slug: "acme-corp", slugLower: "acme-corp", createdAt: NOW },
        member: { id: "mem-001", orgId: ORG1, subjectId: "usr-001", subjectType: "user", createdAt: NOW },
        roleAssignment: { id: "ra-001", orgId: ORG1, subjectId: "usr-001", subjectType: "user", role: "owner", scopeKind: "organization", createdAt: NOW },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("conflict");
    });

    it("all-or-nothing: member and role depend on org via CTE chain", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{
          org: SAMPLE_ORG_ROW,
          member: SAMPLE_MEMBER_ROW,
          role_assignment: SAMPLE_ROLE_ASSIGNMENT_ROW,
        }],
      });
      const repo = createMembershipRepository(executor);

      await repo.bootstrapOrganization({
        org: { id: ORG1, name: "Acme Corp", slug: "acme-corp", slugLower: "acme-corp", createdAt: NOW },
        member: { id: "mem-001", orgId: ORG1, subjectId: "usr-001", subjectType: "user", createdAt: NOW },
        roleAssignment: { id: "ra-001", orgId: ORG1, subjectId: "usr-001", subjectType: "user", role: "owner", scopeKind: "organization", createdAt: NOW },
      });

      expect(queries[0]!.text).toContain("FROM new_org");
      expect(queries[0]!.text).toContain("FROM new_member");
    });
  });

  describe("createMember", () => {
    it("uses parameterized query", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_MEMBER_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.createMember({
        id: "mem-001",
        orgId: ORG1,
        subjectId: "usr-001",
        subjectType: "user",
        createdAt: NOW,
      });

      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.params).toEqual([
        "mem-001",
        ORG1,
        "usr-001",
        "user",
        NOW.toISOString(),
      ]);
    });

    it("returns conflict on duplicate member", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.createMember({
        id: "mem-002",
        orgId: ORG1,
        subjectId: "usr-001",
        subjectType: "user",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("conflict");
    });
  });

  describe("getMemberById", () => {
    it("uses parameterized query with org_id and member_id", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_MEMBER_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.getMemberById(ORG1, "mem-001");

      expect(queries[0]!.params).toEqual([ORG1, "mem-001"]);
    });

    it("returns not_found when no rows", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.getMemberById(ORG1, "mem-missing");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });

    it("returns removed for removed member", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_MEMBER_ROW, status: "removed" }],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.getMemberById(ORG1, "mem-001");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("removed");
    });
  });

  describe("listMembers", () => {
    it("uses parameterized query for org_id", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_MEMBER_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.listMembers(ORG1);

      expect(queries[0]!.params).toEqual([ORG1]);
      expect(queries[0]!.text).toContain("status = 'active'");
    });

    it("returns empty array when no members", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.listMembers(ORG_EMPTY);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    });
  });

  describe("removeMember", () => {
    it("uses parameterized update with status = 'active' guard", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{ ...SAMPLE_MEMBER_ROW, status: "removed", updated_at: NOW.toISOString() }],
      });
      const repo = createMembershipRepository(executor);

      await repo.removeMember(ORG1, "mem-001", NOW);

      expect(queries[0]!.text).toContain("status = 'active'");
      expect(queries[0]!.params).toEqual([ORG1, "mem-001", NOW.toISOString()]);
    });

    it("returns not_found when member already removed", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createMembershipRepository(executor);

      const result = await repo.removeMember(ORG1, "mem-001", NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("createInvitation", () => {
    it("stores hashed token via parameterized query", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_INVITATION_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.createInvitation({
        id: "inv-001",
        orgId: ORG1,
        email: "Invite@Example.com",
        emailLower: "invite@example.com",
        role: "builder",
        tokenHash: "sha256-hashed-invite-token",
        invitedBy: "usr-001",
        expiresAt: FUTURE,
        createdAt: NOW,
      });

      expect(queries[0]!.params[5]).toBe("sha256-hashed-invite-token");
      expect(queries[0]!.text).toContain("$6");
    });

    it("does not expose token_hash in returned invitation", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_INVITATION_ROW] });
      const repo = createMembershipRepository(executor);

      const result = await repo.createInvitation({
        id: "inv-001",
        orgId: ORG1,
        email: "Invite@Example.com",
        emailLower: "invite@example.com",
        role: "builder",
        tokenHash: "sha256-hashed-invite-token",
        invitedBy: "usr-001",
        expiresAt: FUTURE,
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toHaveProperty("tokenHash");
        expect(result.value).not.toHaveProperty("token_hash");
      }
    });

    it("returns conflict on duplicate invitation", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.createInvitation({
        id: "inv-002",
        orgId: ORG1,
        email: "test@example.com",
        emailLower: "test@example.com",
        role: "viewer",
        tokenHash: "sha256-another-hash",
        invitedBy: "usr-001",
        expiresAt: FUTURE,
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("conflict");
    });
  });

  describe("getInvitationById", () => {
    it("uses parameterized query with org_id and invitation_id", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_INVITATION_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.getInvitationById(ORG1, "inv-001");

      expect(queries[0]!.params).toEqual([ORG1, "inv-001"]);
    });

    it("returns not_found for missing invitation", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.getInvitationById(ORG1, "inv-missing");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });

    it("returns revoked for revoked invitation", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_INVITATION_ROW, revoked_at: NOW.toISOString(), status: "revoked" }],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.getInvitationById(ORG1, "inv-001");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("revoked");
    });

    it("returns already_accepted for accepted invitation", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_INVITATION_ROW, accepted_at: NOW.toISOString(), status: "accepted" }],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.getInvitationById(ORG1, "inv-001");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("already_accepted");
    });

    it("returns expired for expired invitation", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_INVITATION_ROW, expires_at: PAST.toISOString() }],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.getInvitationById(ORG1, "inv-001");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("expired");
    });

    it("does not expose token_hash in returned invitation", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_INVITATION_ROW] });
      const repo = createMembershipRepository(executor);

      const result = await repo.getInvitationById(ORG1, "inv-001");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toHaveProperty("tokenHash");
        expect(result.value).not.toHaveProperty("token_hash");
      }
    });
  });

  describe("getInvitationByTokenHash", () => {
    it("uses parameterized query with token hash", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_INVITATION_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.getInvitationByTokenHash("sha256-hashed-token");

      expect(queries[0]!.params).toEqual(["sha256-hashed-token"]);
      expect(queries[0]!.text).toContain("token_hash = $1");
    });

    it("returns not_found for unknown token hash", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.getInvitationByTokenHash("unknown-hash");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });

    it("returns revoked for revoked invitation", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_INVITATION_ROW, revoked_at: NOW.toISOString(), status: "revoked" }],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.getInvitationByTokenHash("sha256-hashed-token");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("revoked");
    });

    it("returns already_accepted for accepted invitation", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_INVITATION_ROW, accepted_at: NOW.toISOString(), status: "accepted" }],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.getInvitationByTokenHash("sha256-hashed-token");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("already_accepted");
    });

    it("returns expired for expired invitation", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_INVITATION_ROW, expires_at: PAST.toISOString() }],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.getInvitationByTokenHash("sha256-hashed-token");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("expired");
    });
  });

  describe("listInvitations", () => {
    it("uses parameterized query for org_id", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_INVITATION_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.listInvitations(ORG1);

      expect(queries[0]!.params).toEqual([ORG1]);
    });

    it("returns empty array when no invitations", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.listInvitations(ORG_EMPTY);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    });
  });

  describe("revokeInvitation", () => {
    it("uses parameterized update with pending/null guards", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{ ...SAMPLE_INVITATION_ROW, revoked_at: NOW.toISOString(), status: "revoked" }],
      });
      const repo = createMembershipRepository(executor);

      await repo.revokeInvitation(ORG1, "inv-001", NOW);

      expect(queries[0]!.text).toContain("status = 'pending'");
      expect(queries[0]!.text).toContain("revoked_at IS NULL");
      expect(queries[0]!.params).toEqual([ORG1, "inv-001", NOW.toISOString()]);
    });

    it("returns not_found when invitation already revoked or accepted", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createMembershipRepository(executor);

      const result = await repo.revokeInvitation(ORG1, "inv-001", NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("acceptInvitation", () => {
    it("validates invitation state and creates member + role assignment atomically", async () => {
      const { executor, queries } = createFakeExecutor({
        callResponses: [
          { rows: [SAMPLE_INVITATION_ROW], rowCount: 1 },
          { rows: [{ invitation: { ...SAMPLE_INVITATION_ROW, accepted_at: NOW.toISOString(), status: "accepted" }, member: SAMPLE_MEMBER_ROW, role_assignment: SAMPLE_ROLE_ASSIGNMENT_ROW }], rowCount: 1 },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG1,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(queries).toHaveLength(2);
      expect(queries[0]!.text).toContain("token_hash = $1");
      expect(queries[1]!.text).toContain("WITH accepted_inv AS");
      expect(queries[1]!.text).toContain("org_id = $3");
      expect(queries[1]!.text).toContain("email_lower = $4");
      expect(queries[1]!.text).toContain("expires_at > $2");
      expect(queries[1]!.text).toContain("new_role AS");
      expect(queries[1]!.text).toContain("scope_kind");
      expect(queries[1]!.text).toContain("CROSS JOIN");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.invitation.status).toBe("accepted");
        expect(result.value.member.subjectId).toBe("usr-001");
        expect(result.value.roleAssignment.role).toBe("owner");
        expect(result.value.roleAssignment.scopeKind).toBe("organization");
      }
    });

    it("returns not_found when invitation not found by token hash", async () => {
      const { executor } = createFakeExecutor({
        callResponses: [
          { rows: [], rowCount: 0 },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-unknown-token",
        orgId: ORG1,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });

    it("returns not_found when invitation belongs to a different organization", async () => {
      const { executor, queries } = createFakeExecutor({
        callResponses: [
          { rows: [SAMPLE_INVITATION_ROW], rowCount: 1 },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG999,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
      expect(queries).toHaveLength(1);
    });

    it("returns not_found when email does not match", async () => {
      const { executor, queries } = createFakeExecutor({
        callResponses: [
          { rows: [SAMPLE_INVITATION_ROW], rowCount: 1 },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG1,
        emailLower: "wrong@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
      expect(queries).toHaveLength(1);
    });

    it("returns expired when invitation past expiry without marking it accepted", async () => {
      const { executor, queries } = createFakeExecutor({
        callResponses: [
          { rows: [{ ...SAMPLE_INVITATION_ROW, expires_at: PAST.toISOString() }], rowCount: 1 },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG1,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("expired");
      expect(queries).toHaveLength(1);
    });

    it("returns revoked when invitation is revoked", async () => {
      const { executor, queries } = createFakeExecutor({
        callResponses: [
          { rows: [{ ...SAMPLE_INVITATION_ROW, revoked_at: NOW.toISOString(), status: "revoked" }], rowCount: 1 },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG1,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("revoked");
      expect(queries).toHaveLength(1);
    });

    it("returns already_accepted when invitation was already accepted", async () => {
      const { executor, queries } = createFakeExecutor({
        callResponses: [
          { rows: [{ ...SAMPLE_INVITATION_ROW, accepted_at: NOW.toISOString(), status: "accepted" }], rowCount: 1 },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG1,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("already_accepted");
      expect(queries).toHaveLength(1);
    });

    it("returns conflict when member uniqueness constraint fails", async () => {
      const { executor } = createFakeExecutor({
        callResponses: [
          { rows: [SAMPLE_INVITATION_ROW], rowCount: 1 },
          { error: new Error("D1_ERROR: UNIQUE constraint failed") },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG1,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("conflict");
    });

    it("does not expose token hash in invitation output", async () => {
      const { executor } = createFakeExecutor({
        callResponses: [
          { rows: [SAMPLE_INVITATION_ROW], rowCount: 1 },
          { rows: [{ invitation: { ...SAMPLE_INVITATION_ROW, accepted_at: NOW.toISOString(), status: "accepted" }, member: SAMPLE_MEMBER_ROW, role_assignment: SAMPLE_ROLE_ASSIGNMENT_ROW }], rowCount: 1 },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG1,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.invitation).not.toHaveProperty("tokenHash");
        expect(result.value.invitation).not.toHaveProperty("token_hash");
      }
    });

    it("raw token is never part of repository input parameters", async () => {
      const { executor, queries } = createFakeExecutor({
        callResponses: [
          { rows: [SAMPLE_INVITATION_ROW], rowCount: 1 },
          { rows: [{ invitation: { ...SAMPLE_INVITATION_ROW, accepted_at: NOW.toISOString(), status: "accepted" }, member: SAMPLE_MEMBER_ROW, role_assignment: SAMPLE_ROLE_ASSIGNMENT_ROW }], rowCount: 1 },
        ],
      });
      const repo = createMembershipRepository(executor);

      await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG1,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      const allParams = queries.flatMap((q) => q.params);
      expect(allParams).not.toContain("raw_token_value");
      expect(allParams[0]).toBe("sha256-hashed-token");
    });

    it("returned role assignment is organization-scoped", async () => {
      const { executor } = createFakeExecutor({
        callResponses: [
          { rows: [SAMPLE_INVITATION_ROW], rowCount: 1 },
          { rows: [{ invitation: { ...SAMPLE_INVITATION_ROW, accepted_at: NOW.toISOString(), status: "accepted" }, member: SAMPLE_MEMBER_ROW, role_assignment: { ...SAMPLE_ROLE_ASSIGNMENT_ROW, scope_kind: "organization", scope_ref: null } }], rowCount: 1 },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.acceptInvitation({
        tokenHash: "sha256-hashed-token",
        orgId: ORG1,
        emailLower: "invite@example.com",
        memberId: "mem-002",
        roleAssignmentId: "ra-002",
        subjectId: "usr-002",
        subjectType: "user",
        acceptedAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.roleAssignment.scopeKind).toBe("organization");
        expect(result.value.roleAssignment.scopeRef).toBeNull();
      }
    });
  });

  describe("createRoleAssignment", () => {
    it("uses parameterized query for role assignment creation", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ROLE_ASSIGNMENT_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.createRoleAssignment({
        id: "ra-001",
        orgId: ORG1,
        subjectId: "usr-001",
        subjectType: "user",
        role: "owner",
        scopeKind: "organization",
        createdAt: NOW,
      });

      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.params).toEqual([
        "ra-001",
        ORG1,
        "usr-001",
        "user",
        "owner",
        "organization",
        null,
        NOW.toISOString(),
      ]);
    });

    it("supports project-scoped role assignments", async () => {
      const projectRole = { ...SAMPLE_ROLE_ASSIGNMENT_ROW, role: "project_builder", scope_kind: "project", scope_ref: "prj-001" };
      const { executor, queries } = createFakeExecutor({ rows: [projectRole] });
      const repo = createMembershipRepository(executor);

      await repo.createRoleAssignment({
        id: "ra-002",
        orgId: ORG1,
        subjectId: "usr-001",
        subjectType: "user",
        role: "project_builder",
        scopeKind: "project",
        scopeRef: "prj-001",
        createdAt: NOW,
      });

      expect(queries[0]!.params[6]).toBe("prj-001");
    });

    it("returns conflict on duplicate active role assignment", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.createRoleAssignment({
        id: "ra-003",
        orgId: ORG1,
        subjectId: "usr-001",
        subjectType: "user",
        role: "owner",
        scopeKind: "organization",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("conflict");
    });
  });

  describe("listRoleAssignments", () => {
    it("uses parameterized query with org_id and subject_id", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ROLE_ASSIGNMENT_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.listRoleAssignments(ORG1, "usr-001");

      expect(queries[0]!.params).toEqual([ORG1, "usr-001"]);
      expect(queries[0]!.text).toContain("revoked_at IS NULL");
    });

    it("returns empty array when no assignments", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.listRoleAssignments(ORG1, "usr-missing");

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    });
  });

  describe("listRoleAssignmentsForSubjects", () => {
    it("batches with a scalar IN list (no array param) and groups by subject", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [
          SAMPLE_ROLE_ASSIGNMENT_ROW,
          { ...SAMPLE_ROLE_ASSIGNMENT_ROW, id: "ra-002", subject_id: "usr-002", role: "member" },
        ],
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.listRoleAssignmentsForSubjects!(ORG1, ["usr-001", "usr-002"]);

      // One query, not N. Regression guard: must use scalar IN-list params,
      // never `= ANY($array)` (array params throw under fetch_types:false).
      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("subject_id IN ($2, $3)");
      expect(queries[0]!.text).not.toContain("ANY(");
      expect(queries[0]!.params).toEqual([ORG1, "usr-001", "usr-002"]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.get("usr-001")?.map((ra) => ra.role)).toEqual(["owner"]);
        expect(result.value.get("usr-002")?.map((ra) => ra.role)).toEqual(["member"]);
      }
    });

    it("short-circuits without a query for an empty subject list", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.listRoleAssignmentsForSubjects!(ORG1, []);

      expect(queries).toHaveLength(0);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.size).toBe(0);
    });
  });

  describe("revokeRoleAssignment", () => {
    it("uses parameterized update with revoked_at IS NULL guard", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{ ...SAMPLE_ROLE_ASSIGNMENT_ROW, revoked_at: NOW.toISOString() }],
      });
      const repo = createMembershipRepository(executor);

      await repo.revokeRoleAssignment(ORG1, "ra-001", NOW);

      expect(queries[0]!.text).toContain("revoked_at IS NULL");
      expect(queries[0]!.params).toEqual([ORG1, "ra-001", NOW.toISOString()]);
    });

    it("returns not_found when assignment already revoked", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createMembershipRepository(executor);

      const result = await repo.revokeRoleAssignment(ORG1, "ra-001", NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("safe error handling", () => {
    it("never exposes raw SQL errors in repository outputs", async () => {
      const pgError = new Error(
        'relation "membership_organizations" does not exist at character 15',
      );
      const { executor } = createFakeExecutor({ error: pgError });
      const repo = createMembershipRepository(executor);

      const result = await repo.getOrganizationById(ORG1);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "internal") {
        expect(result.error.message).not.toContain("relation");
        expect(result.error.message).not.toContain("character 15");
      }
    });

    it("never exposes connection strings in errors", async () => {
      const connError = new Error(
        "could not connect to postgres://admin:secret@db.internal:5432/prod",
      );
      const { executor } = createFakeExecutor({ error: connError });
      const repo = createMembershipRepository(executor);

      const result = await repo.createOrganization({
        id: ORG1,
        name: "Test",
        slug: "test",
        slugLower: "test",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "internal") {
        expect(result.error.message).not.toContain("admin");
        expect(result.error.message).not.toContain("secret");
        expect(result.error.message).not.toContain("db.internal");
      }
    });

    it("never exposes invitation token hashes in error outputs", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("duplicate key value (token_hash)=(secret-token-hash-value)"),
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.createInvitation({
        id: "inv-001",
        orgId: ORG1,
        email: "test@example.com",
        emailLower: "test@example.com",
        role: "viewer",
        tokenHash: "secret-token-hash-value",
        invitedBy: "usr-001",
        expiresAt: FUTURE,
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const serialized = JSON.stringify(result.error);
        expect(serialized).not.toContain("secret-token-hash-value");
      }
    });

    it("never exposes emails in internal error messages", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("constraint violation for email user@secret-domain.com"),
      });
      const repo = createMembershipRepository(executor);

      const result = await repo.createInvitation({
        id: "inv-001",
        orgId: ORG1,
        email: "user@secret-domain.com",
        emailLower: "user@secret-domain.com",
        role: "viewer",
        tokenHash: "hash",
        invitedBy: "usr-001",
        expiresAt: FUTURE,
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "internal") {
        expect(result.error.message).not.toContain("user@secret-domain.com");
      }
    });
  });

  describe("listOrganizationsForSubjectPaged", () => {
    it("uses parameterized query with deterministic ordering and limit+1", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ORG_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.listOrganizationsForSubjectPaged("usr-001", { limit: 10, cursor: null });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$2");
      expect(queries[0]!.text).toContain("ORDER BY");
      expect(queries[0]!.text).toContain("LIMIT");
      expect(queries[0]!.params).toEqual(["usr-001", 11]);
    });

    it("applies cursor filtering with timestamp and id tie-breaker", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      await repo.listOrganizationsForSubjectPaged("usr-001", {
        limit: 5,
        cursor: { createdAt: "2026-01-15T10:00:00.000Z", id: ORG1 },
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$3");
      expect(queries[0]!.text).toContain("$4");
      expect(queries[0]!.params).toEqual(["usr-001", 6, "2026-01-15T10:00:00.000Z", ORG1]);
    });

    it("returns nextCursor when more rows exist", async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        ...SAMPLE_ORG_ROW,
        id: `org-${String(i).padStart(3, "0")}`,
        created_at: new Date(NOW.getTime() - i * 1000).toISOString(),
        updated_at: new Date(NOW.getTime() - i * 1000).toISOString(),
      }));
      const { executor } = createFakeExecutor({ rows });
      const repo = createMembershipRepository(executor);

      const result = await repo.listOrganizationsForSubjectPaged("usr-001", { limit: 2, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(2);
        expect(result.value.nextCursor).not.toBeNull();
        expect(result.value.nextCursor!.id).toBe("org-001");
      }
    });

    it("returns null nextCursor when no more rows", async () => {
      const rows = [SAMPLE_ORG_ROW];
      const { executor } = createFakeExecutor({ rows });
      const repo = createMembershipRepository(executor);

      const result = await repo.listOrganizationsForSubjectPaged("usr-001", { limit: 10, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(1);
        expect(result.value.nextCursor).toBeNull();
      }
    });

    it("returns empty result safely", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.listOrganizationsForSubjectPaged("usr-001", { limit: 50, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(0);
        expect(result.value.nextCursor).toBeNull();
      }
    });
  });

  describe("listMembersPaged", () => {
    it("uses parameterized query with deterministic ordering and limit+1", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_MEMBER_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.listMembersPaged(ORG1, { limit: 10, cursor: null });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$2");
      expect(queries[0]!.text).toContain("ORDER BY");
      expect(queries[0]!.text).toContain("LIMIT");
      expect(queries[0]!.params).toEqual([ORG1, 11]);
    });

    it("applies cursor filtering with timestamp and id tie-breaker", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      await repo.listMembersPaged(ORG1, {
        limit: 5,
        cursor: { createdAt: "2026-01-15T10:00:00.000Z", id: "mem-001" },
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$3");
      expect(queries[0]!.text).toContain("$4");
      expect(queries[0]!.params).toEqual([ORG1, 6, "2026-01-15T10:00:00.000Z", "mem-001"]);
    });

    it("returns nextCursor when more rows exist", async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        ...SAMPLE_MEMBER_ROW,
        id: `mem-${String(i).padStart(3, "0")}`,
        created_at: new Date(NOW.getTime() - i * 1000).toISOString(),
        updated_at: new Date(NOW.getTime() - i * 1000).toISOString(),
      }));
      const { executor } = createFakeExecutor({ rows });
      const repo = createMembershipRepository(executor);

      const result = await repo.listMembersPaged(ORG1, { limit: 2, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(2);
        expect(result.value.nextCursor).not.toBeNull();
        expect(result.value.nextCursor!.id).toBe("mem-001");
      }
    });

    it("returns null nextCursor when no more rows", async () => {
      const rows = [SAMPLE_MEMBER_ROW];
      const { executor } = createFakeExecutor({ rows });
      const repo = createMembershipRepository(executor);

      const result = await repo.listMembersPaged(ORG1, { limit: 10, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(1);
        expect(result.value.nextCursor).toBeNull();
      }
    });

    it("returns empty result safely", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.listMembersPaged(ORG1, { limit: 50, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(0);
        expect(result.value.nextCursor).toBeNull();
      }
    });
  });

  describe("Worker-safe import isolation", () => {
    it("does not import runner-only modules", async () => {
      const mod = await import("@saas/db/membership");
      const exportKeys = Object.keys(mod);

      expect(exportKeys).toContain("createMembershipRepository");
      expect(exportKeys).not.toContain("runMigrations");
      expect(exportKeys).not.toContain("D1ApiAdapter");
      expect(exportKeys).not.toContain("loadD1CredentialsFromEnv");
    });
  });

  describe("listInvitationsPaged", () => {
    it("uses parameterized query with deterministic ordering and limit+1", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_INVITATION_ROW] });
      const repo = createMembershipRepository(executor);

      await repo.listInvitationsPaged(ORG1, { limit: 10, cursor: null });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$2");
      expect(queries[0]!.text).toContain("ORDER BY");
      expect(queries[0]!.text).toContain("LIMIT");
      expect(queries[0]!.params).toEqual([ORG1, 11]);
    });

    it("applies cursor filtering with timestamp and id tie-breaker", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      await repo.listInvitationsPaged(ORG1, {
        limit: 5,
        cursor: { createdAt: "2026-01-15T10:00:00.000Z", id: "inv-001" },
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$3");
      expect(queries[0]!.text).toContain("$4");
      expect(queries[0]!.params).toEqual([ORG1, 6, "2026-01-15T10:00:00.000Z", "inv-001"]);
    });

    it("returns nextCursor when more rows exist", async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        ...SAMPLE_INVITATION_ROW,
        id: `inv-${String(i).padStart(3, "0")}`,
        created_at: new Date(NOW.getTime() - i * 1000).toISOString(),
      }));
      const { executor } = createFakeExecutor({ rows });
      const repo = createMembershipRepository(executor);

      const result = await repo.listInvitationsPaged(ORG1, { limit: 2, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(2);
        expect(result.value.nextCursor).not.toBeNull();
        expect(result.value.nextCursor!.id).toBe("inv-001");
      }
    });

    it("returns null nextCursor when no more rows", async () => {
      const rows = [SAMPLE_INVITATION_ROW];
      const { executor } = createFakeExecutor({ rows });
      const repo = createMembershipRepository(executor);

      const result = await repo.listInvitationsPaged(ORG1, { limit: 10, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(1);
        expect(result.value.nextCursor).toBeNull();
      }
    });

    it("returns empty result safely", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.listInvitationsPaged(ORG1, { limit: 50, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(0);
        expect(result.value.nextCursor).toBeNull();
      }
    });

    it("does not expose token_hash in paginated results", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_INVITATION_ROW] });
      const repo = createMembershipRepository(executor);

      const result = await repo.listInvitationsPaged(ORG1, { limit: 10, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items[0]).not.toHaveProperty("tokenHash");
        expect(result.value.items[0]).not.toHaveProperty("token_hash");
      }
    });
  });

  describe("revokeAllRoleAssignments", () => {
    it("uses parameterized SQL with org_id and subject_id", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{ ...SAMPLE_ROLE_ASSIGNMENT_ROW, revoked_at: NOW.toISOString() }],
      });
      const repo = createMembershipRepository(executor);

      await repo.revokeAllRoleAssignments(ORG1, "usr-001", NOW);

      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$2");
      expect(queries[0]!.text).toContain("$3");
      expect(queries[0]!.text).toContain("revoked_at IS NULL");
      expect(queries[0]!.params).toEqual([ORG1, "usr-001", NOW.toISOString()]);
    });

    it("returns all revoked role assignments", async () => {
      const rows = [
        { ...SAMPLE_ROLE_ASSIGNMENT_ROW, id: "ra-001", revoked_at: NOW.toISOString() },
        { ...SAMPLE_ROLE_ASSIGNMENT_ROW, id: "ra-002", role: "admin", revoked_at: NOW.toISOString() },
      ];
      const { executor } = createFakeExecutor({ rows });
      const repo = createMembershipRepository(executor);

      const result = await repo.revokeAllRoleAssignments(ORG1, "usr-001", NOW);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]!.id).toBe("ra-001");
        expect(result.value[1]!.id).toBe("ra-002");
      }
    });

    it("returns empty array when no active assignments exist", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createMembershipRepository(executor);

      const result = await repo.revokeAllRoleAssignments(ORG1, "usr-001", NOW);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    });

    it("maps generic errors to safe internal error", async () => {
      const { executor } = createFakeExecutor({ error: new Error("connection refused") });
      const repo = createMembershipRepository(executor);

      const result = await repo.revokeAllRoleAssignments(ORG1, "usr-001", NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
        expect((result.error as { kind: "internal"; message: string }).message).not.toContain("connection refused");
      }
    });
  });

  describe("countActiveOwners", () => {
    it("uses parameterized SQL joining members and role_assignments", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [{ cnt: "2" }] });
      const repo = createMembershipRepository(executor);

      await repo.countActiveOwners(ORG1);

      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("role = 'owner'");
      expect(queries[0]!.text).toContain("scope_kind = 'organization'");
      expect(queries[0]!.text).toContain("revoked_at IS NULL");
      expect(queries[0]!.text).toContain("status = 'active'");
      expect(queries[0]!.params).toEqual([ORG1]);
    });

    it("returns count of active owners", async () => {
      const { executor } = createFakeExecutor({ rows: [{ cnt: "3" }] });
      const repo = createMembershipRepository(executor);

      const result = await repo.countActiveOwners(ORG1);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(3);
    });

    it("returns 0 when no active owners", async () => {
      const { executor } = createFakeExecutor({ rows: [{ cnt: "0" }] });
      const repo = createMembershipRepository(executor);

      const result = await repo.countActiveOwners(ORG1);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(0);
    });

    it("maps generic errors to safe internal error", async () => {
      const { executor } = createFakeExecutor({ error: new Error("timeout") });
      const repo = createMembershipRepository(executor);

      const result = await repo.countActiveOwners(ORG1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
      }
    });
  });

  describe("countBillableMembers", () => {
    it("uses parameterized SQL summing active members and pending non-expired invitations", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [{ cnt: "5" }] });
      const repo = createMembershipRepository(executor);
      const now = new Date("2026-01-15T10:00:00Z");

      await repo.countBillableMembers(ORG1, now);

      const sql = queries[0]!.text;
      expect(sql).toContain("$1");
      expect(sql).toContain("$2");
      expect(sql).toContain("membership_organization_members");
      expect(sql).toContain("status = 'active'");
      expect(sql).toContain("membership_organization_invitations");
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain("revoked_at IS NULL");
      expect(sql).toContain("accepted_at IS NULL");
      expect(sql).toContain("expires_at > $2");
      expect(queries[0]!.params).toEqual([ORG1, now.toISOString()]);
    });

    it("returns the combined billable count", async () => {
      const { executor } = createFakeExecutor({ rows: [{ cnt: "7" }] });
      const repo = createMembershipRepository(executor);

      const result = await repo.countBillableMembers(ORG1, new Date());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(7);
    });

    it("returns 0 when org has no members or pending invitations", async () => {
      const { executor } = createFakeExecutor({ rows: [{ cnt: "0" }] });
      const repo = createMembershipRepository(executor);

      const result = await repo.countBillableMembers(ORG_EMPTY, new Date());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(0);
    });

    it("maps generic errors to safe internal error", async () => {
      const { executor } = createFakeExecutor({ error: new Error("connection refused") });
      const repo = createMembershipRepository(executor);

      const result = await repo.countBillableMembers(ORG1, new Date());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
        expect((result.error as { kind: "internal"; message: string }).message).not.toContain("connection refused");
      }
    });
  });
});
