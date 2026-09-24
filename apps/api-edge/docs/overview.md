# api-edge

Cloudflare Worker for the API edge Runtime

Part of the meterwise runtime: a Cloudflare Worker deployed per environment (`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only through `api-edge` service bindings.

## Depends on

- **cloudflare-d1** — Provisions the Cloudflare D1 platform database for stage and prod
- **cloudflare-kv** — Provisions Cloudflare KV namespaces backing the api-edge idempotency replay store (stage and prod)
- **projects-worker** — Cloudflare Worker for the Projects runtime
- **events-worker** — Cloudflare Worker for the Events and Audit runtime
- **config-worker** — Cloudflare Worker for the Config read-only API surface
- **webhooks-worker** — Cloudflare Worker for webhook endpoint, subscription, and delivery-attempt management
- **billing-worker** — Cloudflare Worker for the Billing API surface (private, service-binding only)
- **integrations-worker** — Cloudflare Worker for the integrations bounded context — provider connections (GitHub App first), inbound delivery inbox, repo links, and the installation-token broker
- **identity-worker** — Cloudflare Worker for the Identity auth runtime
- **membership-worker** — Cloudflare Worker for the Membership org runtime
- **metering-worker** — Cloudflare Worker for the Metering API surface (usage recording, quota checks)
- **notifications-worker** — Cloudflare Worker for the Notifications bounded context

## Depended on by

- **web-console-next** — Next.js 15 + opennextjs/cloudflare delivery of the Meterwise web console (per-environment, Workers + Static Assets)
