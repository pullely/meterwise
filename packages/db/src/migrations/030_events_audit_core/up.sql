-- Events/audit persistence foundation.
-- Context: events
-- Idempotent: uses IF NOT EXISTS throughout.
-- schema events: Events bounded context — owns canonical event log and audit projections.

-- Canonical event log: one immutable row per event envelope.
CREATE TABLE IF NOT EXISTS events_event_log (
  id                TEXT        PRIMARY KEY,
  type              TEXT        NOT NULL,
  version           INTEGER     NOT NULL DEFAULT 1,
  source            TEXT        NOT NULL,
  occurred_at       TEXT NOT NULL,

  -- Actor
  actor_type        TEXT        NOT NULL,
  actor_id          TEXT        NOT NULL,
  actor_session_id  TEXT,
  actor_ip          TEXT,

  -- Tenant scope
  org_id            TEXT        NOT NULL,
  project_id        TEXT,
  environment_id    TEXT,

  -- Subject
  subject_kind      TEXT        NOT NULL,
  subject_id        TEXT        NOT NULL,
  subject_name      TEXT,

  -- Trace
  request_id        TEXT        NOT NULL,
  correlation_id    TEXT,
  causation_id      TEXT,
  idempotency_key   TEXT,

  -- Payload
  payload           TEXT       NOT NULL DEFAULT '{}',

  -- Audit redaction metadata
  redact_paths      TEXT       NOT NULL DEFAULT '[]',

  -- Metadata
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Organization + time index for scoped event queries.
CREATE INDEX IF NOT EXISTS event_log_org_occurred_idx
  ON events_event_log (org_id, occurred_at DESC, id DESC);

-- Idempotency key index for deduplication.
CREATE INDEX IF NOT EXISTS event_log_idempotency_key_idx
  ON events_event_log (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- table events_event_log: Canonical immutable event log — one row per event envelope.

-- Audit entry projection table: optimized for org-scoped and target-scoped queries.
CREATE TABLE IF NOT EXISTS events_audit_entries (
  id                TEXT        PRIMARY KEY,
  event_id          TEXT        NOT NULL REFERENCES events_event_log(id),
  org_id            TEXT        NOT NULL,
  project_id        TEXT,
  environment_id    TEXT,

  -- Actor
  actor_type        TEXT        NOT NULL,
  actor_id          TEXT        NOT NULL,

  -- Event reference
  event_type        TEXT        NOT NULL,
  event_version     INTEGER     NOT NULL DEFAULT 1,
  source            TEXT        NOT NULL,

  -- Subject (target of the action)
  subject_kind      TEXT        NOT NULL,
  subject_id        TEXT        NOT NULL,
  subject_name      TEXT,

  -- Classification
  category          TEXT        NOT NULL DEFAULT 'general',

  -- Human-readable description
  description       TEXT        NOT NULL DEFAULT '',

  -- Timing
  occurred_at       TEXT NOT NULL,

  -- Trace
  request_id        TEXT        NOT NULL,
  correlation_id    TEXT,

  -- Payload snapshot
  payload           TEXT       NOT NULL DEFAULT '{}',

  -- Redaction paths
  redact_paths      TEXT       NOT NULL DEFAULT '[]',

  -- Metadata
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Organization + time index for paged audit views.
CREATE INDEX IF NOT EXISTS audit_entries_org_occurred_idx
  ON events_audit_entries (org_id, occurred_at DESC, id DESC);

-- Target lookup index (subject kind + id within an org).
CREATE INDEX IF NOT EXISTS audit_entries_target_idx
  ON events_audit_entries (org_id, subject_kind, subject_id, occurred_at DESC, id DESC);

-- Category filter index.
CREATE INDEX IF NOT EXISTS audit_entries_category_idx
  ON events_audit_entries (org_id, category, occurred_at DESC, id DESC);

-- table events_audit_entries: Audit entry projection — immutable records optimized for org and target queries.
