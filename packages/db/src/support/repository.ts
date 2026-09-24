import type { SqlExecutor } from "../d1/executor.js";
import type {
  RecordSupportActionInput,
  StoredSupportActionRecord,
  SupportCursorPosition,
  SupportOrganizationProjection,
  SupportPagedResult,
  SupportPageQueryParams,
  SupportRepository,
  SupportResult,
  SupportUserProjection,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function parseJsonColumn(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapSupportActionRecord(row: Record<string, unknown>): StoredSupportActionRecord {
  return {
    id: row.id as string,
    actorId: row.actor_id as string,
    actorType: row.actor_type as string,
    targetOrgId: row.target_org_id as string,
    action: row.action as string,
    reason: row.reason as string,
    requestId: row.request_id as string,
    metadata: parseJsonColumn(row.metadata),
    occurredAt: new Date(row.occurred_at as string),
    createdAt: new Date(row.created_at as string),
  };
}

function mapOrganizationProjection(row: Record<string, unknown>): SupportOrganizationProjection {
  return {
    orgId: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    status: row.status as string,
    memberCount: Number(row.member_count ?? 0),
    createdAt: new Date(row.created_at as string),
  };
}

function mapUserProjection(row: Record<string, unknown>): SupportUserProjection {
  return {
    userId: row.id as string,
    email: row.email as string,
    displayName: (row.display_name as string) ?? null,
    status: row.status as string,
    createdAt: new Date(row.created_at as string),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function safeError(message: string): SupportResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function buildCursorCondition(
  cursor: SupportCursorPosition | null,
  startParam: number,
): { clause: string; params: unknown[] } {
  if (!cursor) return { clause: "", params: [] };
  return {
    clause: ` AND (occurred_at, id) < ($${startParam}, $${startParam + 1})`,
    params: [cursor.occurredAt, cursor.id],
  };
}

function extractNextCursor<T extends { occurredAt: Date; id: string }>(
  items: T[],
  limit: number,
): { trimmed: T[]; nextCursor: SupportCursorPosition | null } {
  if (items.length > limit) {
    const trimmed = items.slice(0, limit);
    const last = trimmed[trimmed.length - 1]!;
    return { trimmed, nextCursor: { occurredAt: last.occurredAt.toISOString(), id: last.id } };
  }
  return { trimmed: items, nextCursor: null };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSupportRepository(executor: SqlExecutor): SupportRepository {
  return {
    async recordSupportAction(
      input: RecordSupportActionInput,
    ): Promise<SupportResult<StoredSupportActionRecord>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO support_support_action_records (
            id, actor_id, actor_type, target_org_id,
            action, reason, request_id, metadata, occurred_at
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8, $9
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING *`,
          [
            input.id,
            input.actorId,
            input.actorType,
            input.targetOrgId,
            input.action,
            input.reason,
            input.requestId,
            JSON.stringify(input.metadata ?? {}),
            input.occurredAt.toISOString(),
          ],
        );
        if (result.rows.length === 0) {
          return { ok: false, error: { kind: "conflict", entity: "support_action" } };
        }
        return { ok: true, value: mapSupportActionRecord(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "support_action" } };
        }
        return safeError("Failed to record support action");
      }
    },

    async listSupportActions(
      targetOrgId: string,
      params: SupportPageQueryParams,
    ): Promise<SupportResult<SupportPagedResult<StoredSupportActionRecord>>> {
      try {
        const { clause, params: cursorParams } = buildCursorCondition(params.cursor, 3);
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM support_support_action_records
           WHERE target_org_id = $1${clause}
           ORDER BY occurred_at DESC, id DESC
           LIMIT $2`,
          [targetOrgId, params.limit + 1, ...cursorParams],
        );
        const mapped = result.rows.map(mapSupportActionRecord);
        const { trimmed, nextCursor } = extractNextCursor(mapped, params.limit);
        return { ok: true, value: { items: trimmed, nextCursor } };
      } catch {
        return safeError("Failed to list support actions");
      }
    },

    async lookupOrganizationForSupport(
      orgId: string,
    ): Promise<SupportResult<SupportOrganizationProjection>> {
      try {
        // Narrow projection only: id/name/slug/status/createdAt + active member
        // count. No secrets, no raw domain-table dump, no nested member/role data.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT
             o.id,
             o.name,
             o.slug,
             o.status,
             o.created_at,
             (
               SELECT count(*) FROM membership_organization_members m
               WHERE m.org_id = o.id AND m.status = 'active'
             ) AS member_count
           FROM membership_organizations o
           WHERE o.id = $1`,
          [orgId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapOrganizationProjection(result.rows[0]!) };
      } catch {
        return safeError("Failed to look up organization for support");
      }
    },

    async lookupUserForSupport(
      userId: string,
    ): Promise<SupportResult<SupportUserProjection>> {
      try {
        // Narrow projection only: id/email/displayName/status/createdAt. No
        // auth identities, sessions, login challenges, or token material.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, email, display_name, status, created_at
           FROM identity_users
           WHERE id = $1`,
          [userId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapUserProjection(result.rows[0]!) };
      } catch {
        return safeError("Failed to look up user for support");
      }
    },
  };
}
