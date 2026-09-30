# proxy-worker — runbook

- One log line per request: `{requestId, org, route, outcome, status,
  upstreamStatus, latencyMs, model, tokens, metered}`. `metered: false` on an
  `ok` line means ledger-worker did not store the call (check its health).
- `GET /health` → `checks.upstream` is `"openai"` in prod and `"override"` on
  stage (the mock upstream). Prod showing `"override"` is an incident.
- Never enable Logpush with request headers, a tail Worker or header capture
  for this Worker without a security review (risk MW-K).
