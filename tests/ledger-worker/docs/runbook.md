# ledger-worker-tests — runbook

Run with `pnpm --filter @saas/ledger-worker-tests test`. Needs Node 22+ for
`node:sqlite`. If a suite crashes with no failing test named, re-run with
`--maxWorkers=2` after the script's own arguments (no `--`).
