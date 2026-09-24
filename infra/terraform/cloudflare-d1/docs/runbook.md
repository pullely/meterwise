# cloudflare-d1 — runbook

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
# published outputs (names only, per environment)
orun secrets list --org <ws> --env stage
orun secrets list --org <ws> --env prod
```

## Common failures

- **"Resource already exists" with empty platform state**: adoption
  (`adopt.tf`) imports at plan time; if a root lacks adoption the
  resource must be state-migrated or deleted.
- **Provider auth failure**: the workspace's Cloudflare connection is
  missing or revoked — reconnect it in the console; secrets are brokered
  from it per run.
- **`Authentication error (10000)` on a D1 resource**: the lane resolved
  the `workers-deploy` token, which deliberately cannot touch D1 — bind
  `CLOUDFLARE_D1_TOKEN` (the `d1-edit` template) instead.
