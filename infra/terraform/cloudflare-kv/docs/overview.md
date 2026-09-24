# cloudflare-kv

Provisions Cloudflare KV namespaces backing the api-edge idempotency replay store (stage and prod)

Terraform-managed infrastructure for meterwise, per environment (`stage`, `prod`; `dev` is verify-only and provisions nothing).

## Depends on

- (none)

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime
