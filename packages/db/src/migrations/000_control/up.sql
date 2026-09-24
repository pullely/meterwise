-- Baseline control migration
-- Creates the migration tracking schema used by the migration runner.
-- Owner: control bounded context
CREATE TABLE IF NOT EXISTS _migrations_applied (
  id          TEXT PRIMARY KEY,
  context     TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied_by  TEXT NOT NULL DEFAULT 'migration-runner'
);

-- table _migrations_applied: Tracks which migrations have been applied to the database.
