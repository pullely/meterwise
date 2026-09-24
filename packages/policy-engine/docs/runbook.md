# policy-engine — runbook

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

The lane itself is the gate: typecheck, lint, test, build. This package
has no deployed surface.

## Common failures

- **A dependent's lane fails to build after a change here**: the change
  was source-compatible but not type-compatible — run
  `pnpm typecheck` across the workspace before landing.
