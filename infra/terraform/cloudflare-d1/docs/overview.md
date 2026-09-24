# cloudflare-d1

Provisions the Cloudflare D1 platform database for stage and prod

Terraform-managed infrastructure for meterwise, per environment (`stage`, `prod`; `dev` is verify-only and provisions nothing).

## Depends on

- (none)

## Depended on by

- **admin-worker** — Internal Cloudflare Worker for audited support/administration diagnostics
- **api-edge** — Cloudflare Worker for the API edge Runtime
- **db-migrate** — Applies database migrations to the stage and prod Cloudflare D1 databases
- **identity-worker** — Cloudflare Worker for the Identity auth runtime
