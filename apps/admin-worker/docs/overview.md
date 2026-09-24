# admin-worker

Internal Cloudflare Worker for audited support/administration diagnostics

Part of the meterwise runtime: a Cloudflare Worker deployed per environment (`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only through `api-edge` service bindings.

## Depends on

- **cloudflare-d1** — Provisions the Cloudflare D1 platform database for stage and prod

## Depended on by

- (none)
