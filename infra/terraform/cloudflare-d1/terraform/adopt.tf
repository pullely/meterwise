# --- Self-healing adoption ---
#
# When the platform state does not yet track the database but Cloudflare
# already has one under this name (a re-bootstrap after a torn-down workspace,
# or state recovered onto a fresh backend), the create would collide with the
# duplicate-name guard. Instead: look the database up at plan time with the
# job's brokered credentials and import it. Fresh products resolve to id = ""
# and create normally, and a resource already tracked in state short-circuits
# the lookup — so this block is inert everywhere except the one case it exists
# for. Both lookups run inside the job: process env carries the brokered
# CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID and the TF_HTTP_* state
# credentials, so no extra secrets are needed.

data "external" "adopt_platform_database" {
  program = ["bash", "-c", <<-EOT
    set -euo pipefail
    name="$(jq -r .name)"
    state_file="$(mktemp)"
    trap 'rm -f "$state_file"' EXIT
    code="$(curl -s -o "$state_file" -w '%%{http_code}' \
      -u "$TF_HTTP_USERNAME:$TF_HTTP_PASSWORD" "$TF_HTTP_ADDRESS" || echo 000)"
    if [ "$code" = "200" ] && jq -e \
        '[.resources[]? | select(.type == "cloudflare_d1_database" and .name == "platform")] | length > 0' \
        "$state_file" >/dev/null 2>&1; then
      jq -n '{id: ""}'
      exit 0
    fi
    resp="$(curl -fsS --retry 3 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database?per_page=100")"
    printf '%s' "$resp" | jq -c --arg n "$name" \
      '{id: ([.result[] | select(.name == $n) | .uuid] | first // "")}'
  EOT
  ]
  query = {
    name = local.database_name
  }
}

import {
  for_each = toset(compact([data.external.adopt_platform_database.result.id]))
  to       = cloudflare_d1_database.platform
  id       = "${var.cloudflare_account_id}/${each.value}"
}
