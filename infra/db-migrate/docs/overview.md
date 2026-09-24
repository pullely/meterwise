# db-migrate

Applies database migrations to the stage and prod Cloudflare D1 databases

Applies this repo's ordered migrations to the environment's Cloudflare D1 database: plan on pull requests, apply on merge to `main`.

## Depends on

- **db** — 
- **cloudflare-d1** — Provisions the Cloudflare D1 platform database for stage and prod

## Depended on by

- **notifications-worker** — Cloudflare Worker for the Notifications bounded context
