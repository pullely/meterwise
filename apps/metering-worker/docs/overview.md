# metering-worker

Cloudflare Worker for the Metering API surface (usage recording, quota checks)

Part of the meterwise runtime: a Cloudflare Worker deployed per environment (`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only through `api-edge` service bindings.

## Depends on

- **membership-worker** — Cloudflare Worker for the Membership org runtime
- **policy-worker** — Cloudflare Worker for policy authorization decisions

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime
