# billing-worker — architecture

A `cloudflare-worker-turbo` component: TypeScript built by the turbo pipeline
from `apps/billing-worker`, deployed per environment by its CI lane.

## Bindings and wiring

- **Service bindings** → `policy-worker` —
  in-process RPC to sibling Workers; no public hops between contexts.
- **Wired configuration** (resolved at deploy time from job-output
  secrets published by the infrastructure terraform; names only):
  `WIRING_CLOUDFLARE_D1_STAGE`, `WIRING_CLOUDFLARE_D1_PROD`.

## Boundaries

This Worker owns its bounded context: its data, its invariants, its
API surface (exposed to the fleet through the edge). Cross-context calls
go over service bindings; nothing else may reach into its storage.
