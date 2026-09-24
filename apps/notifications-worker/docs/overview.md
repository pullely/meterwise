# notifications-worker

Cloudflare Worker for the Notifications bounded context

Part of the meterwise runtime: a Cloudflare Worker deployed per environment (`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only through `api-edge` service bindings.

## Depends on

- **events-worker** — Cloudflare Worker for the Events and Audit runtime
- **db-migrate** — Applies database migrations to the stage and prod Cloudflare D1 databases

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime
- **identity-worker** — Cloudflare Worker for the Identity auth runtime
