# ledger-worker — architecture

```
customer SDK ──(Bearer API key)──► api-edge ──(resolveActor: service_principal)──► ledger-worker ──► D1 (ledger_*)
console      ──(session)─────────►          ──(resolveActor: user)──────────────►               ├─► membership-worker (context)
                                                                                                 └─► policy-worker (authorize)
```

- Reachable only over the `LEDGER_WORKER` service binding (`workers_dev: false`).
- api-edge's `ledger` rate-limit family sits in front (600/min per key, 1,200/min
  per org for writes), and api-edge caches a key's resolution for 30 s, which
  bounds how long a revoked key keeps working.
- Every route runs membership authorization-context, then policy authorize. A
  deny is `404`, never `403`.
- `packages/db/src/ledger` is the only SQL. The event claim reports through
  `RETURNING` rows, never `rowCount` (runbook trap 22).
- No audit event per ingest: ingest is telemetry, and the ledger row with
  `recorded_by` is the record. MW2's budget changes are audited.
- Depends on `db-migrate`, so a run that adds a `ledger_*` migration (a new
  price version, for instance) applies it before this worker's code goes live
  (runbook trap 21).
