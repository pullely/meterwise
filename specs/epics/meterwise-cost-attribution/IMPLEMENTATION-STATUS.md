# meterwise-cost-attribution (MW) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| MW0 — the spec | ✅ merged 9075db2, pushed with `orun spec push` | #9 |
| MW1 — the usage ledger | ✅ merged d1b1387; `main` deploy run 35944403297 green on all 66 lanes after two transient reruns (runbook trap 31); stage and prod verified | #10 |
| MW2 — budgets and guardrails | In review | this PR |
| MW3 — the streaming proxy | | |

## Departures from the design

### MW1

- **Baseline fixes carried (runbook trap 16, trap 17).** MW1 applies the
  portfolio's tested `cirrus-d1-fix.patch`: the baseline's
  `appendEventWithAudit` and the membership org-create and invitation-accept
  SQL are Postgres-only and fail on D1, so organization create answered 503.
  The patch also adds the SQLite schema test harness. Every worker's
  `component.yaml` carries a redeploy marker, because `packages/db`,
  `packages/policy-engine` and `packages/contracts` changed and a worker
  redeploys only when its own `component.yaml` does.
- **`billing_admin` reads costs.** Design §4.1 says `ledger.read` goes to
  every org role; the baseline's pinned effective-permission test for
  `billing_admin` was updated to include it.
- **Ingest results carry no `pricedModel`.** The stored event (and
  `GET llm-events`) has it; the per-item ingest result keeps to the fields of
  design §4.1.
- **Event-list paging** uses an opaque `(received_at, id)` cursor
  (`nextBefore`), not a bare timestamp, because a batch stores many events
  with one `received_at`.
- **Not built in MW1:** nothing from design §4.1 is missing. The console's
  Costs page shows the ingest snippet; a packaged language SDK beyond
  `@saas/sdk`'s `client.ledger` is not part of this milestone.

### MW2

- **Rollups are self-healing.** Design §1.4 maintains `ledger_spend_rollups`
  with one upsert per accepted priced event. D1 has no interactive
  transactions, so the event's claim and its rollup upsert are two
  statements. Each 15-minute tick therefore also recomputes the current
  month's rollups from `ledger_events` in one `INSERT … SELECT … ON CONFLICT
  DO UPDATE … WHERE <differs>` statement, and reports how many rows it
  corrected (`reconciled`). The same statement closes the window between
  `db-migrate` applying 210's backfill and the new ledger-worker going live.
- **The anomaly window is the trailing hour, evaluated every 15 minutes.**
  Design §6 says "the last window" without fixing its length. A burst stays
  inside the trailing hour for four ticks. Each alert's claim key is
  `(org, kind, subject, window_start)` with `window_start` = the UTC hour of
  the burst's first event, so every tick that sees the same burst derives the
  same key and only the first claims it. The runaway baseline is the median
  of the 168 hourly event counts before the window (empty hours count as 0).
- **Budget alerts too.** Besides the two anomaly rules, the sweep raises
  `budget_soft` / `budget_hard` once per tenant per month when a tenant's
  month-to-date spend reaches its effective budget (template
  `ledger.budget.crossed`).
- **Alert subjects are JSON arrays** (`["acme","summarize"]`), not
  NUL-joined strings: SQLite returns TEXT through C strings, so a NUL
  truncated the subject in the first test run.
- **A claim with no accepted email is given back** so the next tick retries it
  (the notification idempotency key makes that safe); an org with no active
  owner or admin gets `no_recipients` and is not retried. "Notified" means
  notifications-worker accepted the send (202), not that it was delivered
  (runbook trap 27: no product can deliver email yet).
- **`llm-check` prices `estimatedInputTokens`** at the model's input rate and
  decides on month-to-date spend plus that estimate.
- **`GET budgets` reports `spentNanoUsd: null` for the `*` default**, which
  applies to each tenant on its own.
- **Tracked spend reaches metering through the repository, not a route**
  (MW-J, decided; the allowance is tracked, not enforced).
- **Console:** one page, Budgets & alerts, not two.
- **Redeploy markers (trap 17):** only `policy-worker` gets one
  (`ledger.budget.write`); no other worker's behaviour depends on the shared
  packages MW2 changes.

### MW3

- **A stage-only mock upstream is its own Worker.** `apps/mock-upstream`
  (`meterwise-mock-upstream-stage`, no prod environment, no bindings, no
  public hostname) mimics `POST /v1/chat/completions`. proxy-worker's STAGE
  block binds it as `UPSTREAM_OVERRIDE`; the prod block has no such binding,
  so prod can only reach the constant `https://api.openai.com` origin. The
  unit tests bind the same mock code. No test or smoke calls a real provider.
- **The upstream origin is a code constant** (`src/upstream.ts`), not a
  wrangler variable: nothing in a request or in configuration text can point
  the key elsewhere; only a service binding can replace it, and only stage has
  one. A source-scan test pins that the origin appears exactly once.
- **The Worker is `meterwise-proxy-worker-{env}`**, not `meterwise-proxy-{env}`
  as design §4.3 sketched: the portfolio's naming (`<slug>-<component>-<env>`).
- **Budget check fails open.** If ledger-worker cannot answer `llm-check`, the
  proxy forwards the call (availability over enforcement; the call is still
  metered). A `deny` answer is always enforced (429 `budget_exceeded`).
- **A "model" shaped like a secret key (`sk-`, `rk-`, `pk-`) is refused (400)**
  and never logged. Found by the custody suite: the log's model-name check
  accepted `sk-test-…` as a model name. Defence in depth: it is not the
  Authorization path, but a key pasted into the wrong field must not travel.
- **`usage_incomplete` tokens:** a stream cut short records 0 input tokens
  and the number of content chunks seen as output tokens (OpenAI streams about
  one token per chunk). It is unpriced, as design §7.5 says.
- **Migration 220 rebuilds `ledger_events`** (create, copy, drop, rename,
  re-index) because SQLite cannot alter a CHECK. It also pins that only
  `source = 'proxy'` rows can be `usage_incomplete`. The D1 runner applies
  statements one at a time, so a crash between DROP and RENAME needs a manual
  `ALTER TABLE ledger_events_v220 RENAME TO ledger_events` before a retry.
- **The Meterwise-key cache is in-isolate** (a Map keyed by SHA-256, 30 s), not
  the Cache API: the proxy writes nothing to any Cloudflare storage.
- **Returned headers are an allow-list** (content type, the provider's rate-limit
  and timing headers, and `x-mock-*`, which only the stage mock sends).
- **Console:** "Or use the proxy" panel on the Costs page; no page asks for a
  provider key.
- **The rollup upsert is grouped per (tenant, month) per request** instead of
  one per event (MW2 as landed). Found by MW2's stage smoke: a 100-event batch
  timed out the smoke's 30 s client, because every D1 statement is a round
  trip (measured on stage from the smoke's colo: 10 events 8.6 s, 25 events
  16.2 s, 50 events 31.9 s, about 0.3 s a statement, two statements per
  event). Grouping halves it; a test pins one rollup statement per group.
