-- 080_webhooks_core: Webhook persistence foundation
-- Creates the webhooks schema with endpoint, subscription, and delivery-attempt tables.
-- Idempotent: uses IF NOT EXISTS throughout for the D1 runner, which applies each statement on its own.
-- ── Webhook endpoints ──────────────────────────────────────
-- Organization-owned webhook endpoint metadata with optional project scope.
-- Signing secret material is never stored in plaintext; only encrypted envelope
-- and version metadata are persisted.

CREATE TABLE IF NOT EXISTS webhooks_webhook_endpoints (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id          TEXT NOT NULL,
  project_id      TEXT,
  url             TEXT NOT NULL,
  name            TEXT,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disabled', 'pending')),
  disabled_reason TEXT,
  disabled_at     TEXT,

  -- Signing secret metadata (no plaintext secret values)
  secret_version          INT NOT NULL DEFAULT 1,
  secret_ciphertext       TEXT,           -- encrypted envelope, write-only
  secret_last_rotated_at  TEXT,

  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Project-scoped endpoints must carry org_id + project_id
  CONSTRAINT chk_webhook_endpoint_project_scope
    CHECK (project_id IS NULL OR org_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org
  ON webhooks_webhook_endpoints (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org_project
  ON webhooks_webhook_endpoints (org_id, project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

-- ── Webhook subscriptions ──────────────────────────────────
-- Endpoint-bound event subscription configuration.
-- Each subscription binds an endpoint to an event type or pattern.

CREATE TABLE IF NOT EXISTS webhooks_webhook_subscriptions (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id          TEXT NOT NULL,
  endpoint_id     TEXT NOT NULL,
  project_id      TEXT,
  event_type      TEXT NOT NULL,         -- e.g. 'project.created', 'member.*'
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Project-scoped subscriptions must carry org_id + project_id
  CONSTRAINT chk_webhook_sub_project_scope
    CHECK (project_id IS NULL OR org_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_endpoint
  ON webhooks_webhook_subscriptions (endpoint_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_org
  ON webhooks_webhook_subscriptions (org_id, created_at DESC, id DESC);

-- Unique constraint: one subscription per endpoint + event_type + project scope
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_sub_endpoint_event
  ON webhooks_webhook_subscriptions (
    endpoint_id,
    event_type,
    COALESCE(project_id, '00000000-0000-0000-0000-000000000000')
  );

-- ── Webhook delivery attempts ──────────────────────────────
-- Safe delivery bookkeeping. Stores response metadata and safe failure reasons
-- only — no full event payloads or customer response bodies.

CREATE TABLE IF NOT EXISTS webhooks_webhook_delivery_attempts (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id            TEXT NOT NULL,
  endpoint_id       TEXT NOT NULL,
  subscription_id   TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'success', 'failed', 'retrying')),
  attempt_number    INT NOT NULL DEFAULT 1,
  http_status_code  INT,
  failure_reason    TEXT,              -- safe summary, no raw response body
  idempotency_key   TEXT,              -- deduplication key for retry safety
  next_retry_at     TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org
  ON webhooks_webhook_delivery_attempts (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
  ON webhooks_webhook_delivery_attempts (endpoint_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhooks_webhook_delivery_attempts (subscription_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event
  ON webhooks_webhook_delivery_attempts (event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_idempotency
  ON webhooks_webhook_delivery_attempts (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
