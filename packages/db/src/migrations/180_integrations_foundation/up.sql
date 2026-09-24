-- 180_integrations_foundation: Integrations persistence foundation (IG0).
--
-- Context: integrations
-- Epic: saas-integrations (IG0) — the dormant contract-and-schema slice for
--       the pluggable integrations platform (GitHub App first). No live
--       behavior rides on this migration; it lands the bounded context's
--       tables so IG1+ (connect flow, inbound events, repo links, token
--       broker) are schema-complete from day one.
--
-- Design rules (see specs/epics/saas-integrations/design.md §3):
--   * Every tenant-owned table carries org_id TEXT NOT NULL; the one
--     exception is inbound_deliveries, whose org_id stays NULL until the
--     cron drain attributes the delivery (installation → connection → org).
--   * Keyset pagination indexes (org_id, created_at DESC, id DESC).
--   * Platform credentials (App private key, webhook secret, client
--     id/secret) are NOT rows — they are per-environment worker secrets.
--   * Cached installation tokens are AES-256-GCM envelopes, write-only;
--     never logged, never returned by list/read APIs.
--   * Idempotent: IF NOT EXISTS throughout for re-apply safety.
-- ── Connections ────────────────────────────────────────────
-- Provider-agnostic org ↔ provider connection (a GitHub App installation
-- bound to an organization). The signed-state nonce for the in-flight
-- connect flow is persisted (hashed) on the pending row and cleared on
-- activation — the tenancy keystone (design §4) is carried by our state,
-- never inferred from the provider redirect.

CREATE TABLE IF NOT EXISTS integrations_connections (
  id                      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id                  TEXT NOT NULL,
  provider                TEXT NOT NULL,          -- registry-driven: 'github' first
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
  display_name            TEXT,
  external_account_login  TEXT,
  external_account_id     TEXT,
  external_account_type   TEXT,                   -- GitHub: 'Organization' | 'User'
  created_by              TEXT,                   -- actor public id

  -- Connect-flow state (write-only; hash of the single-use signed nonce)
  state_nonce_hash        TEXT,
  state_expires_at        TEXT,

  connected_at            TEXT,
  suspended_at            TEXT,
  revoked_at              TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_integrations_connections_org
  ON integrations_connections (org_id, created_at DESC, id DESC);

-- One ACTIVE connection per (org, provider, provider account)
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_connection_active_account
  ON integrations_connections (org_id, provider, external_account_id)
  WHERE status = 'active' AND external_account_id IS NOT NULL;

-- Connect-flow nonce lookup (sparse: only pending rows carry a nonce)
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_connection_state_nonce
  ON integrations_connections (state_nonce_hash)
  WHERE state_nonce_hash IS NOT NULL;

-- ── GitHub installations ───────────────────────────────────
-- Provider-specific facts behind a connection. connection_id is NULL for
-- orphaned installations (unsolicited installs with no valid state) — they
-- are recorded, admin-visible, and never auto-bound to a tenant (fail
-- closed, design §4).

CREATE TABLE IF NOT EXISTS integrations_github_installations (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  connection_id         TEXT,                     -- NULL = orphaned installation
  installation_id       BIGINT NOT NULL,          -- GitHub installation id
  account_login         TEXT,
  account_id            BIGINT,
  account_type          TEXT,                     -- 'Organization' | 'User'
  repository_selection  TEXT,                     -- 'all' | 'selected'
  permissions           TEXT,                    -- App grant snapshot
  events                TEXT,                    -- subscribed webhook events
  suspended_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_github_installation
  ON integrations_github_installations (installation_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_github_installation_connection
  ON integrations_github_installations (connection_id)
  WHERE connection_id IS NOT NULL;

-- ── Repo links ─────────────────────────────────────────────
-- repo ↔ project with branch → environment mapping. A plain org/project-
-- scoped record now; forward-compatible with re-projection as a manifested
-- resource when P2 lands (the moat consumes the link; it does not own it).

CREATE TABLE IF NOT EXISTS integrations_repo_links (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  connection_id     TEXT NOT NULL,
  repo_external_id  TEXT NOT NULL,                -- provider repo id (GitHub numeric id)
  repo_full_name    TEXT NOT NULL,                -- e.g. 'acme/storefront'
  default_branch    TEXT,
  branch_env_map    TEXT NOT NULL DEFAULT '{}',  -- {"main":"prod","staging":"stage"}
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'unlinked')),
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_integrations_repo_links_org
  ON integrations_repo_links (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_integrations_repo_links_project
  ON integrations_repo_links (org_id, project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_integrations_repo_links_connection
  ON integrations_repo_links (connection_id, created_at DESC, id DESC);

-- One ACTIVE link per (project, provider repo); historical unlinked rows remain
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_repo_link_project_repo
  ON integrations_repo_links (project_id, repo_external_id)
  WHERE status = 'active';

-- Event-enrichment lookup: which active links match an inbound repo id
CREATE INDEX IF NOT EXISTS idx_integrations_repo_links_repo
  ON integrations_repo_links (repo_external_id)
  WHERE status = 'active';

-- ── Inbound deliveries ─────────────────────────────────────
-- The durable inbox: both the idempotency ledger (delivery_key UNIQUE per
-- provider — GitHub's X-GitHub-Delivery) and the cron work queue. org_id is
-- NULL until the drain attributes the delivery; emission into event_log is
-- transactional with the 'emitted' mark (exactly-once by construction).

CREATE TABLE IF NOT EXISTS integrations_inbound_deliveries (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id            TEXT,                         -- NULL until attributed
  provider          TEXT NOT NULL,
  delivery_key      TEXT NOT NULL,                -- provider delivery id (idempotency key)
  event_type        TEXT NOT NULL,                -- provider event, e.g. 'push'
  action            TEXT,                         -- provider action, e.g. 'opened'
  payload           TEXT NOT NULL,               -- raw provider payload (admin-only)
  signature_ok      INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'attributed', 'emitted', 'skipped', 'failed')),
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,
  failure_reason    TEXT,                         -- safe summary only
  emitted_event_id  TEXT,                         -- event_log id once emitted
  received_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_inbound_delivery_key
  ON integrations_inbound_deliveries (provider, delivery_key);

-- Org-scoped delivery log (sparse until attribution)
CREATE INDEX IF NOT EXISTS idx_integrations_inbound_deliveries_org
  ON integrations_inbound_deliveries (org_id, received_at DESC, id DESC)
  WHERE org_id IS NOT NULL;

-- Cron drain scan: pending work ordered by arrival
CREATE INDEX IF NOT EXISTS idx_integrations_inbound_deliveries_pending
  ON integrations_inbound_deliveries (status, next_attempt_at, received_at)
  WHERE status IN ('received', 'attributed');

-- ── Installation token cache ───────────────────────────────
-- Cache for the platform's OWN provider calls (repo listing, connection
-- health). Brokered tenant tokens are always minted fresh and never cached.
-- token_ciphertext is an AES-256-GCM envelope — write-only, never logged,
-- never exposed through list/read APIs.

CREATE TABLE IF NOT EXISTS integrations_installation_tokens (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  connection_id     TEXT NOT NULL,
  token_ciphertext  TEXT NOT NULL,
  permissions       TEXT,
  repository_ids    TEXT,
  expires_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_installation_token_connection
  ON integrations_installation_tokens (connection_id);
