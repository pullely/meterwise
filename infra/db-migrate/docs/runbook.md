# db-migrate — runbook

## How it deploys

Merges to `main` converge automatically: CI plans changed components
(`orun plan --changed`) and runs this component's lane via
`orun run --remote-state` with credential-free OIDC auth. The convergence
run is the deployment; the DAG orders this component after everything it
depends on. Failed lanes resume with `gh run rerun --failed`.

## Rollback

Revert the offending commit on `main`; the next convergence applies the
previous desired state. There is no out-of-band mutation to undo — the
repo is the source of truth.

## Verify

```bash
# what the runner would apply, without touching the database
pnpm --filter @saas/db migrate:plan -- --env stage
```

## Common failures

- **Checksum mismatch for an already-applied migration**: someone edited
  a migration that has already run. Do NOT rechecksum it — write a new
  forward migration.
- **`no such table: _migrations_applied`**: the run reached a different
  database than the one it migrated before — check `WIRING_CLOUDFLARE_D1`
  for that environment.
- **A statement fails partway**: nothing rolls back (D1 has no REST
  transaction), but every migration is idempotent, so fix the file and
  re-run.
