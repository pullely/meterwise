-- Identity persistence foundation.
-- Context: identity
-- Idempotent: uses IF NOT EXISTS throughout.
-- schema identity: Identity bounded context — owns users, auth identities, login challenges, and sessions.

-- Users: the root identity record.
CREATE TABLE IF NOT EXISTS identity_users (
  id            TEXT        PRIMARY KEY,
  email         TEXT        NOT NULL,
  email_lower   TEXT        NOT NULL,
  display_name  TEXT,
  status        TEXT        NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'deleted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON identity_users (email_lower);

-- table identity_users: Root user records owned by the identity context.
-- column identity_users.email_lower: Normalized (lower-case) email for case-insensitive uniqueness.

-- Auth identities: links a user to an external or internal auth provider.
CREATE TABLE IF NOT EXISTS identity_auth_identities (
  id          TEXT        PRIMARY KEY,
  user_id     TEXT        NOT NULL REFERENCES identity_users(id),
  provider    TEXT        NOT NULL,
  subject     TEXT        NOT NULL,
  metadata    TEXT       NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_subject_idx
  ON identity_auth_identities (provider, subject);

CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx
  ON identity_auth_identities (user_id);

-- table identity_auth_identities: Links users to auth providers (email, OAuth, etc).
-- column identity_auth_identities.subject: Provider-scoped subject identifier (e.g. email address, OAuth sub).

-- Login challenges: short-lived passwordless login proofs.
CREATE TABLE IF NOT EXISTS identity_login_challenges (
  id              TEXT        PRIMARY KEY,
  user_id         TEXT        NOT NULL REFERENCES identity_users(id),
  method          TEXT        NOT NULL,
  code_hash       TEXT        NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT login_challenges_method_check CHECK (method IN ('email_code', 'magic_link'))
);

CREATE INDEX IF NOT EXISTS login_challenges_user_id_idx
  ON identity_login_challenges (user_id);

-- table identity_login_challenges: Short-lived passwordless login proofs. Only hashes stored.
-- column identity_login_challenges.code_hash: SHA-256 hash of the one-time code or magic-link token. Raw value never stored.

-- Sessions: active bearer session tokens.
CREATE TABLE IF NOT EXISTS identity_sessions (
  id            TEXT        PRIMARY KEY,
  user_id       TEXT        NOT NULL REFERENCES identity_users(id),
  token_hash    TEXT        NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_idx
  ON identity_sessions (token_hash);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx
  ON identity_sessions (user_id);

-- table identity_sessions: Active user sessions. Only token hashes stored.
-- column identity_sessions.token_hash: SHA-256 hash of the bearer token. Raw token never stored.
