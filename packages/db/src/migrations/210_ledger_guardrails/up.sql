-- 210_ledger_guardrails
-- Budgets and guardrails (MW2) — soft and hard monthly budgets per tenant
-- with a downgrade map, month-to-date spend rollups maintained at ingest, and
-- the alerts the anomaly cron raises, each claimed once
-- Bounded context: ledger
-- Every write in this context reads its outcome from RETURNING, never from
-- rowCount (D1 reports rows.length). Every statement here is re-runnable: the
-- SQLite schema test applies every migration twice.

CREATE TABLE IF NOT EXISTS ledger_budgets (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL,
  tenant               TEXT NOT NULL CHECK (length(tenant) BETWEEN 1 AND 128),
  soft_limit_nanousd   INTEGER CHECK (soft_limit_nanousd IS NULL OR soft_limit_nanousd > 0),
  hard_limit_nanousd   INTEGER CHECK (hard_limit_nanousd IS NULL OR hard_limit_nanousd > 0),
  downgrade            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(downgrade) AND json_type(downgrade) = 'object'),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  updated_by           TEXT,
  CHECK (soft_limit_nanousd IS NOT NULL OR hard_limit_nanousd IS NOT NULL),
  CHECK (soft_limit_nanousd IS NULL OR hard_limit_nanousd IS NULL OR soft_limit_nanousd < hard_limit_nanousd)
);

-- table ledger_budgets: One monthly (UTC calendar month) budget per org and tenant; tenant '*' is the org-wide default for every tenant without its own row.
-- column ledger_budgets.soft_limit_nanousd: Past this month-to-date spend llm-check answers warn, or downgrade when the requested model is in the map.
-- column ledger_budgets.hard_limit_nanousd: Past this month-to-date spend llm-check answers deny. Advisory: calls in flight when it is crossed can overshoot it (design §6).
-- column ledger_budgets.downgrade: JSON object, requested model -> cheaper model, both lower-cased; used between the soft and hard limits.

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_budgets_org_tenant ON ledger_budgets (org_id, tenant);

CREATE TABLE IF NOT EXISTS ledger_spend_rollups (
  org_id        TEXT NOT NULL,
  tenant        TEXT NOT NULL,
  period        TEXT NOT NULL CHECK (length(period) = 7 AND period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  cost_nanousd  INTEGER NOT NULL DEFAULT 0 CHECK (cost_nanousd >= 0),
  events        INTEGER NOT NULL DEFAULT 0 CHECK (events >= 0),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, tenant, period)
);

-- table ledger_spend_rollups: Month-to-date priced spend per org, tenant and UTC month of occurred_at. Maintained at ingest by one atomic INSERT … ON CONFLICT DO UPDATE per accepted priced event; read by llm-check.

-- Backfill once from the events MW1 stored. DO NOTHING on conflict, so a
-- second application (or a row ingest already created) is left alone.
INSERT INTO ledger_spend_rollups (org_id, tenant, period, cost_nanousd, events, updated_at)
SELECT org_id, tenant, substr(occurred_at, 1, 7), SUM(cost_nanousd), COUNT(*),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM ledger_events
 WHERE price_status = 'priced'
 GROUP BY org_id, tenant, substr(occurred_at, 1, 7)
ON CONFLICT (org_id, tenant, period) DO NOTHING;

CREATE TABLE IF NOT EXISTS ledger_alerts (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('runaway_loop', 'abusive_user', 'budget_soft', 'budget_hard')),
  subject         TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 400),
  window_start    TEXT NOT NULL,
  window_end      TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  status          TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'notified', 'no_recipients')),
  recipients      INTEGER NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  accepted        INTEGER NOT NULL DEFAULT 0 CHECK (accepted >= 0),
  created_at      TEXT NOT NULL,
  notified_at     TEXT
);

-- table ledger_alerts: One row per raised alert. UNIQUE (org_id, kind, subject, window_start): the cron claims it with INSERT … ON CONFLICT DO NOTHING RETURNING before sending, so two ticks cannot email twice.
-- column ledger_alerts.subject: tenant, or tenant + NUL + feature (runaway_loop), or tenant + NUL + user (abusive_user). Customer attribution strings only.
-- column ledger_alerts.accepted: How many recipient emails notifications-worker accepted (202). Accepted is not delivered.

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_alerts_claim ON ledger_alerts (org_id, kind, subject, window_start);
CREATE INDEX IF NOT EXISTS idx_ledger_alerts_org_created ON ledger_alerts (org_id, created_at);

-- The cron's window scans run across orgs by time.
CREATE INDEX IF NOT EXISTS idx_ledger_events_occurred ON ledger_events (occurred_at);
