-- Identity-owned service principals and API keys.
-- Context: identity
-- Idempotent: uses IF NOT EXISTS throughout.
-- No raw API-key secrets stored — only SHA-256 hash and public prefix.
-- Organization-bound; optional project scope carries explicit org_id + project_id.
-- No cross-context foreign keys to other bounded-context tables.

-- Service principals: org-bound automation actors.
CREATE TABLE IF NOT EXISTS identity_service_principals (
  id              TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  project_id      TEXT,
  display_name    TEXT        NOT NULL,
  description     TEXT,
  status          TEXT        NOT NULL DEFAULT 'active',
  created_by      TEXT        NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT service_principals_status_check CHECK (status IN ('active', 'suspended', 'deleted')),
  CONSTRAINT service_principals_project_scope_check CHECK (
    project_id IS NULL OR org_id IS NOT NULL
  )
);

-- Org lookup: list service principals for an organization.
CREATE INDEX IF NOT EXISTS service_principals_org_id_idx
  ON identity_service_principals (org_id, created_at DESC);

-- Project-scoped lookup.
CREATE INDEX IF NOT EXISTS service_principals_org_project_idx
  ON identity_service_principals (org_id, project_id)
  WHERE project_id IS NOT NULL;

-- table identity_service_principals: Organization-bound service principals — automation actors owned by identity context.
-- column identity_service_principals.org_id: Owning organization. Opaque reference — no cross-context FK.
-- column identity_service_principals.project_id: Optional project scope under the organization. Opaque reference — no cross-context FK.
-- column identity_service_principals.created_by: User who created this service principal. Opaque reference — no FK enforced at schema level.

-- API keys: belong to a service principal, org-scoped, secret-safe.
CREATE TABLE IF NOT EXISTS identity_api_keys (
  id                  TEXT        PRIMARY KEY,
  service_principal_id TEXT       NOT NULL REFERENCES identity_service_principals(id),
  org_id              TEXT        NOT NULL,
  key_prefix          TEXT        NOT NULL,
  key_hash            TEXT        NOT NULL,
  label               TEXT        NOT NULL DEFAULT '',
  status              TEXT        NOT NULL DEFAULT 'active',
  expires_at          TEXT,
  last_used_at        TEXT,
  revoked_at          TEXT,
  revoked_by          TEXT,
  created_by          TEXT        NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT api_keys_status_check CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT api_keys_prefix_length CHECK (length(key_prefix) >= 4 AND length(key_prefix) <= 12)
);

-- Unique hash index for auth-time lookup.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_idx
  ON identity_api_keys (key_hash);

-- Org-scoped listing.
CREATE INDEX IF NOT EXISTS api_keys_org_id_idx
  ON identity_api_keys (org_id, created_at DESC);

-- Service principal listing.
CREATE INDEX IF NOT EXISTS api_keys_service_principal_idx
  ON identity_api_keys (service_principal_id, created_at DESC);

-- Prefix lookup for key identification (e.g., display in admin UI).
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx
  ON identity_api_keys (key_prefix);

-- table identity_api_keys: API keys owned by identity context. Only hash and prefix stored — raw key material never persisted.
-- column identity_api_keys.key_prefix: Public prefix of the API key (e.g., spk_abc1) for display and identification. 4-12 chars.
-- column identity_api_keys.key_hash: SHA-256 hash of the full API key. Raw key never stored.
-- column identity_api_keys.org_id: Owning organization. Denormalized from service principal for efficient org-scoped queries. Opaque — no cross-context FK.
-- column identity_api_keys.revoked_by: User who revoked this key. Opaque reference.
