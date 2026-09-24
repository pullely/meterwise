import { createMeteringRepository } from "@saas/db/metering";
import type {
  RecordUsageInput,
} from "@saas/db/metering";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

// ── Mock executor ──────────────────────────────────────────

interface MockCall {
  sql: string;
  params: unknown[];
}

function createMockExecutor(
  handler?: (sql: string, params: unknown[]) => SqlExecutorResult<Record<string, unknown>>,
): SqlExecutor & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  return {
    calls,
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<SqlExecutorResult<T>> {
      calls.push({ sql: text, params });
      if (handler) {
        return handler(text, params) as unknown as SqlExecutorResult<T>;
      }
      return { rows: [] as T[], rowCount: 0 };
    },
  };
}

// ── Test data factories ────────────────────────────────────

const ORG_ID = "org-test-001";
const PROJECT_ID = "proj-test-001";
const ENV_ID = "env-test-001";

function makeUsageInput(overrides: Partial<RecordUsageInput> = {}): RecordUsageInput {
  return {
    id: "usage-001",
    orgId: ORG_ID,
    metric: "api_requests",
    quantity: 1,
    idempotencyKey: "idem-001",
    ...overrides,
  };
}

function makeUsageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "usage-001",
    org_id: ORG_ID,
    project_id: null,
    environment_id: null,
    resource_id: null,
    metric: "api_requests",
    quantity: "1",
    idempotency_key: "idem-001",
    recorded_at: "2026-01-01T00:00:00.000Z",
    metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRollupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rollup-001",
    org_id: ORG_ID,
    project_id: null,
    environment_id: null,
    metric: "api_requests",
    bucket_type: "hour",
    bucket_start: "2026-01-01T00:00:00.000Z",
    quantity: "100",
    record_count: "10",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeViolationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "violation-001",
    org_id: ORG_ID,
    project_id: null,
    environment_id: null,
    resource_id: null,
    quota_id: "quota-001",
    metric: "api_requests",
    limit_value: "1000",
    actual_value: "1050",
    period: "month",
    enforcement: "soft",
    violated_at: "2026-01-01T12:00:00.000Z",
    resolved_at: null,
    metadata: null,
    created_at: "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe("Metering Repository", () => {
  describe("recordUsage", () => {
    it("inserts a usage record and returns it", async () => {
      const row = makeUsageRow();
      const executor = createMockExecutor(() => ({
        rows: [row],
        rowCount: 1,
      }));
      const repo = createMeteringRepository(executor);
      const result = await repo.recordUsage(makeUsageInput());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("usage-001");
        expect(result.value.orgId).toBe(ORG_ID);
        expect(result.value.metric).toBe("api_requests");
        expect(result.value.quantity).toBe(1);
        expect(result.value.idempotencyKey).toBe("idem-001");
      }
    });

    it("returns conflict for duplicate idempotency key", async () => {
      const executor = createMockExecutor(() => ({
        rows: [],
        rowCount: 0,
      }));
      const repo = createMeteringRepository(executor);
      const result = await repo.recordUsage(makeUsageInput());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
        expect(result.error).toHaveProperty("entity", "usage_record");
      }
    });

    it("handles unique violation errors", async () => {
      const executor = createMockExecutor(() => {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: metering_usage_records.idempotency_key",
        );
      });
      const repo = createMeteringRepository(executor);
      const result = await repo.recordUsage(makeUsageInput());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });

    it("passes orgId as parameter — never interpolated into SQL", async () => {
      const executor = createMockExecutor(() => ({
        rows: [makeUsageRow()],
        rowCount: 1,
      }));
      const repo = createMeteringRepository(executor);
      await repo.recordUsage(makeUsageInput());

      expect(executor.calls.length).toBe(1);
      const call = executor.calls[0]!;
      // orgId must be in params, not spliced into the SQL string
      expect(call.params).toContain(ORG_ID);
      // SQL should use $N placeholders, not raw values
      expect(call.sql).toContain("$1");
      expect(call.sql).not.toContain(`'${ORG_ID}'`);
    });

    it("stores optional project/environment/resource scope", async () => {
      const row = makeUsageRow({
        project_id: PROJECT_ID,
        environment_id: ENV_ID,
        resource_id: "res-001",
      });
      const executor = createMockExecutor(() => ({
        rows: [row],
        rowCount: 1,
      }));
      const repo = createMeteringRepository(executor);
      const result = await repo.recordUsage(
        makeUsageInput({
          projectId: PROJECT_ID,
          environmentId: ENV_ID,
          resourceId: "res-001",
        }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.projectId).toBe(PROJECT_ID);
        expect(result.value.environmentId).toBe(ENV_ID);
        expect(result.value.resourceId).toBe("res-001");
      }
    });

    it("stores and returns safe metadata", async () => {
      const meta = { source: "api", region: "us-east-1" };
      const row = makeUsageRow({ metadata: meta });
      const executor = createMockExecutor(() => ({
        rows: [row],
        rowCount: 1,
      }));
      const repo = createMeteringRepository(executor);
      const result = await repo.recordUsage(
        makeUsageInput({ metadata: meta }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata).toEqual(meta);
      }
    });
  });

  describe("ingestUsageBatch", () => {
    it("processes each record individually and returns per-record results", async () => {
      let callCount = 0;
      const executor = createMockExecutor(() => {
        callCount++;
        if (callCount === 2) {
          // Second record conflicts
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [makeUsageRow({ id: `usage-${callCount}`, idempotency_key: `idem-${callCount}` })],
          rowCount: 1,
        };
      });
      const repo = createMeteringRepository(executor);

      const result = await repo.ingestUsageBatch([
        makeUsageInput({ id: "usage-1", idempotencyKey: "idem-1" }),
        makeUsageInput({ id: "usage-2", idempotencyKey: "idem-2" }),
        makeUsageInput({ id: "usage-3", idempotencyKey: "idem-3" }),
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.results).toHaveLength(3);
        expect(result.value.results[0]!.ok).toBe(true);
        expect(result.value.results[1]!.ok).toBe(false);
        expect(result.value.results[2]!.ok).toBe(true);
      }
    });
  });

  describe("getUsageSummary", () => {
    it("returns aggregated rollup data", async () => {
      const executor = createMockExecutor(() => ({
        rows: [
          makeRollupRow({ quantity: "50", record_count: "5" }),
          makeRollupRow({ id: "rollup-002", quantity: "30", record_count: "3" }),
        ],
        rowCount: 2,
      }));
      const repo = createMeteringRepository(executor);
      const result = await repo.getUsageSummary({
        orgId: ORG_ID,
        metric: "api_requests",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metric).toBe("api_requests");
        expect(result.value.totalQuantity).toBe(80);
        expect(result.value.totalRecords).toBe(8);
        expect(result.value.rollups).toHaveLength(2);
      }
    });

    it("requires orgId in query — always includes org_id = $1", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);
      await repo.getUsageSummary({ orgId: ORG_ID, metric: "api_requests" });

      expect(executor.calls[0]!.sql).toContain("org_id = $1");
      expect(executor.calls[0]!.params[0]).toBe(ORG_ID);
    });

    it("applies optional project/environment filters", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);
      await repo.getUsageSummary({
        orgId: ORG_ID,
        metric: "api_requests",
        projectId: PROJECT_ID,
        environmentId: ENV_ID,
      });

      const call = executor.calls[0]!;
      expect(call.sql).toContain("project_id = $3");
      expect(call.sql).toContain("environment_id = $4");
      expect(call.params).toContain(PROJECT_ID);
      expect(call.params).toContain(ENV_ID);
    });
  });

  describe("materializeUsageRollups", () => {
    const WIN_START = new Date("2026-03-15T11:00:00.000Z");
    const WIN_END = new Date("2026-03-15T13:00:00.000Z");

    it("aggregates raw usage into rollups grouped by org/project/env/metric/bucket", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 4 }));
      const repo = createMeteringRepository(executor);

      const result = await repo.materializeUsageRollups({
        bucketType: "hour",
        start: WIN_START,
        end: WIN_END,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bucketType).toBe("hour");
        expect(result.value.rollupsWritten).toBe(4);
        expect(result.value.windowStart).toEqual(WIN_START);
        expect(result.value.windowEnd).toEqual(WIN_END);
      }

      const call = executor.calls[0]!;
      // Grouping must include org_id + project_id + environment_id + metric + bucket
      expect(call.sql).toMatch(
        /GROUP BY\s+org_id,\s*project_id,\s*environment_id,\s*metric,\s*strftime/i,
      );
      // Window is parameter-bound, not interpolated
      expect(call.sql).toContain("recorded_at >= $2");
      expect(call.sql).toContain("recorded_at <  $3");
      expect(call.params[0]).toBe("hour");
      expect(call.params[1]).toBe(WIN_START.toISOString());
      expect(call.params[2]).toBe(WIN_END.toISOString());
    });

    it("supports both hour and day bucket types via the same seam", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);

      await repo.materializeUsageRollups({
        bucketType: "day",
        start: new Date("2026-03-14T00:00:00.000Z"),
        end: new Date("2026-03-16T00:00:00.000Z"),
      });

      expect(executor.calls[0]!.params[0]).toBe("day");
    });

    it("is idempotent — issues an INSERT ... ON CONFLICT ... DO UPDATE upsert", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);

      await repo.materializeUsageRollups({
        bucketType: "hour",
        start: WIN_START,
        end: WIN_END,
      });

      const sql = executor.calls[0]!.sql;
      expect(sql).toMatch(/INSERT INTO metering_usage_rollups/i);
      expect(sql).toMatch(/ON CONFLICT[\s\S]*DO UPDATE SET/i);
      // The conflict key must mirror the unique index on the table:
      // (org_id, COALESCE(project_id,''), COALESCE(environment_id,''), metric, bucket_type, bucket_start)
      expect(sql).toMatch(/ON CONFLICT[\s\S]*org_id[\s\S]*COALESCE\(project_id/i);
      expect(sql).toMatch(/ON CONFLICT[\s\S]*COALESCE\(environment_id/i);
      expect(sql).toMatch(/ON CONFLICT[\s\S]*metric[\s\S]*bucket_type[\s\S]*bucket_start/i);
      // Updated columns are the aggregate values + updated_at, not the id.
      expect(sql).toMatch(/quantity\s*=\s*EXCLUDED\.quantity/i);
      expect(sql).toMatch(/record_count\s*=\s*EXCLUDED\.record_count/i);
      expect(sql).toMatch(/updated_at\s*=\s*strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/i);
    });

    it("emits a deterministic id derived from the full aggregation key (org + project + env + metric + bucket_type + bucket_start)", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);

      await repo.materializeUsageRollups({
        bucketType: "hour",
        start: WIN_START,
        end: WIN_END,
      });

      const sql = executor.calls[0]!.sql;
      // The id IS the aggregation key — same inputs produce the same id on
      // re-run. (SQLite has no md5, and the key was already unique; hashing
      // only shortened it.)
      expect(sql).toMatch(/org_id\s*\|\|/i);
      expect(sql).toMatch(/COALESCE\(project_id,\s*''\)\s*\|\|/i);
      expect(sql).toMatch(/COALESCE\(environment_id,\s*''\)\s*\|\|/i);
      expect(sql).toMatch(/metric\s*\|\|/i);
      expect(sql).toMatch(/bucket_start AS id/i);
    });

    it("never aggregates across organizations — org_id is always in GROUP BY", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);

      await repo.materializeUsageRollups({
        bucketType: "hour",
        start: WIN_START,
        end: WIN_END,
      });

      const sql = executor.calls[0]!.sql;
      const groupBy = sql.match(/GROUP BY[^)]*\)?/i)?.[0] ?? "";
      expect(groupBy.toLowerCase()).toContain("org_id");
    });

    it("uses parameterized SQL only — window bounds are not interpolated", async () => {
      const executor = createMockExecutor((sql) => {
        expect(sql).not.toContain(WIN_START.toISOString());
        expect(sql).not.toContain(WIN_END.toISOString());
        return { rows: [], rowCount: 0 };
      });
      const repo = createMeteringRepository(executor);
      await repo.materializeUsageRollups({
        bucketType: "hour",
        start: WIN_START,
        end: WIN_END,
      });
    });

    it("rejects an invalid bucket_type without issuing SQL", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);
      const result = await repo.materializeUsageRollups({
        bucketType: "minute" as unknown as "hour",
        start: WIN_START,
        end: WIN_END,
      });
      expect(result.ok).toBe(false);
      expect(executor.calls).toHaveLength(0);
    });

    it("rejects an inverted/empty window without issuing SQL", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);
      const result = await repo.materializeUsageRollups({
        bucketType: "hour",
        start: WIN_END,
        end: WIN_START,
      });
      expect(result.ok).toBe(false);
      expect(executor.calls).toHaveLength(0);
    });

    it("returns a safe internal error on executor failure — no raw error leaked", async () => {
      const executor = createMockExecutor(() => {
        throw new Error("connection refused to host db.internal:5432");
      });
      const repo = createMeteringRepository(executor);
      const result = await repo.materializeUsageRollups({
        bucketType: "hour",
        start: WIN_START,
        end: WIN_END,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
        if (result.error.kind === "internal") {
          expect(result.error.message).not.toContain("db.internal");
          expect(result.error.message).not.toContain("connection refused");
        }
      }
    });
  });

  describe("listUsageRollups", () => {
    it("paginates rollups by org", async () => {
      const executor = createMockExecutor(() => ({
        rows: [makeRollupRow()],
        rowCount: 1,
      }));
      const repo = createMeteringRepository(executor);
      const result = await repo.listUsageRollups(ORG_ID, {
        limit: 10,
        cursor: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(1);
        expect(result.value.nextCursor).toBeNull();
      }
    });

    it("always requires orgId — first param is org_id", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);
      await repo.listUsageRollups(ORG_ID, { limit: 10, cursor: null });

      expect(executor.calls[0]!.sql).toContain("org_id = $1");
      expect(executor.calls[0]!.params[0]).toBe(ORG_ID);
    });
  });

  describe("checkQuota", () => {
    it("returns allowed=true with no_quota_defined when no quota exists", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);
      const result = await repo.checkQuota(ORG_ID, "api_requests");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.allowed).toBe(true);
        expect(result.value.limit).toBe(-1);
        expect(result.value.remaining).toBe(-1);
        expect(result.value.reason).toBe("no_quota_defined");
      }
    });

    it("returns allowed=true when usage is under limit", async () => {
      let callCount = 0;
      const executor = createMockExecutor(() => {
        callCount++;
        if (callCount === 1) {
          // Quota definition
          return {
            rows: [{
              id: "quota-001",
              org_id: ORG_ID,
              project_id: null,
              environment_id: null,
              resource_id: null,
              metric: "api_requests",
              limit_value: "1000",
              period: "month",
              enforcement: "soft",
              status: "active",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            }],
            rowCount: 1,
          };
        }
        // Usage sum
        return { rows: [{ total: "500" }], rowCount: 1 };
      });
      const repo = createMeteringRepository(executor);
      const result = await repo.checkQuota(ORG_ID, "api_requests");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.allowed).toBe(true);
        expect(result.value.limit).toBe(1000);
        expect(result.value.used).toBe(500);
        expect(result.value.remaining).toBe(500);
        expect(result.value.reason).toBeNull();
      }
    });

    it("returns allowed=false when usage exceeds limit", async () => {
      let callCount = 0;
      const executor = createMockExecutor(() => {
        callCount++;
        if (callCount === 1) {
          return {
            rows: [{
              id: "quota-001",
              org_id: ORG_ID,
              project_id: null,
              environment_id: null,
              resource_id: null,
              metric: "api_requests",
              limit_value: "1000",
              period: "month",
              enforcement: "hard",
              status: "active",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            }],
            rowCount: 1,
          };
        }
        return { rows: [{ total: "1500" }], rowCount: 1 };
      });
      const repo = createMeteringRepository(executor);
      const result = await repo.checkQuota(ORG_ID, "api_requests");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.allowed).toBe(false);
        expect(result.value.limit).toBe(1000);
        expect(result.value.used).toBe(1500);
        expect(result.value.remaining).toBe(0);
        expect(result.value.enforcement).toBe("hard");
        expect(result.value.reason).toBe("quota_exceeded");
      }
    });

    it("always requires orgId — SQL includes org_id = $1", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);
      await repo.checkQuota(ORG_ID, "api_requests");

      expect(executor.calls[0]!.sql).toContain("org_id = $1");
      expect(executor.calls[0]!.params[0]).toBe(ORG_ID);
    });

    it("returns structured facts — does not throw on exceeded quota", async () => {
      let callCount = 0;
      const executor = createMockExecutor(() => {
        callCount++;
        if (callCount === 1) {
          return {
            rows: [{
              id: "quota-001", org_id: ORG_ID, project_id: null, environment_id: null,
              resource_id: null, metric: "api_requests", limit_value: "100",
              period: "day", enforcement: "hard", status: "active",
              created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
            }],
            rowCount: 1,
          };
        }
        return { rows: [{ total: "200" }], rowCount: 1 };
      });
      const repo = createMeteringRepository(executor);

      // Should not throw
      const result = await repo.checkQuota(ORG_ID, "api_requests");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveProperty("allowed");
        expect(result.value).toHaveProperty("limit");
        expect(result.value).toHaveProperty("used");
        expect(result.value).toHaveProperty("remaining");
        expect(result.value).toHaveProperty("period");
        expect(result.value).toHaveProperty("enforcement");
        expect(result.value).toHaveProperty("reason");
      }
    });
  });

  describe("listQuotaViolations", () => {
    it("lists violations by org", async () => {
      const executor = createMockExecutor(() => ({
        rows: [makeViolationRow()],
        rowCount: 1,
      }));
      const repo = createMeteringRepository(executor);
      const result = await repo.listQuotaViolations(
        { orgId: ORG_ID },
        { limit: 10, cursor: null },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(1);
        const v = result.value.items[0]!;
        expect(v.orgId).toBe(ORG_ID);
        expect(v.metric).toBe("api_requests");
        expect(v.limitValue).toBe(1000);
        expect(v.actualValue).toBe(1050);
      }
    });

    it("applies optional project/environment/resource/metric filters", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);
      await repo.listQuotaViolations(
        {
          orgId: ORG_ID,
          projectId: PROJECT_ID,
          environmentId: ENV_ID,
          resourceId: "res-001",
          metric: "api_requests",
        },
        { limit: 10, cursor: null },
      );

      const call = executor.calls[0]!;
      expect(call.sql).toContain("org_id = $1");
      expect(call.sql).toContain("project_id = $2");
      expect(call.sql).toContain("environment_id = $3");
      expect(call.sql).toContain("resource_id = $4");
      expect(call.sql).toContain("metric = $5");
      expect(call.params).toContain(ORG_ID);
      expect(call.params).toContain(PROJECT_ID);
      expect(call.params).toContain(ENV_ID);
      expect(call.params).toContain("res-001");
      expect(call.params).toContain("api_requests");
    });

    it("always requires orgId — cannot query without it", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);
      await repo.listQuotaViolations(
        { orgId: ORG_ID },
        { limit: 10, cursor: null },
      );

      expect(executor.calls[0]!.sql).toContain("org_id = $1");
      expect(executor.calls[0]!.params[0]).toBe(ORG_ID);
    });
  });

  describe("SQL parameterization invariant", () => {
    it("no repository method interpolates user values into SQL text", async () => {
      const executor = createMockExecutor((sql) => {
        // Verify no raw org/project/env IDs appear in SQL text
        expect(sql).not.toContain(`'${ORG_ID}'`);
        expect(sql).not.toContain(`'${PROJECT_ID}'`);
        expect(sql).not.toContain(`'${ENV_ID}'`);
        return { rows: [makeUsageRow()], rowCount: 1 };
      });
      const repo = createMeteringRepository(executor);

      // Exercise all methods
      await repo.recordUsage(makeUsageInput({ projectId: PROJECT_ID, environmentId: ENV_ID }));
      await repo.getUsageSummary({ orgId: ORG_ID, metric: "api_requests", projectId: PROJECT_ID });
      await repo.listUsageRollups(ORG_ID, { limit: 10, cursor: null });
      await repo.listQuotaViolations({ orgId: ORG_ID, projectId: PROJECT_ID }, { limit: 10, cursor: null });
    });
  });

  describe("org scoping enforcement", () => {
    it("every query method includes orgId as a required SQL condition", async () => {
      const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
      const repo = createMeteringRepository(executor);

      // All these methods require orgId
      await repo.recordUsage(makeUsageInput());
      await repo.getUsageSummary({ orgId: ORG_ID, metric: "m" });
      await repo.listUsageRollups(ORG_ID, { limit: 10, cursor: null });
      await repo.checkQuota(ORG_ID, "m");
      await repo.listQuotaViolations({ orgId: ORG_ID }, { limit: 10, cursor: null });

      // Every single SQL call must reference org_id
      for (const call of executor.calls) {
        expect(call.sql.toLowerCase()).toContain("org_id");
      }
    });
  });
});
