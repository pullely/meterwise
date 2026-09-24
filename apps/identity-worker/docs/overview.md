# identity-worker

Cloudflare Worker for the Identity auth runtime

Part of the meterwise runtime: a Cloudflare Worker deployed per environment (`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only through `api-edge` service bindings.

## Depends on

- **cloudflare-d1** — Provisions the Cloudflare D1 platform database for stage and prod
- **policy-worker** — Cloudflare Worker for policy authorization decisions
- **membership-worker** — Cloudflare Worker for the Membership org runtime
- **notifications-worker** — Cloudflare Worker for the Notifications bounded context

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime
