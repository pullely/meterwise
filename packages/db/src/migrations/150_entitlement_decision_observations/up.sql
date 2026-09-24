-- 150_entitlement_decision_observations: entitlement-decision observability.
--
-- Context: billing
-- Spec: specs/roadmap.md (B9 — Entitlement-decision observability),
--       specs/components/11-billing.md, specs/components/09-events-audit-observability.md
-- Task: ai/tasks/task-0124.md
--
-- Adds a counts-only observation table to the existing `billing` bounded context
-- (owned by apps/billing-worker). Every entitlement decision produced by
-- `decideEntitlement` on the internal check-entitlement path emits one row here:
-- a structured, secret-free observation of WHO hit the gate, for WHICH
-- entitlement key, with WHAT outcome. The admin-support worker reads a narrow
-- aggregation of this table so an on-call operator can see gate traffic.
--
-- Storage-shape decision (append-only observations, aggregated at read time):
--   * Chosen over a pre-aggregated rollup counter. The emission path is
--     best-effort and non-blocking — a plain INSERT has no read-modify-write
--     contention, so a recording failure (or a slow DB) can never feed back into
--     the entitlement decision latency/outcome. A rollup counter would require an
--     UPSERT with row-level contention on a hot (org, key, outcome) tuple.
--   * Counts by (org_id, entitlement_key, outcome) over a bounded time window are
--     a cheap GROUP BY backed by the composite index below. At entitlement-check
--     volumes this read is bounded by the window, not the full table.
--   * Append-only mirrors the peer `support_support_action_records` ledger
--     (migration 140) and the events/audit append discipline.
--
-- Design rules:
--   * Forward-only and idempotent: CREATE TABLE / INDEX guarded with IF NOT
--     EXISTS, safe when the runner re-applies the file.
--   * No backfill, no destructive change to existing billing schema/tables.
--   * COUNTS ONLY, SECRET-FREE: a row carries org_id + entitlement_key + outcome
--     (+ denial reason when denied) + occurred_at. It NEVER stores limit values,
--     subscription IDs, plan/source details, provider payloads, tokens, or
--     connection strings. This is enforced by CHECK constraints on the small,
--     closed outcome/reason vocabularies and by the absence of any value column.
--   * Tenant-scoped: every row carries an org_id (opaque TEXT, no FK — mirrors how
--     billing/events reference tenant IDs).

-- Append-only, counts-only ledger of entitlement decisions.
CREATE TABLE IF NOT EXISTS billing_entitlement_decision_observations (
  id                TEXT        PRIMARY KEY,

  -- Target tenant the decision was made for.
  org_id            TEXT        NOT NULL,

  -- Stable machine identifier of the entitlement that was checked
  -- (e.g. 'feature.custom_domains', 'limit.projects'). Matches the worker's
  -- ENTITLEMENT_KEY constraint; never free-form provider text.
  entitlement_key   TEXT        NOT NULL,

  -- The decision outcome. Closed vocabulary.
  outcome           TEXT        NOT NULL,

  -- Denial reason, present ONLY when outcome = 'denied'. Closed vocabulary
  -- mirroring the frozen CheckBillingEntitlementResponse reason contract.
  -- NULL on allowed decisions.
  denial_reason     TEXT,

  -- When the decision occurred (worker-supplied) and when persisted.
  occurred_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT entitlement_decision_observations_outcome_check
    CHECK (outcome IN ('allowed', 'denied')),

  -- Denial reason is required iff denied, and forbidden otherwise. This also
  -- pins the reason to the frozen contract vocabulary so no arbitrary string
  -- (and certainly no secret/payload) can be smuggled into this column.
  CONSTRAINT entitlement_decision_observations_denial_reason_check
    CHECK (
      (outcome = 'denied'  AND denial_reason IN ('not_configured', 'disabled'))
      OR
      (outcome = 'allowed' AND denial_reason IS NULL)
    ),

  CONSTRAINT entitlement_decision_observations_key_not_blank
    CHECK (length(trim(entitlement_key)) > 0)
);

-- Primary read path: aggregate counts by (org, key, outcome) over a bounded
-- time window. Leading org_id + occurred_at lets the window scan stay tenant-
-- scoped and bounded; entitlement_key + outcome support the GROUP BY.
CREATE INDEX IF NOT EXISTS entitlement_decision_observations_org_window_idx
  ON billing_entitlement_decision_observations
  (org_id, occurred_at DESC, entitlement_key, outcome);

-- table billing_entitlement_decision_observations: Append-only, counts-only observations of entitlement decisions (one row per decision on the internal check-entitlement path). Carries org_id, entitlement_key, outcome, and denial_reason only — NEVER limit values, subscription IDs, plan/source details, provider payloads, or secrets. Read as a narrow time-windowed aggregation by the admin-support worker.
-- column billing_entitlement_decision_observations.org_id: Target organization the entitlement decision was made for. Tenant scope.
-- column billing_entitlement_decision_observations.entitlement_key: Stable machine identifier of the checked entitlement. Never free-form text.
-- column billing_entitlement_decision_observations.outcome: Decision outcome: allowed | denied. Closed vocabulary.
-- column billing_entitlement_decision_observations.denial_reason: Denial reason (not_configured | disabled), present only when denied. Mirrors the frozen CheckBillingEntitlementResponse reason contract. Never a value/secret.
