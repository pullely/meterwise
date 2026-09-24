# Epic: meterwise-cost-attribution (MW)

**AI SaaS companies pay OpenAI and Anthropic per token, but charge their own
customers per seat or per plan. The provider's dashboard shows one total, so
nobody can say which customer, which feature or which model is eating the
margin, and a single runaway agent loop shows up only on next month's
invoice. This epic builds Meterwise in three steps. First, a usage ledger:
the customer's SDK reports every LLM call after it happens, authenticated
with an ordinary API key from the baseline, and Meterwise prices it against
a dated, versioned, cited model price table and answers "what did tenant X,
feature Y and model Z cost this month" to the nano-dollar. Second,
guardrails: soft and hard budgets per tenant, a pre-flight `check` the SDK
calls before a request that answers allow, warn, deny or "downgrade to this
cheaper model", and cron-driven anomaly alerts for a runaway loop or a
single abusive end-user. Third, a streaming, OpenAI-compatible proxy Worker
that forwards the call to the provider and meters it in flight, so a
customer can adopt Meterwise by changing a base URL. The one design idea:
every stored cost is a fact with a provenance (the event, the tokens, and
the exact price-table version that priced them), so a price change never
silently rewrites history. The proxy handles the customer's own provider API
key, and design §7 settles its custody before a line of it is written: the
key passes through per request and is never stored or logged by Meterwise.**

Meterwise is for AI-native SaaS startups (seed to Series B) and product teams
adding LLM features to an existing SaaS. A team creates an organization,
creates an API key in the console, and drops a few lines into the code path
that calls the LLM. From MW1 they see cost per tenant, per feature, per model
and per end-user. From MW2 they set budgets and get told when something is
burning money. From MW3 they can skip the SDK and point their OpenAI client at
Meterwise instead.

## Status

| Field | Value |
|-------|-------|
| Status | Draft |
| Cluster | **MW** (MW0–MW3) |
| Owner(s) | `apps/ledger-worker` (MW1: the price table, event ingest, cost reads; MW2: budgets, the pre-flight check, the anomaly cron) · `apps/proxy-worker` (MW3: the streaming OpenAI-compatible proxy) · `apps/api-edge` (the `ledger` facade and its rate-limit family) · `packages/db` (migrations `200`–`210`) · `packages/contracts` + `packages/sdk` (the wire and the reporting SDK) · `apps/notifications-worker` (MW2 templates) · `apps/web-console-next` (the surface) |
| Builds on | `cirrus baseline-v12`: organizations and members, **API keys and service principals** (identity-worker) as the SDK's credential, **api-edge's per-org / per-identity rate limiter** in front of ingest, the policy engine, the audit trail, `notifications-worker` for email, cron triggers, and (MW2) the metering and quota context for the plan's tracked-spend allowance |
| Changes | Adds one bounded context (`ledger`), two workers (`ledger-worker`, and `proxy-worker` in MW3), one cron trigger (MW2) and one public proxy origin (MW3). Turns the Solo profile off: a product team shares one organization, and an agency may run several. Baseline contexts are reused and only gain actions, templates and a rate-limit family. |
| Decisions locked | (1) Money is integers: prices are micro-USD per million tokens, costs are nano-USD, computed with exact integer arithmetic and one rounding per event (design §2). (2) The price table is data with a version. Every version is dated, every row cites the provider page it was read from and the day it was read, and every priced event stores the version and the two unit prices that priced it. A new price is a new version, never an edit (design §2.3). (3) Ingest is idempotent per org on the client's `eventId`, claimed with one `INSERT … ON CONFLICT DO NOTHING RETURNING` statement. A retried event is reported as `duplicate` and never counted twice. A different event reusing an id is reported as `conflict` (design §3). (4) The SDK authenticates with a baseline API key (a service principal with the `builder` role); nothing new is invented for credentials (design §5). (5) MW2 budgets live in D1, not Durable Objects, with the overshoot bound written down (design §6). (6) **MW3 key custody: the customer's provider key is passed through per request and never stored or logged by Meterwise**: not in D1, KV, an audit payload, an error message or a log line, enforced structurally (the proxy has no database binding) and by tests (design §7). (7) No real provider is ever called by a test; MW3 tests run against a mock upstream. |
| Gate | MW1 is the first user-visible change: report usage, see cost. MW2 turns the ledger into margin protection. MW3 opens the one surface that touches a customer's provider credential, behind the rules of design §7. |
| Shipped as | |

## Read order

1. `design.md`: the resources, the pricing arithmetic and the price table, idempotent ingest, the routes, authentication and rate limits, the MW2 consistency trade-off (§6), the MW3 key-custody security design (§7), the console, and what is out of scope
2. `implementation-plan.md`: the milestones and what "done" means for each
3. `risks-and-open-questions.md`: what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md`: what actually shipped, kept separate from intent

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| MW0 — the spec | this doc set | merged and pushed with `orun spec push` |
| MW1 — the usage ledger | the `ledger` context (migration `200_ledger_core`): the dated, cited price table (version `2026-09-24`, OpenAI and Anthropic), `ledger-worker` with an ingest endpoint authenticated by baseline API keys (tenant, feature, user, provider, model, input/output tokens, latency), idempotent per `eventId`, costs per tenant / feature / model / user computed from the two with the price version recorded, the `ledger` facade and rate-limit family on api-edge, the SDK's `client.ledger`, and the console Costs and Price table pages | on stage an API key ingests events, a retried event is a `duplicate` and is not double-counted, cost per tenant, feature and model matches a hand computation from the price table, a missing or revoked key gets 401, and a non-member gets 404 |
| MW2 — budgets and guardrails | `210_ledger_guardrails`: soft and hard monthly budgets per tenant with a downgrade map, month-to-date spend rollups maintained at ingest, `POST …/llm-check` answering allow / warn / deny / downgrade, an anomaly cron (runaway loop, single abusive end-user) that emails owners and admins once per window through `notifications-worker`, and the plan's tracked-spend allowance through the baseline metering context | on stage a tenant crossing its soft budget gets `warn` (or `downgrade` with the configured model), crossing its hard budget gets `deny`, a synthetic burst raises exactly one alert per window, and the email goes through notifications |
| MW3 — the streaming proxy | `proxy-worker`: OpenAI-compatible `POST /v1/chat/completions` (streaming and not), authenticated by a Meterwise API key in its own header, forwarding the customer's provider key untouched, metering in flight from the stream's usage, and honouring MW2's check before forwarding | the key-custody tests of design §7.6 pass against a mock upstream, a streamed call is metered with the same cost the SDK path would record, and on stage the proxy answers with a mock-free 401/400 without any provider key being stored anywhere |

Later, and not built here: the gross-margin view against Stripe revenue and
export to Stripe metered billing (MW-D: no Stripe credential was handed to
this build), the pricing simulator (MW-E), Google Gemini and other providers
in the price table (MW-B), prompt-cache token pricing (MW-C), Analytics
Engine for high-volume raw events (MW-G), and the `meterwise.app` domain. See
`risks-and-open-questions.md`.
