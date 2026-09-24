# admin-worker — architecture

A `cloudflare-worker-turbo` component: TypeScript built by the turbo pipeline
from `apps/admin-worker`, deployed per environment by its CI lane.

## Bindings and wiring

- **Wired configuration** (resolved at deploy time from job-output
  secrets published by the infrastructure terraform; names only):
  `WIRING_CLOUDFLARE_D1_STAGE`, `WIRING_CLOUDFLARE_D1_PROD`.
- **`PLATFORM_DB`** is a D1 binding. SQLite types apply: timestamps are
  ISO-8601 text, JSON is text, booleans are 0/1, and there is no
  interactive transaction (see `packages/db/src/d1`).

## Boundaries

This Worker owns its bounded context: its data, its invariants, its
API surface (exposed to the fleet through the edge). Cross-context calls
go over service bindings; nothing else may reach into its storage.
