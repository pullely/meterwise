-- 130_webhook_secret_rotation_grace: dual-secret window for webhook signing-key rotation.
--
-- Context: webhooks
-- Spec: ai/tasks/task-0108.md (B5 webhook secret rotation grace)
--
-- Adds three nullable columns to webhooks_webhook_endpoints so that a rotated
-- endpoint can keep the previous signing secret around for a configurable
-- grace window. During that window the worker delivery loop attaches BOTH
-- the new signature (X-Webhook-Signature) and the previous-key signature
-- (X-Webhook-Signature-Previous), so receivers can roll forward without a
-- delivery gap.
--
-- Design rules:
--   * No backfill — existing rows keep previous_* NULL until the next rotate.
--   * No new secret material persistence shape: the previous ciphertext re-
--     uses the same envelope format as secret_ciphertext (write-only, never
--     returned through any read surface).
--   * Forward-only. SQLite (and therefore D1) has no `ADD COLUMN IF NOT
--     EXISTS` and takes one column per ALTER, so re-run safety comes from the
--     runner's applied-ledger rather than from the statement.
--   * No destructive change to existing columns or constraints.

ALTER TABLE webhooks_webhook_endpoints ADD COLUMN previous_secret_ciphertext TEXT;
ALTER TABLE webhooks_webhook_endpoints ADD COLUMN previous_secret_version INTEGER;
ALTER TABLE webhooks_webhook_endpoints ADD COLUMN previous_secret_expires_at TEXT;

-- column webhooks_webhook_endpoints.previous_secret_ciphertext: Encrypted envelope of the previous signing secret. Populated on rotate, never returned through any read surface. Cleared after previous_secret_expires_at lapses.

-- column webhooks_webhook_endpoints.previous_secret_version: Monotonic counter snapshot of secret_version at the moment of the most recent rotate (i.e. the version of the previous secret). NULL on endpoints that have never been rotated.

-- column webhooks_webhook_endpoints.previous_secret_expires_at: Wall-clock timestamp at which the previous-key dual-signature window closes. Worker delivery emits X-Webhook-Signature-Previous only while strftime('%Y-%m-%dT%H:%M:%fZ','now') < this value.
