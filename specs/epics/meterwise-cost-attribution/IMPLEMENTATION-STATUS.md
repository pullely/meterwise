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
