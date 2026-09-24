# policy-worker — architecture

A `cloudflare-worker-turbo` component: TypeScript built by the turbo pipeline
from `apps/policy-worker`, deployed per environment by its CI lane.

## Bindings and wiring


## Boundaries

This Worker owns its bounded context: its data, its invariants, its
API surface (exposed to the fleet through the edge). Cross-context calls
go over service bindings; nothing else may reach into its storage.
