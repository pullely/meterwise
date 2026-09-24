export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SupportRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type SupportResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SupportRepositoryError };

// ---------------------------------------------------------------------------
// Domain types (transport-safe; no platform clients leak through)
// ---------------------------------------------------------------------------

export interface StoredSupportActionRecord {
  id: string;
  actorId: string;
  actorType: string;
  targetOrgId: string;
  action: string;
  reason: string;
  requestId: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface RecordSupportActionInput {
  id: string;
  actorId: string;
  actorType: string;
  targetOrgId: string;
  action: string;
  reason: string;
  requestId: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

export interface SupportCursorPosition {
  occurredAt: string;
  id: string;
}

export interface SupportPageQueryParams {
  limit: number;
  cursor: SupportCursorPosition | null;
}

export interface SupportPagedResult<T> {
  items: T[];
  nextCursor: SupportCursorPosition | null;
}

// ---------------------------------------------------------------------------
// Narrow read-only diagnostic projections
// ---------------------------------------------------------------------------

// Deliberately narrow: support reads expose identification + status only, never
// secrets, tokens, or full domain rows. Expanded per spec-16 as support
// workflows become real.

export interface SupportOrganizationProjection {
  orgId: string;
  name: string;
  slug: string;
  status: string;
  memberCount: number;
  createdAt: Date;
}

export interface SupportUserProjection {
  userId: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface SupportRepository {
  recordSupportAction(
    input: RecordSupportActionInput,
  ): Promise<SupportResult<StoredSupportActionRecord>>;

  listSupportActions(
    targetOrgId: string,
    params: SupportPageQueryParams,
  ): Promise<SupportResult<SupportPagedResult<StoredSupportActionRecord>>>;

  lookupOrganizationForSupport(
    orgId: string,
  ): Promise<SupportResult<SupportOrganizationProjection>>;

  lookupUserForSupport(
    userId: string,
  ): Promise<SupportResult<SupportUserProjection>>;
}
