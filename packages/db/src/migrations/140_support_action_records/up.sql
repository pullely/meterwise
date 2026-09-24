-- 140_support_action_records: internal support/administration action ledger.
--
-- Context: support
-- Spec: specs/components/16-admin-support.md (B8 admin-support worker, V1)
-- Task: ai/tasks/task-0123.md
--
-- Establishes the `support` bounded context owned by apps/admin-worker. V1 owns
-- a single append-only table: a record of every audited support action (a
-- read-only diagnostic lookup, or any future mutating support action) taken by
-- an internal support actor against a target organization.
--
-- Design rules:
--   * Forward-only and idempotent: CREATE SCHEMA / TABLE / INDEX all guarded
--     with IF NOT EXISTS, safe when the runner re-applies the file
--     re-running the migration.
--   * No backfill, no destructive change to existing schemas.
--   * Tenant-scoped: every row carries a target org_id. Support actors are
--     opaque subject references (no FK into identity), mirroring how the
--     events/membership contexts treat actor/subject IDs.
--   * No secret material: this table never stores tokens, secrets, or
--     connection strings. `reason` is operator-supplied free text; `metadata`
--     is a narrow JSON bag for non-sensitive diagnostic context.
--   * Impersonation is intentionally OUT of V1 scope (spec-16 Agent Freedom):
--     no session/impersonation columns are introduced here. The clean seam is
--     a future migration that adds its own table.
-- schema support: Support/administration bounded context — owns audited internal support-action records. Reads tenant data only through narrow diagnostic projections, never as a privileged shortcut around policy/audit.

-- Append-only ledger of audited support actions.
CREATE TABLE IF NOT EXISTS support_support_action_records (
  id              TEXT        PRIMARY KEY,

  -- Support actor (opaque subject reference from the support authorization context).
  actor_id        TEXT        NOT NULL,
  actor_type      TEXT        NOT NULL DEFAULT 'user',

  -- Target tenant the support action was taken against.
  target_org_id   TEXT        NOT NULL,

  -- What kind of support action this row records (e.g. 'organization.lookup',
  -- 'user.lookup'). Free-form to allow the support vocabulary to grow without a
  -- migration; the worker constrains the values it writes.
  action          TEXT        NOT NULL,

  -- Operator-supplied justification. Required by spec-16 support rules.
  reason          TEXT        NOT NULL,

  -- Trace correlation back to the originating request.
  request_id      TEXT        NOT NULL,

  -- Narrow, non-sensitive diagnostic context. Never holds secrets/tokens.
  metadata        TEXT       NOT NULL DEFAULT '{}',

  -- When the support action occurred (worker-supplied) and when persisted.
  occurred_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT support_action_records_actor_type_check
    CHECK (actor_type IN ('user', 'service_principal', 'system')),
  CONSTRAINT support_action_records_reason_not_blank
    CHECK (length(trim(reason)) > 0)
);

-- Primary read path: most-recent support actions against a target org.
CREATE INDEX IF NOT EXISTS support_action_records_target_org_idx
  ON support_support_action_records (target_org_id, occurred_at DESC, id DESC);

-- Secondary read path: audit a particular support actor's history.
CREATE INDEX IF NOT EXISTS support_action_records_actor_idx
  ON support_support_action_records (actor_id, occurred_at DESC, id DESC);

-- table support_support_action_records: Append-only audited support-action ledger. One row per support action (actor, target org, reason, request ID, timestamp). Mirrored into events/audit via the events-audit seam at write time.
-- column support_support_action_records.actor_id: Opaque support-actor subject ID. No FK into identity — the support context references actors by opaque ID like events/membership.
-- column support_support_action_records.target_org_id: The organization this support action targeted. Tenant scope for every support row.
-- column support_support_action_records.reason: Operator-supplied justification for the support action. Required, non-blank.
-- column support_support_action_records.metadata: Narrow non-sensitive diagnostic context. Never stores secrets, tokens, or connection strings.
