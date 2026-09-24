# integrations-worker

Cloudflare Worker for the integrations bounded context — provider connections (GitHub App first), inbound delivery inbox, repo links, and the installation-token broker

Part of the meterwise runtime: a Cloudflare Worker deployed per environment (`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only through `api-edge` service bindings.

## Depends on

- **membership-worker** — Cloudflare Worker for the Membership org runtime
- **policy-worker** — Cloudflare Worker for policy authorization decisions
- **billing-worker** — Cloudflare Worker for the Billing API surface (private, service-binding only)
- **projects-worker** — Cloudflare Worker for the Projects runtime

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime
