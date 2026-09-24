# db-migrate — architecture

Applies `packages/db/src/migrations` to the environment's D1 database over
Cloudflare's REST API (`POST /accounts/{account}/d1/database/{db}/query`).

- **The applied ledger is in the database**: `_migrations_applied` records
  id, context, and checksum. A migration whose file no longer matches its
  recorded checksum stops the run — that guard is the whole point.
- **Statements are sent one at a time**, so a failure names the exact
  statement instead of the whole file.
- **No transaction**: D1 exposes none over REST. Migrations are written
  idempotently (`IF NOT EXISTS`) and the ledger row is written last, so a
  failed migration is simply re-attempted in full on the next run.
- **The lock is a row** (`_migrations_lock`), reclaimed when stale —
  SQLite has no advisory locks.
