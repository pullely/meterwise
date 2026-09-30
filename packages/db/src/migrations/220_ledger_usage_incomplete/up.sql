-- 220_ledger_usage_incomplete
-- The streaming proxy (MW3) — ledger_events.price_status gains
-- 'usage_incomplete': a proxied stream that ended without the provider's
-- usage chunk (the client disconnected) is recorded with the tokens known so
-- far, unpriced, never silently dropped (design §7.5)
-- Bounded context: ledger
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt: create the
-- new shape, copy every row, drop the old table, rename, recreate the
-- indexes. Every statement is re-runnable (the SQLite schema test applies
-- every migration twice): the copy is ON CONFLICT DO NOTHING, and on a
-- second application the whole rebuild simply runs again over the new shape.
-- No other table references ledger_events, and it carries no trigger or view.

CREATE TABLE IF NOT EXISTS ledger_events_v220 (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL,
  event_key            TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 128),
  fingerprint          TEXT NOT NULL CHECK (length(fingerprint) = 64),
  tenant               TEXT NOT NULL CHECK (length(tenant) BETWEEN 1 AND 128),
  feature              TEXT CHECK (feature IS NULL OR length(feature) BETWEEN 1 AND 64),
  end_user             TEXT CHECK (end_user IS NULL OR length(end_user) BETWEEN 1 AND 128),
  provider             TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  model                TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  priced_model         TEXT,
  input_tokens         INTEGER NOT NULL CHECK (input_tokens >= 0 AND input_tokens <= 10000000),
  output_tokens        INTEGER NOT NULL CHECK (output_tokens >= 0 AND output_tokens <= 10000000),
  latency_ms           INTEGER CHECK (latency_ms IS NULL OR (latency_ms >= 0 AND latency_ms <= 3600000)),
  occurred_at          TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  price_status         TEXT NOT NULL CHECK (price_status IN ('priced','unknown_model','before_price_table','usage_incomplete')),
  price_version        TEXT,
  input_price_micros   INTEGER,
  output_price_micros  INTEGER,
  cost_nanousd         INTEGER CHECK (cost_nanousd IS NULL OR cost_nanousd >= 0),
  source               TEXT NOT NULL DEFAULT 'sdk' CHECK (source IN ('sdk','proxy')),
  recorded_by          TEXT,
  CHECK (
    (price_status = 'priced' AND price_version IS NOT NULL AND priced_model IS NOT NULL
       AND input_price_micros IS NOT NULL AND output_price_micros IS NOT NULL AND cost_nanousd IS NOT NULL)
    OR
    (price_status <> 'priced' AND price_version IS NULL AND priced_model IS NULL
       AND input_price_micros IS NULL AND output_price_micros IS NULL AND cost_nanousd IS NULL)
  ),
  -- Only the proxy can know a stream's usage was cut short.
  CHECK (price_status <> 'usage_incomplete' OR source = 'proxy')
);

INSERT INTO ledger_events_v220
  (id, org_id, event_key, fingerprint, tenant, feature, end_user, provider, model, priced_model,
   input_tokens, output_tokens, latency_ms, occurred_at, received_at, price_status, price_version,
   input_price_micros, output_price_micros, cost_nanousd, source, recorded_by)
SELECT id, org_id, event_key, fingerprint, tenant, feature, end_user, provider, model, priced_model,
       input_tokens, output_tokens, latency_ms, occurred_at, received_at, price_status, price_version,
       input_price_micros, output_price_micros, cost_nanousd, source, recorded_by
  FROM ledger_events
 WHERE true
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS ledger_events;

ALTER TABLE ledger_events_v220 RENAME TO ledger_events;

-- table ledger_events: One row per LLM call a customer reported (source sdk) or the proxy metered (source proxy). Every query must scope by org_id.
-- column ledger_events.price_status: priced | unknown_model | before_price_table | usage_incomplete (a proxied stream that ended without its usage chunk; proxy only).

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_events_org_key ON ledger_events (org_id, event_key);
CREATE INDEX IF NOT EXISTS idx_ledger_events_org_occurred ON ledger_events (org_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_events_org_tenant_occurred ON ledger_events (org_id, tenant, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_events_org_received ON ledger_events (org_id, received_at);
CREATE INDEX IF NOT EXISTS idx_ledger_events_occurred ON ledger_events (occurred_at);
