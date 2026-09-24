-- 120_notifications_core: Notifications persistence foundation.
-- Context: notifications
-- Spec: specs/components/14-notifications.md
--
-- Creates the notifications bounded-context schema with four tables that
-- collectively own:
--   * per-subject, per-channel preferences (user or organization scope),
--   * the canonical record of every enqueued notification,
--   * delivery attempts and their bounded outcomes,
--   * suppression state (bounce / complaint / manual / unsubscribe).
--
-- Design rules:
--   * Every notifications-owned row is tenant-scoped on org_id. There are
--     NO foreign keys back into other bounded contexts beyond the org/user
--     subject_id pattern already established elsewhere — subject_id is an
--     opaque identifier, not a FK to identity_users.
--   * Recipient addresses are stored lower-cased so suppression lookup is
--     case-insensitive (mirrors membership_organization_invitations).
--   * No secret material: no API tokens, no magic-link codes, no raw
--     provider payloads. template_data is bounded substitution scaffold
--     only and MUST NOT contain credentials.
--   * provider_message_id is an opaque, provider-issued reference for
--     operator traceability; it is never a credential.
--   * Idempotent: CREATE SCHEMA/TABLE/INDEX IF NOT EXISTS throughout for
--     the D1 runner. No destructive rewrites.

-- ── Schema ─────────────────────────────────────────────────
-- schema notifications: Notifications bounded context — owns user/org preferences, delivery records, delivery attempts, and recipient suppression. Provider-specific state never leaks beyond the local NotificationProvider adapter.

-- ── Preferences ────────────────────────────────────────────
-- Subject can be a user or an organization. categories is a bounded
-- TEXT map of category -> boolean (true = opted-in, false = opted-out).
-- Absent keys mean "not configured" and call sites should treat that as
-- the default (opt-in for transactional categories).

CREATE TABLE IF NOT EXISTS notifications_notification_preferences (
  id              TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  subject_kind    TEXT        NOT NULL,
  subject_id      TEXT        NOT NULL,
  channel         TEXT        NOT NULL,
  categories      TEXT       NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT notification_prefs_subject_kind_check
    CHECK (subject_kind IN ('user', 'organization')),
  CONSTRAINT notification_prefs_channel_check
    CHECK (channel IN ('email'))
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_prefs_subject_channel_idx
  ON notifications_notification_preferences (org_id, subject_kind, subject_id, channel);

CREATE INDEX IF NOT EXISTS notification_prefs_org_idx
  ON notifications_notification_preferences (org_id);

-- table notifications_notification_preferences: Per-subject, per-channel notification preferences. subject_id is an opaque identifier (no FK into identity / membership). Org-scoped via org_id.

-- column notifications_notification_preferences.categories: Bounded TEXT map { category: boolean }. Categories: invitation, billing, security, support, product. MUST NOT contain credential material.

-- ── Notifications ──────────────────────────────────────────
-- One row per enqueued notification. status reflects the latest lifecycle
-- state across delivery attempts. recipient_address is stored lower-cased
-- so suppression matches are case-insensitive.

CREATE TABLE IF NOT EXISTS notifications_notifications (
  id                    TEXT        PRIMARY KEY,
  org_id                TEXT        NOT NULL,
  category              TEXT        NOT NULL,
  template_key          TEXT        NOT NULL,
  template_data         TEXT       NOT NULL DEFAULT '{}',
  channel               TEXT        NOT NULL,
  recipient_address     TEXT        NOT NULL,
  recipient_subject_kind TEXT,
  recipient_subject_id  TEXT,
  status                TEXT        NOT NULL DEFAULT 'queued',
  provider_message_id   TEXT,
  last_error            TEXT,
  idempotency_key       TEXT,
  correlation_id        TEXT,
  queued_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at               TEXT,
  failed_at             TEXT,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT notifications_status_check
    CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
  CONSTRAINT notifications_channel_check
    CHECK (channel IN ('email')),
  CONSTRAINT notifications_category_check
    CHECK (category IN ('invitation', 'billing', 'security', 'support', 'product')),
  CONSTRAINT notifications_recipient_subject_kind_check
    CHECK (recipient_subject_kind IS NULL OR recipient_subject_kind IN ('user', 'organization'))
);

CREATE INDEX IF NOT EXISTS notifications_org_idx
  ON notifications_notifications (org_id);

CREATE INDEX IF NOT EXISTS notifications_org_status_idx
  ON notifications_notifications (org_id, status);

CREATE INDEX IF NOT EXISTS notifications_org_recipient_idx
  ON notifications_notifications (org_id, channel, recipient_address);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_idempotency_idx
  ON notifications_notifications (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- table notifications_notifications: Canonical notification records. One row per enqueue. Tenant-scoped on org_id. template_data carries redaction-safe substitutions only; no secrets.

-- column notifications_notifications.provider_message_id: Opaque provider-issued reference for operator traceability. Never a credential.

-- column notifications_notifications.template_data: Bounded substitution scaffold (string/number/boolean/null values). MUST NOT contain bearer tokens, API keys, magic-link codes, or other secret material.

-- column notifications_notifications.last_error: Bounded human-readable failure reason. Provider payloads MUST be scrubbed.

-- ── Notification attempts ──────────────────────────────────
-- Per-attempt audit trail for a notification. V1 ships with a synchronous
-- single-attempt local-debug provider; retries are a follow-up.

CREATE TABLE IF NOT EXISTS notifications_notification_attempts (
  id                  TEXT        PRIMARY KEY,
  notification_id     TEXT        NOT NULL,
  org_id              TEXT        NOT NULL,
  attempt_number      INTEGER     NOT NULL,
  status              TEXT        NOT NULL,
  provider_message_id TEXT,
  error_reason        TEXT,
  attempted_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT notification_attempts_status_check
    CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
  CONSTRAINT notification_attempts_number_check
    CHECK (attempt_number >= 1)
);

CREATE INDEX IF NOT EXISTS notification_attempts_notification_idx
  ON notifications_notification_attempts (notification_id, attempt_number);

CREATE INDEX IF NOT EXISTS notification_attempts_org_idx
  ON notifications_notification_attempts (org_id);

CREATE UNIQUE INDEX IF NOT EXISTS notification_attempts_unique_idx
  ON notifications_notification_attempts (notification_id, attempt_number);

-- table notifications_notification_attempts: Per-attempt audit trail. attempt_number is 1-indexed. Bounded error_reason; never raw provider payloads.

-- ── Suppressions ───────────────────────────────────────────
-- Per-org, per-channel recipient suppression list. Used to short-circuit
-- enqueue when a recipient has bounced, complained, or unsubscribed.

CREATE TABLE IF NOT EXISTS notifications_notification_suppressions (
  id              TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  channel         TEXT        NOT NULL,
  address         TEXT        NOT NULL,
  reason          TEXT        NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT notification_suppressions_channel_check
    CHECK (channel IN ('email')),
  CONSTRAINT notification_suppressions_reason_check
    CHECK (reason IN ('bounce', 'complaint', 'manual', 'unsubscribe'))
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_suppressions_unique_idx
  ON notifications_notification_suppressions (org_id, channel, address);

CREATE INDEX IF NOT EXISTS notification_suppressions_org_idx
  ON notifications_notification_suppressions (org_id);

-- table notifications_notification_suppressions: Per-org recipient suppression list. address is stored lower-cased.
