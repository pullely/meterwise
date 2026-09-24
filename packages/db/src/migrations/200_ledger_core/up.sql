-- 200_ledger_core
-- Usage ledger foundation (MW1) — the dated, versioned, cited model price
-- table, and the ledger of LLM calls a customer's SDK reports, each priced
-- with the version in effect when it happened
-- Bounded context: ledger
-- schema ledger: Ledger bounded context — owns the model price table (global,
-- versioned data: a new price is a new version, never an UPDATE) and the
-- per-org ledger of LLM events. An event is unique per (org_id, event_key):
-- ingest claims it with INSERT … ON CONFLICT DO NOTHING RETURNING, so a
-- retried event is never counted twice. Money is integers: prices are
-- micro-USD per million tokens, costs nano-USD. Seeds are ON CONFLICT DO
-- NOTHING (migrations replay).

CREATE TABLE IF NOT EXISTS ledger_price_versions (
  version         TEXT PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 32),
  effective_from  TEXT NOT NULL,
  published_on    TEXT NOT NULL,
  description     TEXT NOT NULL
);

-- table ledger_price_versions: One row per price-table version. An event is priced with the latest version whose effective_from <= its occurred_at.
-- column ledger_price_versions.effective_from: ISO-8601 UTC timestamp from which this version prices events.

CREATE TABLE IF NOT EXISTS ledger_model_prices (
  version                 TEXT NOT NULL REFERENCES ledger_price_versions (version),
  provider                TEXT NOT NULL CHECK (provider = lower(provider) AND length(provider) BETWEEN 1 AND 32),
  model                   TEXT NOT NULL CHECK (model = lower(model) AND length(model) BETWEEN 1 AND 128),
  display_name            TEXT NOT NULL,
  input_micros_per_mtok   INTEGER NOT NULL CHECK (input_micros_per_mtok >= 0 AND input_micros_per_mtok < 1000000000),
  output_micros_per_mtok  INTEGER NOT NULL CHECK (output_micros_per_mtok >= 0 AND output_micros_per_mtok < 1000000000),
  source_url              TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  checked_on              TEXT NOT NULL CHECK (length(checked_on) = 10),
  PRIMARY KEY (version, provider, model)
);

-- table ledger_model_prices: Base input/output list prices per model, per version. Every row cites the provider page it was read from and the day.
-- column ledger_model_prices.input_micros_per_mtok: Micro-USD per million input tokens ($2.50/MTok = 2500000).
-- column ledger_model_prices.output_micros_per_mtok: Micro-USD per million output tokens.

CREATE TABLE IF NOT EXISTS ledger_events (
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
  price_status         TEXT NOT NULL CHECK (price_status IN ('priced','unknown_model','before_price_table')),
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
  )
);

-- table ledger_events: One row per LLM call a customer reported. Every query must scope by org_id.
-- column ledger_events.event_key: The client's eventId. UNIQUE per org: the idempotency key of ingest.
-- column ledger_events.fingerprint: SHA-256 of the canonical content; tells a retry (same) from a reused id (different).
-- column ledger_events.tenant: The customer's own customer, an opaque string Meterwise never interprets.
-- column ledger_events.price_version: The price-table version that priced this row, with both unit prices copied beside it.
-- column ledger_events.cost_nanousd: Cost in nano-USD (1e-9 USD); null exactly when the row is unpriced.

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_events_org_key ON ledger_events (org_id, event_key);
CREATE INDEX IF NOT EXISTS idx_ledger_events_org_occurred ON ledger_events (org_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_events_org_tenant_occurred ON ledger_events (org_id, tenant, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_events_org_received ON ledger_events (org_id, received_at);

-- Price table version 2026-09-24 (design §2.5): read that day from the
-- providers' own pricing pages, standard tier, base input and output rates.
INSERT INTO ledger_price_versions (version, effective_from, published_on, description)
VALUES ('2026-09-24', '2026-09-24T00:00:00.000Z', '2026-09-24',
        'OpenAI standard tier (short-context price where the page splits by context length) and Anthropic base rates, read from the providers'' pricing pages on 2026-09-24. Base input/output only: no cache, batch, priority or data-residency pricing.')
ON CONFLICT (version) DO NOTHING;

INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-6-astra', 'GPT-6 Astra', 10000000, 50000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-6-sol', 'GPT-6 Sol', 2000000, 10000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-6-luna', 'GPT-6 Luna', 100000, 500000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5.6-sol', 'GPT-5.6 Sol (promotional)', 4000000, 20000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', 2000000, 12000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', 200000, 1200000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5.5', 'GPT-5.5 (<272K context)', 5000000, 30000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5.4', 'GPT-5.4 (<272K context)', 2500000, 15000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5.4-mini', 'GPT-5.4 mini', 750000, 4500000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5.4-nano', 'GPT-5.4 nano', 200000, 1250000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5.2', 'GPT-5.2', 1750000, 14000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5.1', 'GPT-5.1', 1250000, 10000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5', 'GPT-5', 1250000, 10000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5-mini', 'GPT-5 mini', 250000, 2000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-5-nano', 'GPT-5 nano', 50000, 400000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-4.1', 'GPT-4.1', 2000000, 8000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-4.1-mini', 'GPT-4.1 mini', 400000, 1600000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-4.1-nano', 'GPT-4.1 nano', 100000, 400000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-4o', 'GPT-4o', 2500000, 10000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-4o-2024-05-13', 'GPT-4o (2024-05-13 snapshot)', 5000000, 15000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'gpt-4o-mini', 'GPT-4o mini', 150000, 600000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'o3', 'o3', 2000000, 8000000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'openai', 'o4-mini', 'o4-mini', 1100000, 4400000, 'https://developers.openai.com/api/docs/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', 10000000, 50000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 4000000, 20000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', 2000000, 10000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 1000000, 5000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-opus-5', 'Claude Opus 5', 5000000, 25000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', 5000000, 25000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', 5000000, 25000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', 5000000, 25000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', 5000000, 25000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-opus-4-1', 'Claude Opus 4.1', 15000000, 75000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-opus-4', 'Claude Opus 4', 15000000, 75000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 3000000, 15000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 3000000, 15000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
INSERT INTO ledger_model_prices (version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok, source_url, checked_on)
VALUES ('2026-09-24', 'anthropic', 'claude-sonnet-4', 'Claude Sonnet 4', 3000000, 15000000, 'https://platform.claude.com/docs/en/about-claude/pricing', '2026-09-24')
ON CONFLICT (version, provider, model) DO NOTHING;
