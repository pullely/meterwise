// ── Result type ─────────────────────────────────────────────

export type MeteringRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type MeteringResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MeteringRepositoryError };

// ── Cursor pagination ───────────────────────────────────────

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

// ── Usage records ───────────────────────────────────────────

export interface UsageRecord {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  resourceId: string | null;
  metric: string;
  quantity: number;
  idempotencyKey: string;
  recordedAt: Date;
  /** Bounded safe metadata only — no secrets, tokens, or credentials. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface RecordUsageInput {
  id: string;
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
  resourceId?: string | null;
  metric: string;
  quantity?: number;
  idempotencyKey: string;
  recordedAt?: Date;
  /** Bounded safe metadata only — no secrets, tokens, or credentials. */
  metadata?: Record<string, unknown> | null;
}

// ── Usage rollups ───────────────────────────────────────────

export type BucketType = "hour" | "day";

export interface UsageRollup {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  metric: string;
  bucketType: BucketType;
  bucketStart: Date;
  quantity: number;
  recordCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Window over which to materialize rollups from raw usage records.
 * `start` is inclusive, `end` is exclusive. The materializer aggregates all
 * usage records with `recorded_at >= start AND recorded_at < end`, grouped
 * into buckets of `bucketType`. Callers MUST pass a bounded recent window —
 * never an unbounded scan of history.
 */
export interface RollupMaterializationWindow {
  bucketType: BucketType;
  start: Date;
  end: Date;
}

/**
 * Result of a single bucket-type rollup materialization pass.
 * `rollupsWritten` is the number of distinct rollup rows that were upserted
 * (one per org/project/environment/metric/bucket_start group within the window).
 */
export interface RollupMaterializationResult {
  bucketType: BucketType;
  windowStart: Date;
  windowEnd: Date;
  rollupsWritten: number;
}

export interface UsageSummaryQuery {
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
  metric: string;
  bucketType?: BucketType;
  startTime?: Date;
  endTime?: Date;
}

export interface UsageSummary {
  metric: string;
  totalQuantity: number;
  totalRecords: number;
  rollups: UsageRollup[];
}

// ── Quota definitions ───────────────────────────────────────

export type QuotaPeriod = "hour" | "day" | "month" | "billing_cycle";
export type QuotaEnforcement = "soft" | "hard";
export type QuotaStatus = "active" | "inactive";

export interface QuotaDefinition {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  resourceId: string | null;
  metric: string;
  limitValue: number;
  period: QuotaPeriod;
  enforcement: QuotaEnforcement;
  status: QuotaStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuotaCheckResult {
  allowed: boolean;
  metric: string;
  limit: number;
  used: number;
  remaining: number;
  period: QuotaPeriod;
  enforcement: QuotaEnforcement;
  reason: string | null;
}

// ── Quota violations ────────────────────────────────────────

export interface QuotaViolation {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  resourceId: string | null;
  quotaId: string;
  metric: string;
  limitValue: number;
  actualValue: number;
  period: QuotaPeriod;
  enforcement: QuotaEnforcement;
  violatedAt: Date;
  resolvedAt: Date | null;
  /** Safe violation context — no secrets, tokens, or credentials. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ListViolationsQuery {
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
  resourceId?: string | null;
  metric?: string;
}

// ── Repository interface ────────────────────────────────────

export interface MeteringRepository {
  /**
   * Record a single usage event with exactly-once insert semantics.
   * Returns conflict if the (org_id, idempotency_key) pair already exists.
   */
  recordUsage(input: RecordUsageInput): Promise<MeteringResult<UsageRecord>>;

  /**
   * Ingest a batch of usage records. Each record is individually checked for
   * idempotency conflicts. Returns per-record results.
   */
  ingestUsageBatch(
    inputs: RecordUsageInput[],
  ): Promise<MeteringResult<{ results: Array<MeteringResult<UsageRecord>> }>>;

  /**
   * Query aggregated usage summaries by org, optional dimensions, metric, and time range.
   */
  getUsageSummary(query: UsageSummaryQuery): Promise<MeteringResult<UsageSummary>>;

  /**
   * List usage rollups with cursor pagination.
   */
  listUsageRollups(
    orgId: string,
    params: PageQueryParams,
  ): Promise<MeteringResult<PagedResult<UsageRollup>>>;

  /**
   * Materialize `metering_usage_rollups` rows from `metering_usage_records`
   * for the given bounded window and bucket type. Idempotent: re-running for
   * the same window overwrites the affected rollup rows with the latest
   * aggregate values rather than duplicating them.
   *
   * Aggregation key is `(org_id, project_id, environment_id, metric, bucket_type, bucket_start)`.
   * Every aggregation row is org-scoped — no cross-org grouping is possible.
   */
  materializeUsageRollups(
    window: RollupMaterializationWindow,
  ): Promise<MeteringResult<RollupMaterializationResult>>;

  /**
   * Check quota for a given org and metric against active quota definitions.
   * Returns structured facts (allowed, limit, used, remaining, period, reason).
   * Does not throw on exceeded quota.
   */
  checkQuota(
    orgId: string,
    metric: string,
    options?: {
      projectId?: string;
      environmentId?: string;
      resourceId?: string;
    },
  ): Promise<MeteringResult<QuotaCheckResult>>;

  /**
   * List quota violations by organization with optional dimension filters.
   */
  listQuotaViolations(
    query: ListViolationsQuery,
    params: PageQueryParams,
  ): Promise<MeteringResult<PagedResult<QuotaViolation>>>;
}
