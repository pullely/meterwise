# proxy-worker — overview

Meterwise's streaming, OpenAI-compatible proxy (MW3, design §7). A customer
keeps their OpenAI SDK and its `apiKey`, sets `baseURL` to this Worker's own
origin, and adds `x-meterwise-key` (a Meterwise API key, role builder) and
`x-meterwise-tenant` (plus optional `x-meterwise-feature` / `-user`).

`POST /v1/chat/completions` → authenticate the Meterwise key (identity-worker)
→ MW2's `llm-check` (deny → 429 `budget_exceeded`; downgrade → the mapped
model, told in `x-meterwise-model`) → forward to the fixed OpenAI origin with
`stream_options.include_usage` forced on for streams → tee the response: the
caller's branch untouched, the other parsed for `usage` → report the call to
ledger-worker's internal `proxy-events` route (`source = 'proxy'`, or
`usage_incomplete` when a stream ended without its usage chunk).

**Key custody:** the provider key in `Authorization` is read only by
`forwardHeaders()` and goes only to the constant upstream. This Worker has no
D1, KV or R2 binding, one fixed-shape log line, fixed-string errors, and
`tests/proxy-worker` carries the seven custody tests of design §7.6.
