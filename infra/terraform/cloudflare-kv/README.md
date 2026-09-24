# cloudflare-kv

Provisions Cloudflare Workers KV namespaces consumed by the `api-edge` Worker.
Today the slice ships exactly one logical store: the **api-edge idempotency
replay store** introduced in Task 0095, which closes the open-risks entry
where a duplicate POST with a valid `Idempotency-Key` could still create
duplicate pending invitations.

This component is the first KV slice in the monorepo. Future KV-backed
features (rate limiting, short-lived caches) will land here as additional
`cloudflare_workers_kv_namespace` resources rather than parallel slices, so
backend / provider configuration stays in one place.

## Overview

- **What it provisions:** one Workers KV namespace per environment
  (`stage`, `prod`), titled `${namespacePrefix}api-edge-idempotency-${environment}`
  (e.g. `stg-api-edge-idempotency-stage`, `prod-api-edge-idempotency-prod`).
- **What consumes it:** `apps/api-edge` binds the namespace as
  `IDEMPOTENCY_KV` in `wrangler.jsonc` (env.stage, env.prod). `env.dev` does
  NOT receive a binding — dev is a verify-only profile, no live worker. KV
  absence on a runtime path degrades to "execute downstream once, no
  replay" — never 5xx — by design (see api-edge `idempotency.ts`).
- **TTL:** there is no Terraform-side TTL on a KV namespace; entries are
  TTL'd per `put()` call from the Worker (`expirationTtl: 86400`, 24h).

## Architecture

```
       ┌─────────────────────┐
POST → │   api-edge Worker   │ ──── parseIdempotencyKey() (Task 0094)
       └──────────┬──────────┘
                  │
                  │ replayOrExecute(req, requestId, env, downstream)
                  │
                  ▼
       ┌─────────────────────┐         (kv hit) → reconstructed Response
       │   IDEMPOTENCY_KV    │ ◀──┐
       │  (Cloudflare KV)    │    │
       └──────────┬──────────┘    │
                  │ (kv miss)     │ put(envelope, ttl=86400)
                  ▼               │
        downstream worker fetch ──┘
```

Key shape: `idem:v1:{orgId|"anon"}:{routePath}:{idempotencyKey}` truncated
+ SHA-256 fingerprinted to fit Cloudflare's 512-byte KV key cap.
Value: JSON envelope `{ status, headers (allow-listed), body, contentType,
bodyEncoding: "utf8"|"base64", storedAt, requestId }`.

## Resources Created

| Resource | Per-env | Description |
|---|---|---|
| `cloudflare_workers_kv_namespace.api_edge_idempotency` | stage, prod | KV namespace bound to the `api-edge` Worker as `IDEMPOTENCY_KV` |

## Parameters

Standard Orun parameters (matching `cloudflare-hyperdrive`):

| Name | Type | Default | Description |
|---|---|---|---|
| `awsRegion` | string | `us-east-1` | AWS region for Terraform state backend |
| `cloudflare_account_id` | string (sensitive) | `""` | From `CLOUDFLARE_ACCOUNT_ID` env var |
| `orgName` | string | `meterwise` | Org identifier |
| `owner` | string | `meterwise` | GitHub owner |
| `repo` | string | `meterwise` | GitHub repo |
| `namespace` | string | `meterwise` | Logical namespace |
| `namespacePrefix` | string | `""` | Stage/prod prefix (`stg-`, `prod-`) |
| `lane` | string | `verify` | Orun lane |
| `environment` | string | `stage` | Target environment |
| `component` | string | `cloudflare-kv` | Component identifier |
| `stackName` | string | `cloudflare-kv` | Stack identifier |
| `terraformDir` | string | `terraform` | Terraform module dir |
| `terraformVersion` | string | `1.15.3` | Terraform version |

## Outputs

| Output | Description | Use |
|---|---|---|
| `api_edge_idempotency_kv_id` | KV namespace ID | Referenced from `apps/api-edge/wrangler.jsonc` `kv_namespaces[*].id` |
| `api_edge_idempotency_kv_title` | KV namespace title (human-readable) | Cross-checked by the verifier via `wrangler kv namespace list` |

## Dependencies

- **Cloudflare credentials**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
  must be in scope (Orun CI provides them; locally they come from your
  shell). The token needs Workers KV write permission on the target
  account.
- **No upstream Terraform component**: this slice does not consume any
  AWS Secrets Manager value or other component output. It is a peer of
  `cloudflare-hyperdrive`, not a downstream consumer.

## Environments

| Environment | Profile (default) | Profile (push-main) | Notes |
|---|---|---|---|
| `stage` | `plan-only` | `apply` | Plan on PR, apply on merge |
| `prod` | `plan-only` | `apply` | Plan on PR, apply on merge |
| `dev` | n/a | n/a | Not subscribed; api-edge dev profile has no KV binding |

`prod` waits on `stage` per `intent.yaml#environments.prod.promotion.dependsOn`.

## Secret Storage

- KV namespace IDs are NOT secrets and are surfaced as Terraform outputs +
  embedded in `apps/api-edge/wrangler.jsonc`.
- The Cloudflare API token / account ID stay sensitive Terraform variables;
  never logged, never echoed to outputs.
- KV value contents (response bodies) are stored encrypted at rest by
  Cloudflare. The api-edge Worker enforces a header allow-list before
  storing, so caller-controlled `set-cookie` / `authorization` headers
  never reach the cache.

## Configuration Details

- **Provider pin**: `cloudflare ~> 4.30` — matches the repo posture
  (`cloudflare-hyperdrive` resolves to `4.52.7`). The deferred Task 0085b
  v4→v5 upgrade owns the migration. **Do not edit the pin here.**
- **AWS provider pin**: `aws ~> 5.0`, again matching peer slices.
- **Terraform backend**: shared S3 backend, key supplied at runtime by Orun
  (`workspace_key_prefix = "env"`).
- **TTL**: no namespace-level TTL exists in the Cloudflare KV API; per-PUT
  TTL is the only knob, owned by the Worker.

## Usage in Downstream Tasks

The Worker reads `env.IDEMPOTENCY_KV` and treats the binding as optional —
absence falls through to "execute downstream, no replay." This means the
slice can be created idempotently before or after the api-edge bindings
land; the cutover is purely additive.

## Local Verification

```bash
# Validate intent
kiox exec -- orun validate

# Discover component
kiox exec -- orun component | grep cloudflare-kv

# Plan (dry)
kiox exec -- orun plan --intent intent.yaml --output plan.json

# Inspect plan
cat plan.json | jq '.jobs[] | select(.component == "cloudflare-kv") | {id, profile}'

# Dry run
kiox exec -- orun run --plan plan.json --dry-run --runner github-actions

# Terraform fmt check
terraform -chdir=infra/terraform/cloudflare-kv/terraform fmt -check
```

## Operational Notes

- **Scaling limits**: Workers KV gives you 1 GB per namespace and ~25 MB
  per value. Idempotency envelopes are small (kilobytes); we are
  comfortably below.
- **Read latency**: ~50ms p99 globally, eventually consistent within a
  region (Cloudflare-published). Stripe accepts this window.
- **Backup / restore**: KV is best-effort cache by design. Loss of a
  namespace re-opens the Task 0094 risk window (duplicate POSTs may
  re-execute) but does NOT corrupt persisted data — invitations,
  memberships, etc., live in Postgres behind the workers.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error: required field is not set` on `account_id` | `CLOUDFLARE_ACCOUNT_ID` not in env | Export `CLOUDFLARE_ACCOUNT_ID` (Orun CI does this automatically) |
| `Error: 10000: Authentication error` | Token lacks Workers KV scope | Issue a new API token with `Workers KV Storage: Edit` |
| Plan shows `0 components × N envs → 0 jobs` | Component not subscribed to PR-active env | Verify `subscribe.environments` matches `intent.yaml#environments.*.activation` |
| Wrangler `kv namespace list` doesn't show the namespace | apply didn't run, or wrong CF account | Run `kiox exec -- orun plan --intent intent.yaml` and confirm an apply job exists for the env |

## Security

- Credentials: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` only via env
  vars; never committed.
- State: encrypted S3 backend with use_lockfile = true.
- Audit: namespace creation visible in Cloudflare dashboard audit log.
- Compliance: KV is multi-region replicated; no PII is intentionally cached
  (header allow-list enforced in Worker).

## Related Tasks

- **Task 0009**: `cloudflare-hyperdrive` — pattern template for this slice.
- **Task 0090**: notifications-worker queue-level idempotency (separate
  layer, Postgres column; do not conflate).
- **Task 0094**: edge `Idempotency-Key` validation gate — landed the parser
  consumed by this replay store.
- **Task 0095** (this task): adds the durable replay store on top.
- **Task 0085b** (deferred): cloudflare provider v4→v5 migration. Do NOT
  bump this slice's pin until that task lands.

## References

- Cloudflare Workers KV: https://developers.cloudflare.com/kv/
- Stripe Idempotency-Key contract: https://stripe.com/docs/api/idempotent_requests
- Orun Terraform component spec: see the `terraform` composition in the
  [stack-tectonic](https://github.com/sourceplane/stack-tectonic) catalog
