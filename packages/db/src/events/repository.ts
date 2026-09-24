import type { SqlExecutor } from "../d1/executor.js";
import type {
  AppendEventInput,
  AppendEventWithAuditInput,
  AuditOrgFilters,
  EventsCursorPosition,
  EventsPagedResult,
  EventsPageQueryParams,
  EventsRepository,
  EventsResult,
  StoredAuditEntry,
  StoredEvent,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function parseJsonColumn(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function parseJsonArrayColumn(value: unknown): string[] {
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  }
  if (Array.isArray(value)) return value as string[];
  return [];
}

function mapEvent(row: Record<string, unknown>): StoredEvent {
  return {
    id: row.id as string,
    type: row.type as string,
    version: row.version as number,
    source: row.source as string,
    occurredAt: new Date(row.occurred_at as string),
    actorType: row.actor_type as string,
    actorId: row.actor_id as string,
    actorSessionId: (row.actor_session_id as string) ?? null,
    actorIp: (row.actor_ip as string) ?? null,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    subjectKind: row.subject_kind as string,
    subjectId: row.subject_id as string,
    subjectName: (row.subject_name as string) ?? null,
    requestId: row.request_id as string,
    correlationId: (row.correlation_id as string) ?? null,
    causationId: (row.causation_id as string) ?? null,
    idempotencyKey: (row.idempotency_key as string) ?? null,
    payload: parseJsonColumn(row.payload),
    redactPaths: parseJsonArrayColumn(row.redact_paths),
    createdAt: new Date(row.created_at as string),
  };
}

function mapAuditEntry(row: Record<string, unknown>): StoredAuditEntry {
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    actorType: row.actor_type as string,
    actorId: row.actor_id as string,
    eventType: row.event_type as string,
    eventVersion: row.event_version as number,
    source: row.source as string,
    subjectKind: row.subject_kind as string,
    subjectId: row.subject_id as string,
    subjectName: (row.subject_name as string) ?? null,
    category: row.category as string,
    description: row.description as string,
    occurredAt: new Date(row.occurred_at as string),
    requestId: row.request_id as string,
    correlationId: (row.correlation_id as string) ?? null,
    payload: parseJsonColumn(row.payload),
    redactPaths: parseJsonArrayColumn(row.redact_paths),
    createdAt: new Date(row.created_at as string),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function safeError(message: string): EventsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function buildCursorCondition(cursor: EventsCursorPosition | null, startParam: number): { clause: string; params: unknown[] } {
  if (!cursor) return { clause: "", params: [] };
  return {
    clause: ` AND (occurred_at, id) < ($${startParam}, $${startParam + 1})`,
    params: [cursor.occurredAt, cursor.id],
  };
}

function extractNextCursor<T extends { occurredAt: Date; id: string }>(
  items: T[],
  limit: number,
): { trimmed: T[]; nextCursor: EventsCursorPosition | null } {
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

export function createEventsRepository(executor: SqlExecutor): EventsRepository {
  return {
    async appendEvent(input: AppendEventInput): Promise<EventsResult<StoredEvent>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events_event_log (
            id, type, version, source, occurred_at,
            actor_type, actor_id, actor_session_id, actor_ip,
            org_id, project_id, environment_id,
            subject_kind, subject_id, subject_name,
            request_id, correlation_id, causation_id, idempotency_key,
            payload, redact_paths
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12,
            $13, $14, $15,
            $16, $17, $18, $19,
            $20, $21
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING *`,
          [
            input.id,
            input.type,
            input.version,
            input.source,
            input.occurredAt.toISOString(),
            input.actorType,
            input.actorId,
            input.actorSessionId ?? null,
            input.actorIp ?? null,
            input.orgId,
            input.projectId ?? null,
            input.environmentId ?? null,
            input.subjectKind,
            input.subjectId,
            input.subjectName ?? null,
            input.requestId,
            input.correlationId ?? null,
            input.causationId ?? null,
            input.idempotencyKey ?? null,
            JSON.stringify(input.payload),
            JSON.stringify(input.redactPaths ?? []),
          ],
        );

        if (result.rows.length === 0) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }

        return { ok: true, value: mapEvent(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }
        return safeError("Failed to append event");
      }
    },

    async appendEventWithAudit(input: AppendEventWithAuditInput): Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>> {
      const { event, audit } = input;
      // chaseid CH2: TWO statements, not one. The baseline wrote this as a
      // single Postgres data-modifying CTE (`WITH inserted_event AS (INSERT …)
      // … row_to_json(…) … FULL JOIN`), which SQLite — and so D1 — cannot
      // parse: D1 answers `near "INSERT": syntax error` and
      // `no such function: row_to_json`. Every audited write on this stack
      // therefore failed into the catch below and returned an error most
      // callers never look at. `INSERT … ON CONFLICT DO NOTHING RETURNING *`
      // runs on both engines. D1 has no interactive transaction to put the
      // pair in; the event goes first, so a failure between the two leaves an
      // event without its audit row (the webhook fan-out still sees it), never
      // an audit row pointing at nothing.
      try {
        const eventRows = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events_event_log (
            id, type, version, source, occurred_at,
            actor_type, actor_id, actor_session_id, actor_ip,
            org_id, project_id, environment_id,
            subject_kind, subject_id, subject_name,
            request_id, correlation_id, causation_id, idempotency_key,
            payload, redact_paths
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12,
            $13, $14, $15,
            $16, $17, $18, $19,
            $20, $21
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING *`,
          [
            event.id,
            event.type,
            event.version,
            event.source,
            event.occurredAt.toISOString(),
            event.actorType,
            event.actorId,
            event.actorSessionId ?? null,
            event.actorIp ?? null,
            event.orgId,
            event.projectId ?? null,
            event.environmentId ?? null,
            event.subjectKind,
            event.subjectId,
            event.subjectName ?? null,
            event.requestId,
            event.correlationId ?? null,
            event.causationId ?? null,
            event.idempotencyKey ?? null,
            JSON.stringify(event.payload),
            JSON.stringify(event.redactPaths ?? []),
          ],
        );

        if (eventRows.rows.length === 0) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }
        const storedEvent = eventRows.rows[0]!;

        const auditRows = await executor.execute<Record<string, unknown>>(
          `INSERT INTO events_audit_entries (
            id, event_id, org_id, project_id, environment_id,
            actor_type, actor_id,
            event_type, event_version, source,
            subject_kind, subject_id, subject_name,
            category, description, occurred_at,
            request_id, correlation_id,
            payload, redact_paths
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7,
            $8, $9, $10,
            $11, $12, $13,
            $14, $15, $16,
            $17, $18,
            $19, $20
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING *`,
          [
            audit.id,
            event.id,
            event.orgId,
            audit.projectId ?? event.projectId ?? null,
            audit.environmentId ?? event.environmentId ?? null,
            event.actorType,
            event.actorId,
            event.type,
            event.version,
            event.source,
            event.subjectKind,
            event.subjectId,
            event.subjectName ?? null,
            audit.category ?? "general",
            audit.description ?? "",
            event.occurredAt.toISOString(),
            event.requestId,
            event.correlationId ?? null,
            JSON.stringify(event.payload),
            JSON.stringify(event.redactPaths ?? []),
          ],
        );

        if (auditRows.rows.length === 0) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }

        return {
          ok: true,
          value: {
            event: mapEvent(storedEvent),
            audit: mapAuditEntry(auditRows.rows[0]!),
          },
        };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "event" } };
        }
        return safeError("Failed to append event with audit");
      }
    },

    async queryAuditByOrg(orgId: string, params: EventsPageQueryParams, category?: string, filters?: AuditOrgFilters): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>> {
      try {
        // Support both raw UUID and legacy public org_ ID format.
        // Legacy membership audit rows stored org_id as "org_<hex>" instead of raw UUID.
        const legacyOrgId = `org_${orgId.replace(/-/g, "")}`;
        const baseParams: unknown[] = [orgId, legacyOrgId];
        let paramIndex = 3;

        let categoryClause = "";
        if (category) {
          categoryClause = ` AND category = $${paramIndex}`;
          baseParams.push(category);
          paramIndex++;
        }

        // Optional, independently-combinable filter clauses. Each appends a
        // parameterized `AND` predicate and advances the placeholder index;
        // none alter the ORDER BY / cursor keyset. `from`/`to` are inclusive.
        let filterClause = "";
        if (filters) {
          const eq: Array<[string, string | undefined]> = [
            ["actor_id", filters.actorId],
            ["actor_type", filters.actorType],
            ["subject_kind", filters.subjectKind],
            ["subject_id", filters.subjectId],
            ["event_type", filters.eventType],
          ];
          for (const [column, value] of eq) {
            if (value !== undefined) {
              filterClause += ` AND ${column} = $${paramIndex}`;
              baseParams.push(value);
              paramIndex++;
            }
          }
          if (filters.from !== undefined) {
            filterClause += ` AND occurred_at >= $${paramIndex}`;
            baseParams.push(filters.from);
            paramIndex++;
          }
          if (filters.to !== undefined) {
            filterClause += ` AND occurred_at <= $${paramIndex}`;
            baseParams.push(filters.to);
            paramIndex++;
          }
        }

        baseParams.push(params.limit + 1);
        const limitParam = paramIndex;
        paramIndex++;

        const { clause, params: cursorParams } = buildCursorCondition(params.cursor, paramIndex);
        const allParams = [...baseParams, ...cursorParams];

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events_audit_entries
           WHERE org_id IN ($1, $2)${categoryClause}${filterClause}${clause}
           ORDER BY occurred_at DESC, id DESC
           LIMIT $${limitParam}`,
          allParams,
        );

        const mapped = result.rows.map(mapAuditEntry);
        const { trimmed, nextCursor } = extractNextCursor(mapped, params.limit);
        return { ok: true, value: { items: trimmed, nextCursor } };
      } catch {
        return safeError("Failed to query audit by org");
      }
    },

    async queryAuditByTarget(orgId: string, subjectKind: string, subjectId: string, params: EventsPageQueryParams): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>> {
      try {
        const { clause, params: cursorParams } = buildCursorCondition(params.cursor, 5);
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events_audit_entries
           WHERE org_id = $1 AND subject_kind = $2 AND subject_id = $3${clause}
           ORDER BY occurred_at DESC, id DESC
           LIMIT $4`,
          [orgId, subjectKind, subjectId, params.limit + 1, ...cursorParams],
        );

        const mapped = result.rows.map(mapAuditEntry);
        const { trimmed, nextCursor } = extractNextCursor(mapped, params.limit);
        return { ok: true, value: { items: trimmed, nextCursor } };
      } catch {
        return safeError("Failed to query audit by target");
      }
    },

    async queryEventsByOrg(orgId: string, afterOccurredAt: string | null, afterEventId: string | null, limit: number): Promise<EventsResult<StoredEvent[]>> {
      try {
        let sql: string;
        let values: unknown[];
        if (afterOccurredAt && afterEventId) {
          sql = `SELECT * FROM events_event_log
                 WHERE org_id = $1 AND (occurred_at, id) > ($2, $3)
                 ORDER BY occurred_at ASC, id ASC
                 LIMIT $4`;
          values = [orgId, afterOccurredAt, afterEventId, limit];
        } else {
          sql = `SELECT * FROM events_event_log
                 WHERE org_id = $1
                 ORDER BY occurred_at ASC, id ASC
                 LIMIT $2`;
          values = [orgId, limit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        return { ok: true, value: result.rows.map(mapEvent) };
      } catch {
        return safeError("Failed to query events by org");
      }
    },

    async getEventById(orgId: string, eventId: string): Promise<EventsResult<StoredEvent | null>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM events_event_log WHERE org_id = $1 AND id = $2`,
          [orgId, eventId],
        );
        if (result.rows.length === 0) {
          return { ok: true, value: null };
        }
        return { ok: true, value: mapEvent(result.rows[0]!) };
      } catch {
        return safeError("Failed to get event by id");
      }
    },
  };
}
