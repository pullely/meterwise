# ledger-worker-tests — architecture

Jest (ts-jest, ESM). `src/harness.ts` migrates an in-memory SQLite database and
fakes membership-worker and policy-worker with an org-aware copy of the policy
engine's role table, including a `service_principal` bound as `builder`.
`src/fixtures.ts` drives the worker's router with real `Request`s.
