import type { SqlExecutor } from "../d1/executor.js";
import type {
  AcceptInvitationInput,
  BootstrapOrganizationInput,
  CreateInvitationInput,
  CreateOrganizationInput,
  CreateOrganizationMemberInput,
  CreateRoleAssignmentInput,
  CursorPosition,
  MembershipRepository,
  MembershipResult,
  Organization,
  OrganizationInvitation,
  OrganizationMember,
  PagedResult,
  PageQueryParams,
  RoleAssignment,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";

function mapOrganization(row: Record<string, unknown>): Organization {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    slugLower: row.slug_lower as string,
    status: row.status as string,
    parentOrgId: (row.parent_org_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapMember(row: Record<string, unknown>): OrganizationMember {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    subjectId: row.subject_id as string,
    subjectType: row.subject_type as string,
    status: row.status as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapInvitation(row: Record<string, unknown>): OrganizationInvitation {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    email: row.email as string,
    emailLower: row.email_lower as string,
    role: row.role as string,
    status: row.status as string,
    invitedBy: row.invited_by as string,
    expiresAt: new Date(row.expires_at as string),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at as string) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

function mapRoleAssignment(row: Record<string, unknown>): RoleAssignment {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    subjectId: row.subject_id as string,
    subjectType: row.subject_type as string,
    role: row.role as string,
    scopeKind: row.scope_kind as string,
    scopeRef: (row.scope_ref as string) ?? null,
    createdAt: new Date(row.created_at as string),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
  };
}

function parseJsonColumn(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function safeError(message: string, cause?: unknown): MembershipResult<never> {
  // Surface the underlying DB error so failures are diagnosable in `wrangler
  // tail` instead of silently collapsing into an opaque internal error. Only
  // the error's name/message/code are logged — never query parameters — so no
  // ids, tokens, or secret material leak into logs.
  if (cause !== undefined) {
    const e = cause as { name?: unknown; message?: unknown; code?: unknown };
    console.error(`[membership-repo] ${message}`, {
      name: typeof e?.name === "string" ? e.name : undefined,
      message: typeof e?.message === "string" ? e.message : undefined,
      code: typeof e?.code === "string" ? e.code : undefined,
    });
  }
  return { ok: false, error: { kind: "internal", message } };
}


export function createMembershipRepository(executor: SqlExecutor): MembershipRepository {
  return {
    async createOrganization(input: CreateOrganizationInput): Promise<MembershipResult<Organization>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership_organizations (id, name, slug, slug_lower, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.name, input.slug, input.slugLower, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "organization" } };
        }
        return { ok: true, value: mapOrganization(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "organization" } };
        }
        return safeError("Failed to create organization", err);
      }
    },

    async getOrganizationById(id: string): Promise<MembershipResult<Organization>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership_organizations WHERE id = $1`,
          [id],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapOrganization(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to get organization", err);
      }
    },

    async getOrganizationBySlug(slugLower: string): Promise<MembershipResult<Organization>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership_organizations WHERE slug_lower = $1`,
          [slugLower],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapOrganization(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to get organization by slug", err);
      }
    },

    async listChildOrganizations(parentOrgId: string): Promise<MembershipResult<Organization[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership_organizations WHERE parent_org_id = $1 ORDER BY created_at ASC`,
          [parentOrgId],
        );
        return { ok: true, value: result.rows.map(mapOrganization) };
      } catch (err) {
        return safeError("Failed to list child organizations", err);
      }
    },

    async setOrganizationStatus(orgId: string, status: string, updatedAt: Date): Promise<MembershipResult<Organization>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership_organizations SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
          [orgId, status, updatedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapOrganization(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to set organization status", err);
      }
    },

    async listOrganizationsForSubject(subjectId: string): Promise<MembershipResult<Organization[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT o.* FROM membership_organizations o
           INNER JOIN membership_organization_members m ON m.org_id = o.id
           WHERE m.subject_id = $1 AND m.status = 'active'`,
          [subjectId],
        );
        return { ok: true, value: result.rows.map(mapOrganization) };
      } catch (err) {
        return safeError("Failed to list organizations for subject", err);
      }
    },

    async listOrganizationsForSubjectPaged(subjectId: string, params: PageQueryParams): Promise<MembershipResult<PagedResult<Organization>>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];
        if (params.cursor) {
          sql = `SELECT o.* FROM membership_organizations o
           INNER JOIN membership_organization_members m ON m.org_id = o.id
           WHERE m.subject_id = $1 AND m.status = 'active'
             AND (o.created_at, o.id) < ($3, $4)
           ORDER BY o.created_at DESC, o.id DESC
           LIMIT $2`;
          values = [subjectId, fetchLimit, params.cursor.createdAt, params.cursor.id];
        } else {
          sql = `SELECT o.* FROM membership_organizations o
           INNER JOIN membership_organization_members m ON m.org_id = o.id
           WHERE m.subject_id = $1 AND m.status = 'active'
           ORDER BY o.created_at DESC, o.id DESC
           LIMIT $2`;
          values = [subjectId, fetchLimit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapOrganization);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch (err) {
        return safeError("Failed to list organizations for subject", err);
      }
    },

    async bootstrapOrganization(input: BootstrapOrganizationInput): Promise<MembershipResult<{ org: Organization; member: OrganizationMember; roleAssignment: RoleAssignment }>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `WITH new_org AS (
            INSERT INTO membership_organizations (id, name, slug, slug_lower, parent_org_id, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $19, $5, $5)
            ON CONFLICT (id) DO NOTHING
            RETURNING *
          ),
          new_member AS (
            INSERT INTO membership_organization_members (id, org_id, subject_id, subject_type, created_at, updated_at)
            SELECT $6, $7, $8, $9, $10, $10
            FROM new_org
            ON CONFLICT (id) DO NOTHING
            RETURNING *
          ),
          new_role AS (
            INSERT INTO membership_role_assignments (id, org_id, subject_id, subject_type, role, scope_kind, scope_ref, created_at)
            SELECT $11, $12, $13, $14, $15, $16, $17, $18
            FROM new_member
            ON CONFLICT (id) DO NOTHING
            RETURNING *
          )
          SELECT
            row_to_json(o.*) as org,
            row_to_json(m.*) as member,
            row_to_json(r.*) as role_assignment
          FROM new_org o
          CROSS JOIN new_member m
          CROSS JOIN new_role r`,
          [
            input.org.id, input.org.name, input.org.slug, input.org.slugLower, input.org.createdAt.toISOString(),
            input.member.id, input.member.orgId, input.member.subjectId, input.member.subjectType, input.member.createdAt.toISOString(),
            input.roleAssignment.id, input.roleAssignment.orgId, input.roleAssignment.subjectId, input.roleAssignment.subjectType, input.roleAssignment.role, input.roleAssignment.scopeKind, input.roleAssignment.scopeRef ?? null, input.roleAssignment.createdAt.toISOString(),
            input.org.parentOrgId ?? null,
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "organization" } };
        }
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            org: mapOrganization(parseJsonColumn(row.org)),
            member: mapMember(parseJsonColumn(row.member)),
            roleAssignment: mapRoleAssignment(parseJsonColumn(row.role_assignment)),
          },
        };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "organization" } };
        }
        return safeError("Failed to bootstrap organization", err);
      }
    },

    async createMember(input: CreateOrganizationMemberInput): Promise<MembershipResult<OrganizationMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership_organization_members (id, org_id, subject_id, subject_type, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.orgId, input.subjectId, input.subjectType, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "organization_member" } };
        }
        return { ok: true, value: mapMember(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "organization_member" } };
        }
        return safeError("Failed to create member", err);
      }
    },

    async getMemberById(orgId: string, memberId: string): Promise<MembershipResult<OrganizationMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership_organization_members WHERE org_id = $1 AND id = $2`,
          [orgId, memberId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const member = mapMember(result.rows[0]!);
        if (member.status === "removed") {
          return { ok: false, error: { kind: "removed" } };
        }
        return { ok: true, value: member };
      } catch (err) {
        return safeError("Failed to get member", err);
      }
    },

    async listMembers(orgId: string): Promise<MembershipResult<OrganizationMember[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership_organization_members WHERE org_id = $1 AND status = 'active'`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapMember) };
      } catch (err) {
        return safeError("Failed to list members", err);
      }
    },

    async listMembersPaged(orgId: string, params: PageQueryParams): Promise<MembershipResult<PagedResult<OrganizationMember>>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];
        if (params.cursor) {
          sql = `SELECT * FROM membership_organization_members
           WHERE org_id = $1 AND status = 'active'
             AND (created_at, id) < ($3, $4)
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit, params.cursor.createdAt, params.cursor.id];
        } else {
          sql = `SELECT * FROM membership_organization_members
           WHERE org_id = $1 AND status = 'active'
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapMember);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch (err) {
        return safeError("Failed to list members", err);
      }
    },

    async removeMember(orgId: string, memberId: string, updatedAt: Date): Promise<MembershipResult<OrganizationMember>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership_organization_members
           SET status = 'removed', updated_at = $3
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING *`,
          [orgId, memberId, updatedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapMember(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to remove member", err);
      }
    },

    async createInvitation(input: CreateInvitationInput): Promise<MembershipResult<OrganizationInvitation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership_organization_invitations (id, org_id, email, email_lower, role, token_hash, invited_by, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING
           RETURNING id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at`,
          [input.id, input.orgId, input.email, input.emailLower, input.role, input.tokenHash, input.invitedBy, input.expiresAt.toISOString(), input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "invitation" } };
        }
        return { ok: true, value: mapInvitation(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "invitation" } };
        }
        return safeError("Failed to create invitation", err);
      }
    },

    async getInvitationById(orgId: string, invitationId: string): Promise<MembershipResult<OrganizationInvitation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership_organization_invitations WHERE org_id = $1 AND id = $2`,
          [orgId, invitationId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const inv = mapInvitation(result.rows[0]!);
        if (inv.revokedAt !== null) {
          return { ok: false, error: { kind: "revoked" } };
        }
        if (inv.acceptedAt !== null) {
          return { ok: false, error: { kind: "already_accepted" } };
        }
        if (inv.expiresAt < new Date()) {
          return { ok: false, error: { kind: "expired" } };
        }
        return { ok: true, value: inv };
      } catch (err) {
        return safeError("Failed to get invitation", err);
      }
    },

    async getInvitationByTokenHash(tokenHash: string): Promise<MembershipResult<OrganizationInvitation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership_organization_invitations WHERE token_hash = $1`,
          [tokenHash],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const inv = mapInvitation(result.rows[0]!);
        if (inv.revokedAt !== null) {
          return { ok: false, error: { kind: "revoked" } };
        }
        if (inv.acceptedAt !== null) {
          return { ok: false, error: { kind: "already_accepted" } };
        }
        if (inv.expiresAt < new Date()) {
          return { ok: false, error: { kind: "expired" } };
        }
        return { ok: true, value: inv };
      } catch (err) {
        return safeError("Failed to get invitation by token", err);
      }
    },

    async listInvitations(orgId: string): Promise<MembershipResult<OrganizationInvitation[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership_organization_invitations WHERE org_id = $1`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapInvitation) };
      } catch (err) {
        return safeError("Failed to list invitations", err);
      }
    },

    async listInvitationsPaged(orgId: string, params: PageQueryParams): Promise<MembershipResult<PagedResult<OrganizationInvitation>>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];
        if (params.cursor) {
          sql = `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership_organization_invitations
           WHERE org_id = $1
             AND (created_at, id) < ($3, $4)
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit, params.cursor.createdAt, params.cursor.id];
        } else {
          sql = `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership_organization_invitations
           WHERE org_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapInvitation);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch (err) {
        return safeError("Failed to list invitations", err);
      }
    },

    async revokeInvitation(orgId: string, invitationId: string, revokedAt: Date): Promise<MembershipResult<OrganizationInvitation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership_organization_invitations
           SET status = 'revoked', revoked_at = $3
           WHERE org_id = $1 AND id = $2 AND status = 'pending' AND revoked_at IS NULL AND accepted_at IS NULL
           RETURNING id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at`,
          [orgId, invitationId, revokedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapInvitation(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to revoke invitation", err);
      }
    },

    async acceptInvitation(input: AcceptInvitationInput): Promise<MembershipResult<{ invitation: OrganizationInvitation; member: OrganizationMember; roleAssignment: RoleAssignment }>> {
      try {
        const checkResult = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
           FROM membership_organization_invitations WHERE token_hash = $1`,
          [input.tokenHash],
        );
        if (checkResult.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const inv = mapInvitation(checkResult.rows[0]!);
        if (inv.orgId !== input.orgId) {
          return { ok: false, error: { kind: "not_found" } };
        }
        if (inv.emailLower !== input.emailLower) {
          return { ok: false, error: { kind: "not_found" } };
        }
        if (inv.revokedAt !== null) {
          return { ok: false, error: { kind: "revoked" } };
        }
        if (inv.acceptedAt !== null) {
          return { ok: false, error: { kind: "already_accepted" } };
        }
        if (inv.expiresAt < input.acceptedAt) {
          return { ok: false, error: { kind: "expired" } };
        }

        const result = await executor.execute<Record<string, unknown>>(
          `WITH accepted_inv AS (
            UPDATE membership_organization_invitations
            SET status = 'accepted', accepted_at = $2
            WHERE token_hash = $1 AND org_id = $3 AND email_lower = $4 AND status = 'pending' AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > $2
            RETURNING id, org_id, email, email_lower, role, status, invited_by, expires_at, accepted_at, revoked_at, created_at
          ),
          new_member AS (
            INSERT INTO membership_organization_members (id, org_id, subject_id, subject_type, created_at, updated_at)
            SELECT $5, org_id, $6, $7, $8, $8
            FROM accepted_inv
            RETURNING *
          ),
          new_role AS (
            INSERT INTO membership_role_assignments (id, org_id, subject_id, subject_type, role, scope_kind, scope_ref, created_at)
            SELECT $9, org_id, $10, $11, role, 'organization', NULL, $12
            FROM accepted_inv
            RETURNING *
          )
          SELECT
            row_to_json(ai.*) as invitation,
            row_to_json(nm.*) as member,
            row_to_json(nr.*) as role_assignment
          FROM accepted_inv ai
          CROSS JOIN new_member nm
          CROSS JOIN new_role nr`,
          [
            input.tokenHash, input.acceptedAt.toISOString(),
            input.orgId, input.emailLower,
            input.memberId, input.subjectId, input.subjectType, input.acceptedAt.toISOString(),
            input.roleAssignmentId, input.subjectId, input.subjectType, input.acceptedAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            invitation: mapInvitation(parseJsonColumn(row.invitation)),
            member: mapMember(parseJsonColumn(row.member)),
            roleAssignment: mapRoleAssignment(parseJsonColumn(row.role_assignment)),
          },
        };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "organization_member" } };
        }
        return safeError("Failed to accept invitation", err);
      }
    },

    async createRoleAssignment(input: CreateRoleAssignmentInput): Promise<MembershipResult<RoleAssignment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO membership_role_assignments (id, org_id, subject_id, subject_type, role, scope_kind, scope_ref, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.orgId, input.subjectId, input.subjectType, input.role, input.scopeKind, input.scopeRef ?? null, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "role_assignment" } };
        }
        return { ok: true, value: mapRoleAssignment(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "role_assignment" } };
        }
        return safeError("Failed to create role assignment", err);
      }
    },

    async listRoleAssignments(orgId: string, subjectId: string): Promise<MembershipResult<RoleAssignment[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership_role_assignments WHERE org_id = $1 AND subject_id = $2 AND revoked_at IS NULL`,
          [orgId, subjectId],
        );
        return { ok: true, value: result.rows.map(mapRoleAssignment) };
      } catch (err) {
        return safeError("Failed to list role assignments", err);
      }
    },

    async listRoleAssignmentsForSubjects(
      orgId: string,
      subjectIds: string[],
    ): Promise<MembershipResult<Map<string, RoleAssignment[]>>> {
      const map = new Map<string, RoleAssignment[]>();
      if (subjectIds.length === 0) return { ok: true, value: map };
      try {
        // PERF3 (task 0132): one batched query instead of N per-member queries.
        // NOTE: use a parameterized IN (...) list of scalar text params rather
        // than `= ANY($2)` with a JS array. The pg driver runs with
        // `fetch_types: false` (executor.ts), which leaves array parameters
        // without a resolvable element-type OID and makes `ANY($array)` throw
        // at bind time — that surfaced as a hard 500 on the members list. A
        // scalar IN list avoids array serialization entirely.
        const placeholders = subjectIds.map((_, i) => `$${i + 2}`).join(", ");
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM membership_role_assignments
           WHERE org_id = $1 AND subject_id IN (${placeholders}) AND revoked_at IS NULL`,
          [orgId, ...subjectIds],
        );
        for (const id of subjectIds) map.set(id, []);
        for (const row of result.rows) {
          const ra = mapRoleAssignment(row);
          const bucket = map.get(ra.subjectId);
          if (bucket) bucket.push(ra);
          else map.set(ra.subjectId, [ra]);
        }
        return { ok: true, value: map };
      } catch (err) {
        return safeError("Failed to list role assignments for subjects", err);
      }
    },

    async revokeRoleAssignment(orgId: string, assignmentId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership_role_assignments
           SET revoked_at = $3
           WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL
           RETURNING *`,
          [orgId, assignmentId, revokedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapRoleAssignment(result.rows[0]!) };
      } catch (err) {
        return safeError("Failed to revoke role assignment", err);
      }
    },

    async revokeAllRoleAssignments(orgId: string, subjectId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE membership_role_assignments
           SET revoked_at = $3
           WHERE org_id = $1 AND subject_id = $2 AND revoked_at IS NULL
           RETURNING *`,
          [orgId, subjectId, revokedAt.toISOString()],
        );
        return { ok: true, value: result.rows.map(mapRoleAssignment) };
      } catch (err) {
        return safeError("Failed to revoke all role assignments", err);
      }
    },

    async countActiveOwners(orgId: string): Promise<MembershipResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT COUNT(*) AS cnt
           FROM membership_role_assignments ra
           INNER JOIN membership_organization_members m
             ON m.org_id = ra.org_id AND m.subject_id = ra.subject_id
           WHERE ra.org_id = $1
             AND ra.role = 'owner'
             AND ra.scope_kind = 'organization'
             AND ra.revoked_at IS NULL
             AND m.status = 'active'`,
          [orgId],
        );
        const cnt = Number(result.rows[0]?.cnt ?? 0);
        return { ok: true, value: cnt };
      } catch (err) {
        return safeError("Failed to count active owners", err);
      }
    },

    async countBillableMembers(orgId: string, now: Date): Promise<MembershipResult<number>> {
      // A "billable" seat is anything that grows the active membership of an
      // organization. We count:
      //   1) active organization members; plus
      //   2) pending invitations (not accepted, not revoked, not expired).
      // The two populations are disjoint by construction: an invitation that
      // has been accepted is no longer 'pending' and instead surfaces as an
      // active organization_members row, which the first sub-count picks up.
      // Both sub-counts are evaluated in a single round-trip to keep this
      // helper cheap enough to call on the create-invitation hot path.
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT
             (SELECT COUNT(*) FROM membership_organization_members
                WHERE org_id = $1 AND status = 'active')
             +
             (SELECT COUNT(*) FROM membership_organization_invitations
                WHERE org_id = $1
                  AND status = 'pending'
                  AND revoked_at IS NULL
                  AND accepted_at IS NULL
                  AND expires_at > $2)
             AS cnt`,
          [orgId, now.toISOString()],
        );
        const cnt = Number(result.rows[0]?.cnt ?? 0);
        return { ok: true, value: cnt };
      } catch (err) {
        return safeError("Failed to count billable members", err);
      }
    },
  };
}
