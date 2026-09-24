# membership-worker

Cloudflare Worker for the Membership org runtime

Part of the meterwise runtime: a Cloudflare Worker deployed per environment (`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only through `api-edge` service bindings.

## Depends on

- **policy-worker** — Cloudflare Worker for policy authorization decisions
- **billing-worker** — Cloudflare Worker for the Billing API surface (private, service-binding only)

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime
- **config-worker** — Cloudflare Worker for the Config read-only API surface
- **events-worker** — Cloudflare Worker for the Events and Audit runtime
- **identity-worker** — Cloudflare Worker for the Identity auth runtime
- **integrations-worker** — Cloudflare Worker for the integrations bounded context — provider connections (GitHub App first), inbound delivery inbox, repo links, and the installation-token broker
- **metering-worker** — Cloudflare Worker for the Metering API surface (usage recording, quota checks)
- **projects-worker** — Cloudflare Worker for the Projects runtime
- **webhooks-worker** — Cloudflare Worker for webhook endpoint, subscription, and delivery-attempt management
