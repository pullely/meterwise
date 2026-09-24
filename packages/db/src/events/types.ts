export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type EventsRepositoryError =
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type EventsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EventsRepositoryError };

// ---------------------------------------------------------------------------
// Domain entities (mapped from DB rows)
// ---------------------------------------------------------------------------

export interface StoredEvent {
  id: string;
  type: string;
  version: number;
  source: string;
  occurredAt: Date;
  actorType: string;
  actorId: string;
  actorSessionId: string | null;
  actorIp: string | null;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  subjectKind: string;
  subjectId: string;
  subjectName: string | null;
  requestId: string;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  redactPaths: string[];
  createdAt: Date;
}

export interface StoredAuditEntry {
  id: string;
  eventId: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  actorType: string;
  actorId: string;
  eventType: string;
  eventVersion: number;
  source: string;
  subjectKind: string;
  subjectId: string;
  subjectName: string | null;
  category: string;
  description: string;
  occurredAt: Date;
  requestId: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
  redactPaths: string[];
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AppendEventInput {
  id: string;
  type: string;
  version: number;
  source: string;
  occurredAt: Date;
  actorType: string;
  actorId: string;
  actorSessionId?: string | null;
  actorIp?: string | null;
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
  subjectKind: string;
  subjectId: string;
  subjectName?: string | null;
  requestId: string;
  correlationId?: string | null;
  causationId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  redactPaths?: string[];
}

export interface AppendAuditInput {
  id: string;
  eventId: string;
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
  actorType: string;
  actorId: string;
  eventType: string;
  eventVersion: number;
  source: string;
  subjectKind: string;
  subjectId: string;
  subjectName?: string | null;
  category?: string;
  description?: string;
  occurredAt: Date;
  requestId: string;
  correlationId?: string | null;
  payload: Record<string, unknown>;
  redactPaths?: string[];
}

export interface AppendEventWithAuditInput {
  event: AppendEventInput;
  audit: Omit<AppendAuditInput, "eventId" | "orgId" | "actorType" | "actorId" | "eventType" | "eventVersion" | "source" | "subjectKind" | "subjectId" | "subjectName" | "occurredAt" | "requestId" | "correlationId" | "payload" | "redactPaths"> & {
    id: string;
    category?: string;
    description?: string;
    projectId?: string | null;
    environmentId?: string | null;
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface EventsCursorPosition {
  occurredAt: string;
  id: string;
}

export interface EventsPageQueryParams {
  limit: number;
  cursor: EventsCursorPosition | null;
}

export interface EventsPagedResult<T> {
  items: T[];
  nextCursor: EventsCursorPosition | null;
}

/**
 * Optional, independently-combinable filters for the org-scoped audit read.
 *
 * Each field narrows the result set with an additional `AND` clause; omitting
 * a field (or passing `undefined`) leaves that dimension unfiltered. `from` /
 * `to` are inclusive ISO-8601 timestamps bounding `occurred_at`. None of these
 * change the `ORDER BY occurred_at DESC, id DESC` keyset ordering or the cursor
 * semantics — they only restrict which rows are eligible.
 */
export interface AuditOrgFilters {
  actorId?: string;
  actorType?: string;
  subjectKind?: string;
  subjectId?: string;
  eventType?: string;
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface EventsRepository {
  appendEvent(input: AppendEventInput): Promise<EventsResult<StoredEvent>>;
  appendEventWithAudit(input: AppendEventWithAuditInput): Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>>;
  queryAuditByOrg(orgId: string, params: EventsPageQueryParams, category?: string, filters?: AuditOrgFilters): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>>;
  queryAuditByTarget(orgId: string, subjectKind: string, subjectId: string, params: EventsPageQueryParams): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>>;
  /** Query events for an org after a cursor position (for webhook dispatch fanout). */
  queryEventsByOrg(orgId: string, afterOccurredAt: string | null, afterEventId: string | null, limit: number): Promise<EventsResult<StoredEvent[]>>;
  /**
   * Read a single org-scoped event by id. Returns `null` (not an error) when no
   * row matches — callers distinguish "absent" from "infra failure" without a
   * dedicated `not_found` error kind. Used by the webhooks manual-replay path to
   * rehydrate the full original event payload by id.
   */
  getEventById(orgId: string, eventId: string): Promise<EventsResult<StoredEvent | null>>;
}
