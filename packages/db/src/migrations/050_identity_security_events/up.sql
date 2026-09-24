-- Identity-owned security-event source facts.
-- Context: identity
-- Idempotent: uses IF NOT EXISTS throughout.
-- Pre-organization: user_id is nullable; no org_id required.

CREATE TABLE IF NOT EXISTS identity_security_events (
  id                TEXT        PRIMARY KEY,
  event_type        TEXT        NOT NULL,
  outcome           TEXT        NOT NULL,

  -- Actor / subject references (opaque, no cross-context FKs)
  user_id           TEXT,
  session_id        TEXT,
  challenge_id      TEXT,

  -- Trace
  request_id        TEXT,
  correlation_id    TEXT,

  -- Client context
  ip                TEXT,
  user_agent        TEXT,

  -- Timing
  occurred_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Flexible payload and compliance redaction
  metadata          TEXT       NOT NULL DEFAULT '{}',
  redact_paths      TEXT       NOT NULL DEFAULT '[]'
);

-- User + time index for cursor-paginated security history queries.
CREATE INDEX IF NOT EXISTS security_events_user_occurred_idx
  ON identity_security_events (user_id, occurred_at DESC, id DESC);

-- Event type + time index for type-filtered queries.
CREATE INDEX IF NOT EXISTS security_events_event_type_idx
  ON identity_security_events (event_type, occurred_at DESC);

-- Request ID index for trace correlation lookups.
CREATE INDEX IF NOT EXISTS security_events_request_id_idx
  ON identity_security_events (request_id) WHERE request_id IS NOT NULL;

-- table identity_security_events: Identity-owned security-event source facts — pre-organization user activity log.
