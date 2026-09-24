# meterwise-cost-attribution — implementation plan

Milestones land in order. Each one is made of one or more tasks, each task is
one pull request, and each pull request is landed with `orun pr land`. A
milestone is marked ✅ here when its "done when" list is true, and it is
recorded in `IMPLEMENTATION-STATUS.md`.

A workspace can mint only 200 brokered credentials per rolling 24 hours, and
every CI job that deploys spends one. The bootstrap, this spec and MW1 fit into
one day. MW2 and MW3 land the next day. Each milestone's tests run green
locally before its pull request opens, because every push to a pull request
spends mints.

## MW0 — the spec ✅

This doc set, merged to `main` and attached to the epic with `orun spec push`.

**Done when**
- the five documents are on `main`
- `orun spec list --epic meterwise-cost-attribution` shows them

## MW1 — the usage ledger

This milestone builds the `ledger` bounded context end to end:

- Migration `200_ledger_core`: `ledger_price_versions`, `ledger_model_prices`
  (seeded with version `2026-09-24`, every row citing its source page and the
  day it was read, design §2.5) and `ledger_events` (with
  `UNIQUE (org_id, event_key)` and CHECKs on every enum, range and the
  priced/unpriced rule). Every seed insert is `ON CONFLICT DO NOTHING`,
  because the SQLite schema test applies every migration twice.
- `packages/db/src/ledger`: the repository. Every function takes `orgId`
  except the price-table reads. The event claim is one
  `INSERT … ON CONFLICT DO NOTHING RETURNING id` (design §3), and nothing
  branches on `rowCount` after a write without `RETURNING` (runbook trap 22).
- `packages/contracts/src/ledger.ts`: the wire types, the pricing arithmetic
  (`costNanoUsd`, `formatUsd`, `matchModel`) as pure functions shared by the
  worker and the console, and the validation limits. The SDK `LedgerClient`
  (`client.ledger`) with `ingest`, `costs`, `events` and `prices`.
- `apps/ledger-worker`: the routes of design §4.1, membership + policy on
  every route. It depends on `db-migrate` (runbook trap 21),
  `membership-worker` and `policy-worker`.
- api-edge: the `ledger` facade, the `LEDGER_WORKER` binding and the `ledger`
  rate-limit family. Policy: `ledger.read` (every org role), `ledger.ingest`
  (owner, admin, builder). `ledger-worker` goes on the notifications
  internal-actor allow-list (for MW2).
- Console: Costs and Price table pages and their nav entries. Solo profile off.
- **Baseline fixes carried here** (runbook): the tested cirrus D1 patch
  (`cirrus-d1-fix.patch`, trap 16: `appendEventWithAudit`, membership org
  create and invitation accept, and the SQLite schema test harness), and a
  redeploy marker on every worker's `component.yaml` (trap 17), because
  `packages/db`, `packages/policy-engine` and `packages/contracts` change.
- `tests/ledger-worker` over real SQLite: the pricing arithmetic against the
  seeded table, model matching (snapshot suffixes, no prefix matching, the
  `gpt-4o-2024-05-13` exception), idempotent ingest including a concurrent
  retry race, `duplicate` vs `conflict`, cost aggregation by every dimension,
  validation, the service-principal path, and tenant isolation.

**Done when**
- on stage a signed-in user creates an organization (201) and an API key with
  the `builder` role
- that key ingests a batch of events (200, every event `accepted`), and a
  retry of one of them is `duplicate` and changes no total
- cost per tenant, per feature and per model match a hand computation from
  the `2026-09-24` price table, to the nano-dollar
- a request with no key, and one with a revoked key (after the 30 s edge
  cache), gets 401; a signed-in non-member gets 404
- on prod `/health` answers 200, the routes answer 401 unauthenticated, and
  `DEBUG_DELIVERY` is off
- `tests/ledger-worker` is green in CI

## MW2 — budgets and guardrails

- Migration `210_ledger_guardrails`: `ledger_budgets`, `ledger_spend_rollups`
  (backfilled once from `ledger_events`), `ledger_alerts` (design §1.4).
  Ingest gains the rollup upsert for every accepted, priced event.
- `ledger-worker`: budget routes, `POST llm-check` (design §4.2, §6), and a
  `scheduled()` handler on `*/15 * * * *` with the two anomaly rules, each
  alert claimed before it is sent. `NOTIFICATIONS_WORKER` binding and
  `dependsOn: notifications-worker`; templates `ledger.budget.crossed` and
  `ledger.anomaly.detected`. Policy `ledger.budget.write` (owner, admin).
  Audit of budget changes and alerts; events-worker learns `mwb_` / `mwa_`.
- The Free plan's $1,000/month tracked-spend allowance through the baseline
  metering context and quota check (MW-J decides the call path).
- Console: Budgets and Alerts. SDK: `client.ledger.check`.

**Done when**
- on stage, with a tenant budget of soft $0.01 and hard $0.02: before any
  spend `check` says `allow`; after ingesting past the soft limit it says
  `warn`, or `downgrade` with the mapped model when the request's model is in
  the map; past the hard limit it says `deny`
- a synthetic burst of 250 events for one `(tenant, feature)` raises exactly
  one `runaway_loop` alert across two cron ticks, and the email request
  reaches `notifications-worker` (202)
- tests pin the rollup under concurrent ingest (no lost increments), the
  decision table, and alert de-duplication

## MW3 — the streaming proxy

- `apps/proxy-worker`: its own public origin, no D1/KV/R2 binding, service
  bindings to `identity-worker` (key resolution) and `ledger-worker` (an
  internal ingest route that accepts `source = 'proxy'` events, and `check`).
  `POST /v1/chat/completions`, streaming and not, to a fixed OpenAI origin.
- Everything in design §7: the header allow-list, the single log shape, fixed
  error codes, `include_usage` injection, the teed stream parser,
  `usage_incomplete`, budget `deny` → 429 and `downgrade` → model rewrite.
- `tests/proxy-worker` with a mock upstream carrying every test of design §7.6.
- Console: a "Use the proxy" panel on the Costs page with the base URL and
  headers. No page ever asks for a provider key.

**Done when**
- every test of design §7.6 passes in CI
- on stage the proxy answers 401 without `x-meterwise-key`, 400 on a malformed
  body, and its `/health` answers 200; a scan of stage D1 after those calls
  finds no provider-key-shaped string (`sk-…`) in any ledger or audit row
- README status `✅ Shipped` only after MW3's deploy run on `main` is fully green

## Sequencing

MW1 → MW2 → MW3. MW2 needs MW1's events and costs. MW3 needs MW1's ingest and
MW2's check (it can land with the check stubbed to `allow` if MW2 slips, but
not before MW1). The price table gains versions between milestones as
providers change prices, each its own `2xx_ledger_prices_<date>` migration.
