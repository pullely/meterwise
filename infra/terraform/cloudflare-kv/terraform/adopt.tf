# --- Self-healing adoption (AWS-free state seeding) ---
#
# When the platform state does not yet track the namespace but Cloudflare
# already has one under this title (a baseline whose state predates the
# platform backend, or a recovered workspace), the create would collide with
# the duplicate-title guard (error 10014). Instead: look the namespace up at
# plan time with the job's brokered credentials and import it. Fresh products
# resolve to id = "" and create normally, and a resource already tracked in
# state short-circuits the lookup — so this block is inert everywhere except
# the one case it exists for. Both lookups run inside the job: process env
# carries the brokered CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID and the
# TF_HTTP_* state credentials, so no extra secrets and no AWS access.

data "external" "adopt_idempotency_namespace" {
  program = ["bash", "-c", <<-EOT
    set -euo pipefail
    title="$(jq -r .title)"
    state_file="$(mktemp)"
    trap 'rm -f "$state_file"' EXIT
    code="$(curl -s -o "$state_file" -w '%%{http_code}' \
      -u "$TF_HTTP_USERNAME:$TF_HTTP_PASSWORD" "$TF_HTTP_ADDRESS" || echo 000)"
    if [ "$code" = "200" ] && jq -e \
        '[.resources[]? | select(.type == "cloudflare_workers_kv_namespace" and .name == "api_edge_idempotency")] | length > 0' \
        "$state_file" >/dev/null 2>&1; then
      jq -n '{id: ""}'
      exit 0
    fi
    resp="$(curl -fsS --retry 3 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces?per_page=100")"
    printf '%s' "$resp" | jq -c --arg t "$title" \
      '{id: ([.result[] | select(.title == $t) | .id] | first // "")}'
  EOT
  ]
  query = {
    title = local.idempotency_namespace_title
  }
}

import {
  for_each = toset(compact([data.external.adopt_idempotency_namespace.result.id]))
  to       = cloudflare_workers_kv_namespace.api_edge_idempotency
  id       = "${var.cloudflare_account_id}/${each.value}"
}
