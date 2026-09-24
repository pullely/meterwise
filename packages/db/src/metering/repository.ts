import type { SqlExecutor } from "../d1/executor.js";
import type {
  MeteringRepository,
  MeteringResult,
  CursorPosition,
  PagedResult,
  PageQueryParams,
  UsageRecord,
  UsageRollup,
  UsageSummary,
  UsageSummaryQuery,
  RollupMaterializationWindow,
  RollupMaterializationResult,
  QuotaCheckResult,
  QuotaViolation,
  ListViolationsQuery,
  RecordUsageInput,
  QuotaPeriod,
  QuotaEnforcement,
  BucketType,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";
import { parseNullableJsonColumn } from "../json.js";

// ── Row mappers ────────────────────────────────────────────

function mapUsageRecord(row: Record<string, unknown>): UsageRecord {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    resourceId: (row.resource_id as string) ?? null,
    metric: row.metric as string,
    quantity: Number(row.quantity),
    idempotencyKey: row.idempotency_key as string,
    recordedAt: new Date(row.recorded_at as string),
    metadata: parseNullableJsonColumn<Record<string, unknown>>(row.metadata),
    createdAt: new Date(row.created_at as string),
  };
}

function mapUsageRollup(row: Record<string, unknown>): UsageRollup {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    metric: row.metric as string,
    bucketType: row.bucket_type as BucketType,
    bucketStart: new Date(row.bucket_start as string),
    quantity: Number(row.quantity),
    recordCount: Number(row.record_count),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapQuotaViolation(row: Record<string, unknown>): QuotaViolation {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    resourceId: (row.resource_id as string) ?? null,
    quotaId: row.quota_id as string,
    metric: row.metric as string,
    limitValue: Number(row.limit_value),
    actualValue: Number(row.actual_value),
    period: row.period as QuotaPeriod,
    enforcement: row.enforcement as QuotaEnforcement,
    violatedAt: new Date(row.violated_at as string),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
    metadata: parseNullableJsonColumn<Record<string, unknown>>(row.metadata),
    createdAt: new Date(row.created_at as string),
  };
}

// ── Helpers ────────────────────────────────────────────────

function safeError(message: string): MeteringResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}


// ── Paged list helper ──────────────────────────────────────

async function pagedList<T>(
  executor: SqlExecutor,
  sql: string,
  values: unknown[],
  limit: number,
  cursor: CursorPosition | null,
  mapper: (row: Record<string, unknown>) => T,
  cursorDateField = "created_at",
): Promise<MeteringResult<PagedResult<T>>> {
  try {
    const fetchLimit = limit + 1;
    let fullSql: string;
    let fullValues: unknown[];
    const baseIdx = values.length;

    if (cursor) {
      fullSql = `${sql} AND (${cursorDateField}, id) < ($${baseIdx + 2}, $${baseIdx + 3}) ORDER BY ${cursorDateField} DESC, id DESC LIMIT $${baseIdx + 1}`;
      fullValues = [...values, fetchLimit, cursor.createdAt, cursor.id];
    } else {
      fullSql = `${sql} ORDER BY ${cursorDateField} DESC, id DESC LIMIT $${baseIdx + 1}`;
      fullValues = [...values, fetchLimit];
    }

    const result = await executor.execute<Record<string, unknown>>(fullSql, fullValues);
    const rows = result.rows.map(mapper);
    let nextCursor: CursorPosition | null = null;
    if (rows.length > limit) {
      rows.pop();
      const last = rows[rows.length - 1]!;
      nextCursor = {
        createdAt: (last as unknown as { createdAt: Date }).createdAt.toISOString(),
        id: (last as unknown as { id: string }).id,
      };
    }
    return { ok: true, value: { items: rows, nextCursor } };
  } catch {
    return safeError("Failed to list records");
  }
}

// ── Repository factory ─────────────────────────────────────

export function createMeteringRepository(executor: SqlExecutor): MeteringRepository {
  return {
    async recordUsage(input: RecordUsageInput): Promise<MeteringResult<UsageRecord>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO metering_usage_records
             (id, org_id, project_id, environment_id, resource_id, metric, quantity, idempotency_key, recorded_at, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (org_id, idempotency_key) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId ?? null,
            input.environmentId ?? null,
            input.resourceId ?? null,
            input.metric,
            input.quantity ?? 1,
            input.idempotencyKey,
            input.recordedAt?.toISOString() ?? new Date().toISOString(),
            input.metadata ? JSON.stringify(input.metadata) : null,
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "usage_record" } };
        }
        return { ok: true, value: mapUsageRecord(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "usage_record" } };
        }
        return safeError("Failed to record usage");
      }
    },

    async ingestUsageBatch(
      inputs: RecordUsageInput[],
    ): Promise<MeteringResult<{ results: Array<MeteringResult<UsageRecord>> }>> {
      const results: Array<MeteringResult<UsageRecord>> = [];
      for (const input of inputs) {
        const result = await this.recordUsage(input);
        results.push(result);
      }
      return { ok: true, value: { results } };
    },

    async getUsageSummary(query: UsageSummaryQuery): Promise<MeteringResult<UsageSummary>> {
      try {
        const conditions: string[] = ["org_id = $1", "metric = $2"];
        const values: unknown[] = [query.orgId, query.metric];
        let idx = 3;

        if (query.projectId) {
          conditions.push(`project_id = $${idx}`);
          values.push(query.projectId);
          idx++;
        }
        if (query.environmentId) {
          conditions.push(`environment_id = $${idx}`);
          values.push(query.environmentId);
          idx++;
        }
        if (query.bucketType) {
          conditions.push(`bucket_type = $${idx}`);
          values.push(query.bucketType);
          idx++;
        }
        if (query.startTime) {
          conditions.push(`bucket_start >= $${idx}`);
          values.push(query.startTime.toISOString());
          idx++;
        }
        if (query.endTime) {
          conditions.push(`bucket_start < $${idx}`);
          values.push(query.endTime.toISOString());
          idx++;
        }

        const whereClause = conditions.join(" AND ");
        const sql = `SELECT * FROM metering_usage_rollups WHERE ${whereClause} ORDER BY bucket_start DESC`;
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rollups = result.rows.map(mapUsageRollup);

        let totalQuantity = 0;
        let totalRecords = 0;
        for (const r of rollups) {
          totalQuantity += r.quantity;
          totalRecords += r.recordCount;
        }

        return {
          ok: true,
          value: {
            metric: query.metric,
            totalQuantity,
            totalRecords,
            rollups,
          },
        };
      } catch {
        return safeError("Failed to get usage summary");
      }
    },

    async listUsageRollups(
      orgId: string,
      params: PageQueryParams,
    ): Promise<MeteringResult<PagedResult<UsageRollup>>> {
      return pagedList(
        executor,
        "SELECT * FROM metering_usage_rollups WHERE org_id = $1",
        [orgId],
        params.limit,
        params.cursor,
        mapUsageRollup,
      );
    },

    async materializeUsageRollups(
      window: RollupMaterializationWindow,
    ): Promise<MeteringResult<RollupMaterializationResult>> {
      if (window.bucketType !== "hour" && window.bucketType !== "day") {
        return safeError("Invalid bucket_type");
      }
      if (!(window.start instanceof Date) || !(window.end instanceof Date)) {
        return safeError("Invalid window bounds");
      }
      if (window.end.getTime() <= window.start.getTime()) {
        return safeError("Window end must be greater than start");
      }

      // Aggregate raw usage records into the target bucket and upsert into
      // metering_usage_rollups. The unique index is on
      // (org_id, COALESCE(project_id, ''), COALESCE(environment_id, ''), metric, bucket_type, bucket_start)
      // — the ON CONFLICT target must mirror those expressions exactly.
      //
      // Truncation is a strftime format, not a `date_trunc` argument: SQLite
      // has no date_trunc, and timestamps are stored as ISO-8601 text. The
      // format is chosen from the bucket type validated at the top of this
      // method (it is an enum of two literals, never caller text), because a
      // bound parameter cannot appear inside a strftime format string.
      const bucketFormat =
        window.bucketType === "hour" ? "%Y-%m-%dT%H:00:00.000Z" : "%Y-%m-%dT00:00:00.000Z";

      // The synthesized id is the aggregation key itself, so repeated
      // materializations of the same bucket produce the same id. (Postgres
      // hashed it with md5; SQLite has no md5 and D1 exposes no hash function,
      // and the key is already unique — hashing only shortened it.) On
      // conflict the existing row id is kept and quantity/record_count are
      // overwritten.
      //
      // All values are passed via $-parameters; no user input is interpolated.
      const sql = `
        WITH agg AS (
          SELECT
            org_id,
            project_id,
            environment_id,
            metric,
            strftime('${bucketFormat}', recorded_at) AS bucket_start,
            SUM(quantity)                            AS quantity,
            COUNT(*)                                 AS record_count
          FROM metering_usage_records
          WHERE recorded_at >= $2
            AND recorded_at <  $3
          GROUP BY org_id, project_id, environment_id, metric,
                   strftime('${bucketFormat}', recorded_at)
        )
        INSERT INTO metering_usage_rollups (
          id, org_id, project_id, environment_id, metric,
          bucket_type, bucket_start, quantity, record_count,
          created_at, updated_at
        )
        SELECT
          org_id || '|' ||
            COALESCE(project_id, '') || '|' ||
            COALESCE(environment_id, '') || '|' ||
            metric || '|' ||
            $1 || '|' ||
            bucket_start AS id,
          org_id, project_id, environment_id, metric,
          $1             AS bucket_type,
          bucket_start,
          quantity,
          record_count,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM agg
        WHERE true
        ON CONFLICT (
          org_id,
          COALESCE(project_id, ''),
          COALESCE(environment_id, ''),
          metric,
          bucket_type,
          bucket_start
        ) DO UPDATE SET
          quantity     = EXCLUDED.quantity,
          record_count = EXCLUDED.record_count,
          updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `;

      try {
        const result = await executor.execute<Record<string, unknown>>(sql, [
          window.bucketType,
          window.start.toISOString(),
          window.end.toISOString(),
        ]);
        return {
          ok: true,
          value: {
            bucketType: window.bucketType,
            windowStart: window.start,
            windowEnd: window.end,
            rollupsWritten: result.rowCount,
          },
        };
      } catch {
        return safeError("Failed to materialize usage rollups");
      }
    },

    async checkQuota(
      orgId: string,
      metric: string,
      options?: {
        projectId?: string;
        environmentId?: string;
        resourceId?: string;
      },
    ): Promise<MeteringResult<QuotaCheckResult>> {
      try {
        // Find the most specific active quota definition
        const conditions: string[] = [
          "org_id = $1",
          "metric = $2",
          "status = 'active'",
        ];
        const values: unknown[] = [orgId, metric];
        let idx = 3;

        // Build scope conditions — match exact or NULL for optional dimensions
        const scopeConditions: string[] = [];
        if (options?.projectId) {
          scopeConditions.push(`(project_id = $${idx} OR project_id IS NULL)`);
          values.push(options.projectId);
          idx++;
        } else {
          scopeConditions.push("project_id IS NULL");
        }
        if (options?.environmentId) {
          scopeConditions.push(`(environment_id = $${idx} OR environment_id IS NULL)`);
          values.push(options.environmentId);
          idx++;
        } else {
          scopeConditions.push("environment_id IS NULL");
        }
        if (options?.resourceId) {
          scopeConditions.push(`(resource_id = $${idx} OR resource_id IS NULL)`);
          values.push(options.resourceId);
          idx++;
        } else {
          scopeConditions.push("resource_id IS NULL");
        }

        conditions.push(...scopeConditions);
        const whereClause = conditions.join(" AND ");

        // Get the quota definition (most specific first)
        const quotaSql = `SELECT * FROM metering_quota_definitions WHERE ${whereClause} ORDER BY
          CASE WHEN resource_id IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN environment_id IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN project_id IS NOT NULL THEN 0 ELSE 1 END
          LIMIT 1`;
        const quotaResult = await executor.execute<Record<string, unknown>>(quotaSql, values);

        if (quotaResult.rowCount === 0) {
          // No quota defined — usage is allowed
          return {
            ok: true,
            value: {
              allowed: true,
              metric,
              limit: -1,
              used: 0,
              remaining: -1,
              period: "month",
              enforcement: "soft",
              reason: "no_quota_defined",
            },
          };
        }

        const quota = quotaResult.rows[0]!;
        const limitValue = Number(quota.limit_value);
        const period = quota.period as QuotaPeriod;
        const enforcement = quota.enforcement as QuotaEnforcement;

        // Calculate current usage from rollups for the period
        const now = new Date();
        let periodStart: Date;
        switch (period) {
          case "hour":
            periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
            break;
          case "day":
            periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            break;
          case "month":
          case "billing_cycle":
            periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
        }

        // Sum usage from raw records for the current period
        const usageConditions: string[] = ["org_id = $1", "metric = $2", "recorded_at >= $3"];
        const usageValues: unknown[] = [orgId, metric, periodStart.toISOString()];
        let usageIdx = 4;

        if (options?.projectId) {
          usageConditions.push(`project_id = $${usageIdx}`);
          usageValues.push(options.projectId);
          usageIdx++;
        }
        if (options?.environmentId) {
          usageConditions.push(`environment_id = $${usageIdx}`);
          usageValues.push(options.environmentId);
          usageIdx++;
        }
        if (options?.resourceId) {
          usageConditions.push(`resource_id = $${usageIdx}`);
          usageValues.push(options.resourceId);
          usageIdx++;
        }

        const usageSql = `SELECT COALESCE(SUM(quantity), 0) as total FROM metering_usage_records WHERE ${usageConditions.join(" AND ")}`;
        const usageResult = await executor.execute<Record<string, unknown>>(usageSql, usageValues);
        const used = Number(usageResult.rows[0]?.total ?? 0);
        const remaining = Math.max(0, limitValue - used);
        const allowed = used < limitValue;

        return {
          ok: true,
          value: {
            allowed,
            metric,
            limit: limitValue,
            used,
            remaining,
            period,
            enforcement,
            reason: allowed ? null : "quota_exceeded",
          },
        };
      } catch {
        return safeError("Failed to check quota");
      }
    },

    async listQuotaViolations(
      query: ListViolationsQuery,
      params: PageQueryParams,
    ): Promise<MeteringResult<PagedResult<QuotaViolation>>> {
      const conditions: string[] = ["org_id = $1"];
      const values: unknown[] = [query.orgId];
      let idx = 2;

      if (query.projectId) {
        conditions.push(`project_id = $${idx}`);
        values.push(query.projectId);
        idx++;
      }
      if (query.environmentId) {
        conditions.push(`environment_id = $${idx}`);
        values.push(query.environmentId);
        idx++;
      }
      if (query.resourceId) {
        conditions.push(`resource_id = $${idx}`);
        values.push(query.resourceId);
        idx++;
      }
      if (query.metric) {
        conditions.push(`metric = $${idx}`);
        values.push(query.metric);
        idx++;
      }

      const whereClause = conditions.join(" AND ");
      return pagedList(
        executor,
        `SELECT * FROM metering_quota_violations WHERE ${whereClause}`,
        values,
        params.limit,
        params.cursor,
        mapQuotaViolation,
        "violated_at",
      );
    },
  };
}
