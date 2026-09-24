# ledger-worker — overview

Owns the `ledger` bounded context: Meterwise's **usage ledger**. The dated,
versioned model price table (global data shipped in migrations, every row
citing the provider page it was read from), the per-org ledger of LLM calls a
customer's SDK reports, and cost per tenant, feature, model, provider and
end-user computed from the two. MW2 adds budgets, the pre-flight check and
the anomaly cron.

The invariants this worker holds:

- **a reported event is counted once.** `(org_id, event_key)` is unique and an
  event is claimed with one `INSERT … ON CONFLICT DO NOTHING RETURNING id`. A
  retry answers `duplicate`, and a different call reusing the id answers
  `conflict`. Neither changes a total.
- **a stored cost never changes.** Each priced event carries the price-table
  version and both unit prices that priced it. A new price is a new version.
- **money is integers.** Prices are micro-USD per million tokens, costs
  nano-USD, computed with BigInt and one round-half-up per event
  (`costNanoUsd` in `@saas/contracts/ledger`).
- **an unknown model is recorded, not refused**, as `unknown_model`, and
  counted in every cost read's `unpricedEvents`.
- every query is scoped by `org_id`. A non-member, or another org's API key,
  gets 404, never 403.

## What it serves

All under `/v1/organizations/{org}/`: `POST llm-events` (`ledger.ingest`:
owner, admin, builder, which includes an API key created with the builder
role), `GET llm-events`, `GET llm-costs`, `GET llm-prices` (`ledger.read`:
every org role).
