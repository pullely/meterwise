# ledger-worker — runbook

- **Health:** `GET /health` on the worker (via a service binding) reports which
  bindings are configured: database, membership, policy.
- **Every route answers 404 for a member or a valid key:** policy-worker is
  running an old action table without `ledger.read`/`ledger.ingest`. A change
  to `packages/policy-engine` does not redeploy policy-worker by itself. Touch
  its `component.yaml` and merge (runbook trap 17).
- **Every call answers 503:** migration `200_ledger_core` has not been applied
  in that environment. Check the `db-migrate` lane of the deploy run.
- **Costs look low and `unpricedEvents` is high:** the customer reports a model
  the price table does not know (another provider, or a new model). Add a
  price version (`2xx_ledger_prices_<date>`), with every row read from the
  provider's page and cited. Existing events stay unpriced (MW-F).
- **A revoked key still ingests for a few seconds:** api-edge's 30 s actor
  cache. Expected (MW-L).
- **Prices changed at a provider:** never `UPDATE` a row. Add a version with a
  new `effective_from`, so stored costs keep the price that was true.
