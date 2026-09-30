# proxy-worker — architecture

| file | job |
|---|---|
| `index.ts` | routes: `GET /health`, `POST /v1/chat/completions`, 404/405 |
| `auth.ts` | `x-meterwise-key` → identity-worker `/v1/auth/resolve`; 30 s in-isolate cache by SHA-256 |
| `headers.ts` | `forwardHeaders()` (the only reader of the provider key) and the returned-header allow-list |
| `ledger.ts` | `llm-check` and the internal `proxy-events` report over `LEDGER_WORKER` |
| `upstream.ts` | the constant OpenAI origin; `UPSTREAM_OVERRIDE` (stage/tests only) |
| `meter.ts` | reads `usage` from a JSON body or an SSE stream |
| `log.ts` | `logEvent()`, the only console call |
| `errors.ts` | the fixed error strings |

Bindings: `IDENTITY_WORKER`, `LEDGER_WORKER` (stage and prod), and on stage
only `UPSTREAM_OVERRIDE` → `meterwise-mock-upstream-stage`. No storage.
