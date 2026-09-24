-- 070_config_settings_flags
-- Config persistence foundation — settings, feature flags, and secret metadata
-- Bounded context: config
-- Idempotent: uses IF NOT EXISTS throughout.
-- No plaintext secret values stored — only key metadata and ciphertext envelope placeholders.
-- Scoped at organization, project, and environment levels with explicit scope columns.
-- No cross-context foreign keys to membership or projects schemas.
-- schema config: Config bounded context — owns settings, feature flags, and secret metadata persistence.

-- ============================================================
-- Settings: scoped non-secret JSON configuration values.
-- scope_kind determines which scope columns are populated.
-- ============================================================

CREATE TABLE IF NOT EXISTS config_settings (
  id              TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  project_id      TEXT,
  environment_id  TEXT,
  scope_kind      TEXT        NOT NULL,
  key             TEXT        NOT NULL,
  value           TEXT       NOT NULL DEFAULT '{}',
  description     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT settings_scope_kind_check CHECK (scope_kind IN ('organization', 'project', 'environment')),

  -- Organization scope: only org_id set
  CONSTRAINT settings_org_scope_check CHECK (
    scope_kind <> 'organization' OR (project_id IS NULL AND environment_id IS NULL)
  ),
  -- Project scope: org_id + project_id set, no environment_id
  CONSTRAINT settings_project_scope_check CHECK (
    scope_kind <> 'project' OR (project_id IS NOT NULL AND environment_id IS NULL)
  ),
  -- Environment scope: all three IDs set
  CONSTRAINT settings_env_scope_check CHECK (
    scope_kind <> 'environment' OR (project_id IS NOT NULL AND environment_id IS NOT NULL)
  )
);

-- Unique key per scope tuple
CREATE UNIQUE INDEX IF NOT EXISTS settings_scope_key_idx
  ON config_settings (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), key);

-- Org-scoped listing
CREATE INDEX IF NOT EXISTS settings_org_created_idx
  ON config_settings (org_id, created_at DESC, id DESC);

-- Project-scoped listing
CREATE INDEX IF NOT EXISTS settings_org_project_created_idx
  ON config_settings (org_id, project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

-- Environment-scoped listing
CREATE INDEX IF NOT EXISTS settings_org_project_env_created_idx
  ON config_settings (org_id, project_id, environment_id, created_at DESC, id DESC)
  WHERE environment_id IS NOT NULL;

-- table config_settings: Scoped non-secret settings. Every query must scope by org_id.
-- column config_settings.org_id: Owning organization — opaque reference, no cross-context FK.
-- column config_settings.project_id: Optional project scope — opaque reference, no cross-context FK.
-- column config_settings.environment_id: Optional environment scope — opaque reference, no cross-context FK.
-- column config_settings.scope_kind: Discriminator: organization, project, or environment.
-- column config_settings.key: Setting key within the scope.
-- column config_settings.value: Non-secret TEXT payload.

-- ============================================================
-- Feature flags: scoped flag definitions with default state.
-- ============================================================

CREATE TABLE IF NOT EXISTS config_feature_flags (
  id              TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  project_id      TEXT,
  environment_id  TEXT,
  scope_kind      TEXT        NOT NULL,
  flag_key        TEXT        NOT NULL,
  enabled         INTEGER     NOT NULL DEFAULT 0,
  value           TEXT,
  description     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT feature_flags_scope_kind_check CHECK (scope_kind IN ('organization', 'project', 'environment')),

  CONSTRAINT feature_flags_org_scope_check CHECK (
    scope_kind <> 'organization' OR (project_id IS NULL AND environment_id IS NULL)
  ),
  CONSTRAINT feature_flags_project_scope_check CHECK (
    scope_kind <> 'project' OR (project_id IS NOT NULL AND environment_id IS NULL)
  ),
  CONSTRAINT feature_flags_env_scope_check CHECK (
    scope_kind <> 'environment' OR (project_id IS NOT NULL AND environment_id IS NOT NULL)
  )
);

-- Unique flag key per scope tuple
CREATE UNIQUE INDEX IF NOT EXISTS feature_flags_scope_key_idx
  ON config_feature_flags (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), flag_key);

-- Org-scoped listing
CREATE INDEX IF NOT EXISTS feature_flags_org_created_idx
  ON config_feature_flags (org_id, created_at DESC, id DESC);

-- Project-scoped listing
CREATE INDEX IF NOT EXISTS feature_flags_org_project_created_idx
  ON config_feature_flags (org_id, project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

-- Environment-scoped listing
CREATE INDEX IF NOT EXISTS feature_flags_org_project_env_created_idx
  ON config_feature_flags (org_id, project_id, environment_id, created_at DESC, id DESC)
  WHERE environment_id IS NOT NULL;

-- table config_feature_flags: Scoped feature flag definitions. Every query must scope by org_id.
-- column config_feature_flags.flag_key: Unique flag key within the scope.
-- column config_feature_flags.enabled: Default enabled/disabled state.
-- column config_feature_flags.value: Optional TEXT payload for flag variants or metadata.

-- ============================================================
-- Secret metadata: key metadata, status, version/rotation info.
-- NEVER stores plaintext secret values.
-- An optional ciphertext_envelope column holds encrypted data.
-- ============================================================

CREATE TABLE IF NOT EXISTS config_secret_metadata (
  id                  TEXT        PRIMARY KEY,
  org_id              TEXT        NOT NULL,
  project_id          TEXT,
  environment_id      TEXT,
  scope_kind          TEXT        NOT NULL,
  secret_key          TEXT        NOT NULL,
  display_name        TEXT,
  status              TEXT        NOT NULL DEFAULT 'active',
  version             INTEGER     NOT NULL DEFAULT 1,
  ciphertext_envelope BYTEA,
  rotation_policy     TEXT,
  last_rotated_at     TEXT,
  expires_at          TEXT,
  created_by          TEXT        NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT secret_metadata_scope_kind_check CHECK (scope_kind IN ('organization', 'project', 'environment')),
  CONSTRAINT secret_metadata_status_check CHECK (status IN ('active', 'rotated', 'revoked')),

  CONSTRAINT secret_metadata_org_scope_check CHECK (
    scope_kind <> 'organization' OR (project_id IS NULL AND environment_id IS NULL)
  ),
  CONSTRAINT secret_metadata_project_scope_check CHECK (
    scope_kind <> 'project' OR (project_id IS NOT NULL AND environment_id IS NULL)
  ),
  CONSTRAINT secret_metadata_env_scope_check CHECK (
    scope_kind <> 'environment' OR (project_id IS NOT NULL AND environment_id IS NOT NULL)
  ),
  CONSTRAINT secret_metadata_version_positive CHECK (version >= 1)
);

-- Unique secret key per scope tuple (only active/rotated — revoked are historical)
CREATE UNIQUE INDEX IF NOT EXISTS secret_metadata_scope_key_idx
  ON config_secret_metadata (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), secret_key)
  WHERE status IN ('active', 'rotated');

-- Org-scoped listing
CREATE INDEX IF NOT EXISTS secret_metadata_org_created_idx
  ON config_secret_metadata (org_id, created_at DESC, id DESC);

-- Project-scoped listing
CREATE INDEX IF NOT EXISTS secret_metadata_org_project_created_idx
  ON config_secret_metadata (org_id, project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

-- Environment-scoped listing
CREATE INDEX IF NOT EXISTS secret_metadata_org_project_env_created_idx
  ON config_secret_metadata (org_id, project_id, environment_id, created_at DESC, id DESC)
  WHERE environment_id IS NOT NULL;

-- table config_secret_metadata: Secret metadata records. NEVER contains plaintext secret values. Ciphertext envelope is encrypted data only.
-- column config_secret_metadata.org_id: Owning organization — opaque reference, no cross-context FK.
-- column config_secret_metadata.project_id: Optional project scope — opaque reference, no cross-context FK.
-- column config_secret_metadata.environment_id: Optional environment scope — opaque reference, no cross-context FK.
-- column config_secret_metadata.secret_key: Identifier for this secret within its scope.
-- column config_secret_metadata.ciphertext_envelope: Encrypted secret payload — NEVER plaintext. Null until an encryption adapter writes it.
-- column config_secret_metadata.version: Monotonically increasing version number for rotation tracking.
-- column config_secret_metadata.created_by: User or service principal who created/rotated this secret — opaque reference.
