# cloudflare-d1 — architecture

A `terraform` component rooted at `infra/terraform/cloudflare-d1/terraform`.

- **State** lives in the platform's HTTP state backend (run-token auth) —
  no local state, no cloud-vendor state buckets.
- **Credentials are brokered per run** from the workspace's Cloudflare
  connection; no long-lived provider secrets exist anywhere in CI.
- **Outputs are published as job-output secrets** on the environment
  rungs: `WIRING_CLOUDFLARE_D1` (database id/name for deploy-time binding). Downstream deploy lanes resolve them by name.
- **Self-healing adoption** (`adopt.tf`): when the platform state is
  empty but the resource already exists at the provider, plan-time import
  adopts it instead of failing with "already exists" — safe re-bootstrap
  over half-torn-down attempts.
