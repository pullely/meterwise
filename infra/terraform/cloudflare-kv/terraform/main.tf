terraform {
  required_version = ">= 1.15.0"

  # State lives on the platform (SB1): the runner exports TF_HTTP_* per job, so
  # this block stays empty — no S3 bucket, no AWS role, no workspaces.
  backend "http" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}

# --- Providers ---

# Authenticates via the CLOUDFLARE_API_TOKEN env var (provider-native): the
# token is an orun-managed secret resolved into the job env at run time, so it
# never transits Terraform variables.
provider "cloudflare" {}

# --- Variables (standard Orun parameters) ---

variable "cloudflare_account_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare account ID (from CLOUDFLARE_ACCOUNT_ID env var)"
}

variable "orgName" {
  type    = string
  default = "sourceplane"
}

variable "owner" {
  type    = string
  default = "sourceplane"
}

variable "repo" {
  type    = string
  default = "meterwise"
}

variable "namespace" {
  type    = string
  default = "sourceplane"
}

variable "namespacePrefix" {
  type    = string
  default = ""
}

variable "lane" {
  type    = string
  default = "verify"
}

variable "environment" {
  type    = string
  default = "stage"
}

variable "component" {
  type    = string
  default = "cloudflare-kv"
}

variable "stackName" {
  type    = string
  default = "cloudflare-kv"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- KV namespace for api-edge idempotency replay store ---
#
# Backs the Stripe-style idempotency replay store added in Task 0095. Keys are
# scoped (orgId|"anon", routePath, idempotencyKey) and entries TTL'd via the
# api-edge Worker (`expirationTtl: 86400`); no Terraform-side TTL knob exists
# for KV namespaces themselves — TTL is per-PUT, owned by the Worker.

locals {
  # Brand-namespaced with var.repo so the title is unique to this fork. Cloudflare
  # KV namespace titles must be unique per account, and this fork shares an account
  # with the baseline (which uses the un-branded title) — without the brand the
  # create fails with "a namespace with this account ID and title already exists"
  # (10014). Workers resolve this KV by ID via the wiring secret, so the title is
  # free to change.
  idempotency_namespace_title = "${var.namespacePrefix}${var.repo}-api-edge-idempotency-${var.environment}"
}

resource "cloudflare_workers_kv_namespace" "api_edge_idempotency" {
  account_id = var.cloudflare_account_id
  title      = local.idempotency_namespace_title
}

# --- Wiring manifest (BF5, via orun secrets) ---
# The consumable outputs are published by the composition's wire-secrets step
# as the WIRING_CLOUDFLARE_KV secret on the project/{{env}} rung; worker
# deploys read it back as WIRING_CLOUDFLARE_KV_<ENV> secretEnv (BF6). Same
# document shape the Secrets Manager path carried.

output "wiring" {
  description = "Wiring document for downstream deploy-time binding resolution (pushed to orun secrets)"
  value = jsonencode({
    api_edge_idempotency_kv_id    = cloudflare_workers_kv_namespace.api_edge_idempotency.id
    api_edge_idempotency_kv_title = cloudflare_workers_kv_namespace.api_edge_idempotency.title
  })
}

# --- Outputs (non-secret) ---

output "api_edge_idempotency_kv_id" {
  description = "Cloudflare Workers KV namespace ID for api-edge idempotency replay store"
  value       = cloudflare_workers_kv_namespace.api_edge_idempotency.id
}

output "api_edge_idempotency_kv_title" {
  description = "Cloudflare Workers KV namespace title (human-readable identifier)"
  value       = cloudflare_workers_kv_namespace.api_edge_idempotency.title
}
