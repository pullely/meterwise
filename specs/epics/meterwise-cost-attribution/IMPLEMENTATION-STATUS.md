# meterwise-cost-attribution (MW) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| MW0 — the spec | ✅ merged 9075db2, pushed with `orun spec push` | #9 |
| MW1 — the usage ledger | In review | this PR |
| MW2 — budgets and guardrails | | |
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
