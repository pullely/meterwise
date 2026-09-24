/**
 * Metering contract types.
 *
 * These types define the public API request/response shapes for usage recording,
 * usage summaries, quota checks, and quota violation listing.
 * No bearer tokens, API keys, provider credentials, connection strings,
 * webhook signing secrets, or plaintext secret material are included.
 */

// ---------------------------------------------------------------------------
// Usage Recording
// ---------------------------------------------------------------------------

export interface RecordUsageRequest {
  /** Caller-provided unique ID for this usage event. */
  id?: string;
  /** Usage metric key (e.g. 'api_requests', 'build_minutes'). */
  metric: string;
  /** Usage quantity. Defaults to 1. */
  quantity?: number;
  /** Caller-provided deduplication key, unique per organization. */
  idempotencyKey: string;
  /** ISO 8601 timestamp when usage occurred. Defaults to now. */
  recordedAt?: string;
  /** Optional project scoping. */
  projectId?: string | null;
  /** Optional environment scoping (requires projectId). */
  environmentId?: string | null;
  /** Optional resource identifier (e.g. worker ID, page ID). */
  resourceId?: string | null;
  /** Bounded safe metadata — no secrets, tokens, or credentials. */
  metadata?: Record<string, unknown> | null;
}

export interface RecordUsageResponse {
  usageRecord: PublicUsageRecord;
}

export interface PublicUsageRecord {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  resourceId: string | null;
  metric: string;
  quantity: number;
  idempotencyKey: string;
  recordedAt: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Batch Usage Ingestion
// ---------------------------------------------------------------------------

export interface IngestUsageBatchRequest {
  /** Array of usage events to ingest. */
  records: RecordUsageRequest[];
}

export interface IngestUsageBatchResponse {
  /** Per-record results. Each entry is either a success or a conflict/error. */
  results: Array<
    | { ok: true; usageRecord: PublicUsageRecord }
    | { ok: false; error: { kind: string; message?: string } }
  >;
}

// ---------------------------------------------------------------------------
// Usage Summaries
// ---------------------------------------------------------------------------

export interface GetUsageSummaryRequest {
  /** Usage metric key to summarize. */
  metric: string;
  /** Optional project filter. */
  projectId?: string | null;
  /** Optional environment filter (requires projectId). */
  environmentId?: string | null;
  /** Rollup bucket type filter: 'hour' or 'day'. */
  bucketType?: "hour" | "day";
  /** ISO 8601 start time (inclusive). */
  startTime?: string;
  /** ISO 8601 end time (exclusive). */
  endTime?: string;
}

export interface PublicUsageRollup {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  metric: string;
  bucketType: "hour" | "day";
  bucketStart: string;
  quantity: number;
  recordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GetUsageSummaryResponse {
  metric: string;
  totalQuantity: number;
  totalRecords: number;
  rollups: PublicUsageRollup[];
}

// ---------------------------------------------------------------------------
// Quota Check
// ---------------------------------------------------------------------------

export interface CheckQuotaRequest {
  /** Usage metric key to check. */
  metric: string;
  /** Optional project scoping. */
  projectId?: string;
  /** Optional environment scoping. */
  environmentId?: string;
  /** Optional resource scoping. */
  resourceId?: string;
}

export interface CheckQuotaResponse {
  /** Whether the usage is within the quota limit. */
  allowed: boolean;
  /** The metric being checked. */
  metric: string;
  /** Quota limit (-1 if no quota defined). */
  limit: number;
  /** Current usage quantity. */
  used: number;
  /** Remaining quota (-1 if no quota defined). */
  remaining: number;
  /** Quota period. */
  period: "hour" | "day" | "month" | "billing_cycle";
  /** Enforcement mode. */
  enforcement: "soft" | "hard";
  /** Reason for the result (null if allowed, 'quota_exceeded' or 'no_quota_defined'). */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Quota Violations
// ---------------------------------------------------------------------------

export interface ListQuotaViolationsRequest {
  /** Optional project filter. */
  projectId?: string;
  /** Optional environment filter. */
  environmentId?: string;
  /** Optional resource filter. */
  resourceId?: string;
  /** Optional metric filter. */
  metric?: string;
  /** Pagination limit. */
  limit?: number;
  /** Pagination cursor. */
  cursor?: { createdAt: string; id: string } | null;
}

export interface PublicQuotaViolation {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  resourceId: string | null;
  quotaId: string;
  metric: string;
  limitValue: number;
  actualValue: number;
  period: "hour" | "day" | "month" | "billing_cycle";
  enforcement: "soft" | "hard";
  violatedAt: string;
  resolvedAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ListQuotaViolationsResponse {
  violations: PublicQuotaViolation[];
  nextCursor: { createdAt: string; id: string } | null;
}
