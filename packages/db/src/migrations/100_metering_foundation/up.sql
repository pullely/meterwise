-- 100_metering_foundation: Metering persistence foundation
-- Creates the metering bounded-context schema with durable storage for raw usage
-- records, usage rollups, quota definitions, and quota violation history.
-- Idempotent: uses IF NOT EXISTS / DO NOTHING throughout for the D1 runner, which applies each statement on its own.

-- ── Schema ─────────────────────────────────────────────────
-- schema metering: Metering bounded context — usage ingestion, rollups, quota state, and violation history. Owns usage facts and policy inputs. Billing consumes metering outputs, not the reverse.

-- ── Raw usage records ──────────────────────────────────────
-- Each row is an immutable usage fact recorded by the metering worker or ingestion API.
-- Idempotency is enforced per org via (org_id, idempotency_key).
-- org_id references membership_organizations(id) by opaque ID — no FK.
-- project_id, environment_id, and resource_id are optional scoping dimensions.

CREATE TABLE IF NOT EXISTS metering_usage_records (
  id               TEXT        NOT NULL,
  org_id           TEXT        NOT NULL,
  project_id       TEXT,                   -- opaque ref to projects_projects(id)
  environment_id   TEXT,                   -- opaque ref to projects_environments(id)
  resource_id      TEXT,                   -- opaque resource identifier (e.g. worker ID, page ID)
  metric           TEXT        NOT NULL,   -- usage metric key (e.g. 'api_requests', 'build_minutes')
  quantity         BIGINT      NOT NULL DEFAULT 1,
  idempotency_key  TEXT        NOT NULL,   -- caller-provided dedup key, unique per org
  recorded_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  metadata         TEXT,                  -- bounded safe metadata (no secrets, tokens, credentials)
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  PRIMARY KEY (id),

  -- Scope invariant: project/environment/resource never usable without org
  CONSTRAINT chk_usage_org_scope CHECK (
    (project_id IS NULL OR org_id IS NOT NULL) AND
    (environment_id IS NULL OR project_id IS NOT NULL) AND
    (resource_id IS NULL OR org_id IS NOT NULL)
  )
);

-- table metering_usage_records: Immutable raw usage facts. Each record is an atomic usage event with exactly-once insert semantics enforced by (org_id, idempotency_key) uniqueness.

-- column metering_usage_records.metadata: Bounded safe metadata only — must never contain bearer tokens, API keys, provider credentials, connection strings, webhook signing secrets, or plaintext secret material.

-- Idempotency: unique per org + idempotency key
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_org_idempotency
  ON metering_usage_records (org_id, idempotency_key);

-- Query by org + metric + time range
CREATE INDEX IF NOT EXISTS idx_usage_org_metric_time
  ON metering_usage_records (org_id, metric, recorded_at DESC);

-- Query by org + project
CREATE INDEX IF NOT EXISTS idx_usage_org_project
  ON metering_usage_records (org_id, project_id)
  WHERE project_id IS NOT NULL;

-- ── Usage rollups ──────────────────────────────────────────
-- Pre-aggregated usage summaries by org/project/environment, metric, and time bucket.
-- Rollups are created by a metering worker (future task) from raw usage records.

CREATE TABLE IF NOT EXISTS metering_usage_rollups (
  id               TEXT        NOT NULL,
  org_id           TEXT        NOT NULL,
  project_id       TEXT,
  environment_id   TEXT,
  metric           TEXT        NOT NULL,
  bucket_type      TEXT        NOT NULL,   -- 'hour' or 'day'
  bucket_start     TEXT NOT NULL,   -- start of the time bucket
  quantity         BIGINT      NOT NULL DEFAULT 0,
  record_count     BIGINT      NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  PRIMARY KEY (id),

  CONSTRAINT chk_rollup_bucket_type CHECK (bucket_type IN ('hour', 'day')),

  CONSTRAINT chk_rollup_org_scope CHECK (
    (project_id IS NULL OR org_id IS NOT NULL) AND
    (environment_id IS NULL OR project_id IS NOT NULL)
  )
);

-- table metering_usage_rollups: Pre-aggregated usage summaries by time bucket. Produced by the metering worker from raw usage records. Queryable by org, optional project/environment, metric, and time range.

-- Upsert-safe: one rollup per org/project/env/metric/bucket
CREATE UNIQUE INDEX IF NOT EXISTS uq_rollup_dimensions
  ON metering_usage_rollups (
    org_id,
    COALESCE(project_id, ''),
    COALESCE(environment_id, ''),
    metric,
    bucket_type,
    bucket_start
  );

-- Query rollups by org + metric + time range
CREATE INDEX IF NOT EXISTS idx_rollup_org_metric_bucket
  ON metering_usage_rollups (org_id, metric, bucket_type, bucket_start DESC);

-- ── Quota definitions ──────────────────────────────────────
-- Policy-facing quota limits. Each quota binds a metric to a numeric limit
-- for a given org (and optionally project/environment/resource).
-- Billing/plan integration will set these in a later task; metering only reads them.

CREATE TABLE IF NOT EXISTS metering_quota_definitions (
  id               TEXT        NOT NULL,
  org_id           TEXT        NOT NULL,
  project_id       TEXT,
  environment_id   TEXT,
  resource_id      TEXT,
  metric           TEXT        NOT NULL,
  limit_value      BIGINT      NOT NULL,   -- maximum allowed quantity per period
  period           TEXT        NOT NULL,    -- 'hour', 'day', 'month', 'billing_cycle'
  enforcement      TEXT        NOT NULL DEFAULT 'soft',  -- 'soft' (warn) or 'hard' (block)
  status           TEXT        NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  PRIMARY KEY (id),

  CONSTRAINT chk_quota_period CHECK (period IN ('hour', 'day', 'month', 'billing_cycle')),
  CONSTRAINT chk_quota_enforcement CHECK (enforcement IN ('soft', 'hard')),
  CONSTRAINT chk_quota_status CHECK (status IN ('active', 'inactive')),

  CONSTRAINT chk_quota_org_scope CHECK (
    (project_id IS NULL OR org_id IS NOT NULL) AND
    (environment_id IS NULL OR project_id IS NOT NULL) AND
    (resource_id IS NULL OR org_id IS NOT NULL)
  )
);

-- table metering_quota_definitions: Policy-facing quota limits binding metrics to numeric thresholds per period. Metering reads these for checkQuota; billing/plan integration sets them in a later task.

-- One active quota per org/project/env/resource/metric/period
CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_dimensions
  ON metering_quota_definitions (
    org_id,
    COALESCE(project_id, ''),
    COALESCE(environment_id, ''),
    COALESCE(resource_id, ''),
    metric,
    period
  )
  WHERE status = 'active';

-- Query quotas by org + metric
CREATE INDEX IF NOT EXISTS idx_quota_org_metric
  ON metering_quota_definitions (org_id, metric)
  WHERE status = 'active';

-- ── Quota violations ───────────────────────────────────────
-- Historical log of quota threshold crossings. Each violation records the
-- moment a usage metric exceeded a quota definition's limit.

CREATE TABLE IF NOT EXISTS metering_quota_violations (
  id               TEXT        NOT NULL,
  org_id           TEXT        NOT NULL,
  project_id       TEXT,
  environment_id   TEXT,
  resource_id      TEXT,
  quota_id         TEXT        NOT NULL,   -- opaque ref to quota_definitions(id)
  metric           TEXT        NOT NULL,
  limit_value      BIGINT      NOT NULL,   -- the limit at time of violation
  actual_value     BIGINT      NOT NULL,   -- the usage value that exceeded the limit
  period           TEXT        NOT NULL,
  enforcement      TEXT        NOT NULL,   -- enforcement mode at time of violation
  violated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at      TEXT,            -- null until violation is cleared
  metadata         TEXT,                  -- safe context (no secrets)
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  PRIMARY KEY (id),

  CONSTRAINT chk_violation_period CHECK (period IN ('hour', 'day', 'month', 'billing_cycle')),
  CONSTRAINT chk_violation_enforcement CHECK (enforcement IN ('soft', 'hard')),

  CONSTRAINT chk_violation_org_scope CHECK (
    (project_id IS NULL OR org_id IS NOT NULL) AND
    (environment_id IS NULL OR project_id IS NOT NULL) AND
    (resource_id IS NULL OR org_id IS NOT NULL)
  )
);

-- table metering_quota_violations: Historical record of quota threshold crossings. Each violation captures the limit, actual usage, and enforcement mode at the time of breach.

-- column metering_quota_violations.metadata: Safe violation context only — must never contain bearer tokens, API keys, provider credentials, connection strings, webhook signing secrets, or plaintext secret material.

-- List violations by org (required) + optional dimensions
CREATE INDEX IF NOT EXISTS idx_violation_org_time
  ON metering_quota_violations (org_id, violated_at DESC);

CREATE INDEX IF NOT EXISTS idx_violation_org_metric
  ON metering_quota_violations (org_id, metric, violated_at DESC);

CREATE INDEX IF NOT EXISTS idx_violation_quota
  ON metering_quota_violations (quota_id, violated_at DESC);
