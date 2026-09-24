-- 090_webhooks_delivery: Webhook delivery runtime prerequisites
-- Adds the delivery idempotency constraint and dispatch cursor tracking.
-- Idempotent: uses IF NOT EXISTS throughout, so the D1 runner (which applies
-- each statement on its own) can re-run this file safely.

-- ── Delivery attempt event_id type ───────────────────────────
-- events_event_log.id is TEXT (a canonical event id, not a UUID), so
-- webhook_delivery_attempts.event_id is declared TEXT in migration 080. The
-- Postgres lineage of this baseline carried a type-fixing ALTER here; SQLite's
-- type affinity makes the column accept the canonical ids either way, and D1
-- has no ALTER COLUMN, so the fix lives at the point of creation instead.

-- ── Idempotency unique constraint ────────────────────────────
-- Prevents duplicate delivery attempts for the same subscription + event + attempt number.
-- ON CONFLICT (subscription_id, event_id, attempt_number) enables safe retry/replay.

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_delivery_sub_event_attempt
  ON webhooks_webhook_delivery_attempts (subscription_id, event_id, attempt_number);

-- ── Webhook dispatch cursor ──────────────────────────────────
-- Tracks the webhook subscriber lane's progress through the canonical event log.
-- Each org has its own cursor position. Progress advances only after delivery
-- work is durably recorded.

CREATE TABLE IF NOT EXISTS webhooks_webhook_dispatch_cursor (
  org_id          TEXT NOT NULL,
  subscriber_lane TEXT NOT NULL DEFAULT 'webhooks',
  last_event_id   TEXT,             -- last event_id successfully processed
  last_occurred_at TEXT,     -- last event occurred_at for cursor ordering
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  PRIMARY KEY (org_id, subscriber_lane)
);

-- ── Retryable delivery index ─────────────────────────────────
-- Supports efficient polling for delivery attempts needing retry.

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retryable
  ON webhooks_webhook_delivery_attempts (next_retry_at ASC, status)
  WHERE status = 'retrying' AND next_retry_at IS NOT NULL;

-- ── Subscription matching index ──────────────────────────────
-- Supports efficient fanout: find all enabled subscriptions for an org + event type.

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_fanout
  ON webhooks_webhook_subscriptions (org_id, event_type)
  WHERE enabled = 1;
