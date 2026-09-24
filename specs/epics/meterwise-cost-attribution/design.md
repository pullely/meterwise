# meterwise-cost-attribution — design

Meterwise sits on the `cirrus` baseline. It adds one bounded context,
`ledger`, owned by `ledger-worker`, and in MW3 a second worker,
`proxy-worker`, that owns nothing in the database at all. Everything else is
the baseline's: an organization is a Meterwise customer (an AI SaaS company),
its members use the console, and its SDK authenticates with an ordinary
baseline API key. api-edge rate-limits every call, the policy engine decides
every action, `events-worker` keeps the audit trail, and `notifications-worker`
sends the email.

Vocabulary, because "tenant" means two things here. An **organization** is
Meterwise's customer. A **tenant** is *that customer's* customer: an opaque
string the customer chooses (`acme-corp`, `cus_123`), which Meterwise never
interprets. A **feature** is the customer's product surface that made the
call (`summarize`, `support-bot`). A **user** is the customer's end-user,
also an opaque string. Meterwise stores these strings as given and never
needs to resolve them to anything.

## 1. The resources

All tables carry `org_id`, every read and write is scoped by it, and every
id is a UUID in D1 with a public prefix on the wire.

### 1.1 Price table versions and model prices (MW1)

`ledger_price_versions`: `version` (natural key, a date string such as
`2026-09-24`), `effective_from` (ISO timestamp), `published_on`,
`description`. `ledger_model_prices`: `(version, provider, model)` as the
primary key, `display_name`, `input_micros_per_mtok`,
`output_micros_per_mtok` (integers, micro-USD per million tokens), `source_url`
and `checked_on` (the provider page the price was read from, and the day).

The price table is **global data, not per-org**, and it ships in migrations.
A new provider price is a new version in a new migration, never an `UPDATE`
of an existing row (§2.3). Seeds use `ON CONFLICT DO NOTHING`, because the
SQLite schema test applies every migration twice.

### 1.2 LLM events: `mwe_` (MW1)

`ledger_events` is the ledger. One row per LLM call the customer reported:

| column | meaning |
|---|---|
| `id` | UUID, `mwe_<hex>` on the wire |
| `org_id` | the Meterwise customer |
| `event_key` | the client's `eventId`, unique per org (§3) |
| `fingerprint` | SHA-256 of the event's canonical content, to tell a retry from a collision (§3) |
| `tenant`, `feature`, `end_user` | the customer's attribution strings; `feature` and `end_user` may be null |
| `provider`, `model` | as reported, lower-cased |
| `priced_model` | the price-table model it matched (§2.4), or null |
| `input_tokens`, `output_tokens` | integers, 0 to 10,000,000 each |
| `latency_ms` | optional, 0 to 3,600,000 |
| `occurred_at` | when the call happened (client-supplied, defaulting to receipt) |
| `received_at` | when Meterwise stored it |
| `price_status` | `priced`, `unknown_model` or `before_price_table` |
| `price_version`, `input_price_micros`, `output_price_micros` | the version and the two unit prices that priced it, copied onto the row |
| `cost_nanousd` | the cost, in nano-USD; null exactly when `price_status` is not `priced` |
| `source` | `sdk` (MW1) or `proxy` (MW3) |
| `recorded_by` | the actor that reported it (the API key's service principal) |

CHECK constraints pin every enum, every range, and the rule that a priced
row has a version, both unit prices and a cost, while an unpriced row has
none of them.

An unknown model is **recorded, not rejected**. The ledger must not lose
usage because a customer adopted a model the table does not know yet; the
row is stored with its tokens and `price_status = 'unknown_model'`, and every
cost read reports how many such events it left out (`unpricedEvents`).
Re-pricing stored unpriced events once the table learns the model is MW-F.

### 1.3 Costs (MW1, derived)

Cost per tenant, feature, model, provider or user is a `GROUP BY` over
`ledger_events` for a date window. Nothing is materialised in MW1. The
indexes `(org_id, occurred_at)` and `(org_id, tenant, occurred_at)` carry the
reads. MW2 adds a month-to-date rollup for the pre-flight check (§6), and
raw-event volume beyond D1's comfort is MW-G.

### 1.4 MW2 resources

- `ledger_budgets` (`mwb_`): per org, per tenant (or `*` for the org-wide
  default), per calendar month (UTC): `soft_limit_nanousd`,
  `hard_limit_nanousd` (either may be null, soft < hard when both are set),
  and a `downgrade` map (`{ "gpt-6-sol": "gpt-6-luna" }`) used between the
  two limits.
- `ledger_spend_rollups`: `(org_id, tenant, period)` primary key,
  `cost_nanousd`, `events`, maintained at ingest by one
  `INSERT … ON CONFLICT DO UPDATE SET cost_nanousd = cost_nanousd +
  excluded.cost_nanousd` per accepted event, which SQLite applies atomically.
  The migration backfills it from `ledger_events` once.
- `ledger_alerts` (`mwa_`): one row per raised anomaly, `UNIQUE (org_id,
  kind, subject, window_start)`, claimed with `INSERT … ON CONFLICT DO
  NOTHING RETURNING id`, so two cron ticks cannot email twice.

### 1.5 MW3 resources

None. The proxy writes ledger events with `source = 'proxy'` through
`ledger-worker` and stores nothing of its own (§7).

## 2. Money and the price table

### 2.1 Units

- A price is **micro-USD per million tokens**, an integer: $2.50 / MTok is
  `2500000`.
- A cost is **nano-USD**, an integer: $0.0031 is `3100000`.
- The API returns `costNanoUsd` (integer) and `costUsd` (an exact decimal
  string with nine places, e.g. `"0.003100000"`). Nothing is ever a float.

### 2.2 The arithmetic, and its one rounding

For one event priced at input price `Pi` and output price `Po` (micro-USD per
MTok):

```
cost_nanousd = round_half_up( (input_tokens × Pi + output_tokens × Po) / 1000 )
```

because one token at `P` micro-USD per million costs `P / 10⁶` micro-USD,
which is `P / 1000` nano-USD. The product is computed with BigInt, so ten
million tokens at $1,000 / MTok cannot overflow, and the single rounding
happens once per event. Every price in the `2026-09-24` table has at most
three decimals per MTok, so every cost it produces is exact and the rounding
never fires. It is there for the first price that has four decimals.

Sums are taken by SQLite (64-bit integers) and returned as JavaScript
numbers, exact up to 2⁵³ nano-USD, which is about $9 million in one cost
row for one window. That is far beyond a single customer-month at this
stage. The ceiling is recorded as MW-H.

### 2.3 Versions: a price change never rewrites history

A version applies to events whose `occurred_at` is on or after its
`effective_from`. An event is priced with the latest version in effect at
`occurred_at`, and the version and both unit prices are copied onto the row.
Changing a price means adding a version, so events already stored keep the
price that was true when they happened, and the cost read reports which
versions contributed (`priceVersions`). An event older than the first version
is stored with `price_status = 'before_price_table'` rather than priced with
a table that did not exist yet.

### 2.4 Matching a reported model to a price row

Providers report dated snapshots (`gpt-4o-mini-2024-07-18`,
`claude-haiku-4-5-20251001`). The match is, in order:

1. the exact `(provider, model)` row, lower-cased;
2. otherwise the same model with one trailing snapshot suffix removed:
   `-YYYY-MM-DD` or `-YYYYMMDD`, and nothing else.

There is deliberately no prefix matching. `gpt-4o-audio-preview` must not be
priced as `gpt-4o`, and `gpt-4o-2024-05-13` has its own, higher price, which
step 1 finds before step 2 could strip it to `gpt-4o`. A reported model that
matches neither is `unknown_model`.

### 2.5 The `2026-09-24` price table: sources

Read on **2026-09-24** from the providers' own pricing pages, standard
(non-batch, non-priority) tier, base input and output rates only:

- **OpenAI**: <https://developers.openai.com/api/docs/pricing>
  (`platform.openai.com/docs/pricing` redirects there), the "Standard" table.
  For the models the page prices by context length it lists a "short context"
  column and, for `gpt-5.5` and `gpt-5.4`, a "<272K context length" price.
  The table stores that short-context price. A long-context call is under-
  priced (MW-C).
- **Anthropic**: <https://platform.claude.com/docs/en/about-claude/pricing>
  (`docs.claude.com/…/pricing` redirects there), "Model pricing", base input
  and output. Model ids from
  <https://platform.claude.com/docs/en/models/overview>. The page states that
  Claude 4.6 and later models bill the full 1M context at the standard rate.
- **Google Gemini** is not in the table: `ai.google.dev/gemini-api/docs/pricing`
  answered with a redirect to a Google sign-in when fetched, so no price could
  be read from the source. It is MW-B.

| provider | model | input $/MTok | output $/MTok |
|---|---|---|---|
| openai | gpt-6-astra | 10.00 | 50.00 |
| openai | gpt-6-sol | 2.00 | 10.00 |
| openai | gpt-6-luna | 0.10 | 0.50 |
| openai | gpt-5.6-sol | 4.00 | 20.00 |
| openai | gpt-5.6-terra | 2.00 | 12.00 |
| openai | gpt-5.6-luna | 0.20 | 1.20 |
| openai | gpt-5.5 | 5.00 | 30.00 |
| openai | gpt-5.4 | 2.50 | 15.00 |
| openai | gpt-5.4-mini | 0.75 | 4.50 |
| openai | gpt-5.4-nano | 0.20 | 1.25 |
| openai | gpt-5.2 | 1.75 | 14.00 |
| openai | gpt-5.1 | 1.25 | 10.00 |
| openai | gpt-5 | 1.25 | 10.00 |
| openai | gpt-5-mini | 0.25 | 2.00 |
| openai | gpt-5-nano | 0.05 | 0.40 |
| openai | gpt-4.1 | 2.00 | 8.00 |
| openai | gpt-4.1-mini | 0.40 | 1.60 |
| openai | gpt-4.1-nano | 0.10 | 0.40 |
| openai | gpt-4o | 2.50 | 10.00 |
| openai | gpt-4o-2024-05-13 | 5.00 | 15.00 |
| openai | gpt-4o-mini | 0.15 | 0.60 |
| openai | o3 | 2.00 | 8.00 |
| openai | o4-mini | 1.10 | 4.40 |
| anthropic | claude-fable-5-1 | 10.00 | 50.00 |
| anthropic | claude-opus-5-5 | 4.00 | 20.00 |
| anthropic | claude-sonnet-5 | 2.00 | 10.00 |
| anthropic | claude-haiku-4-5 | 1.00 | 5.00 |
| anthropic | claude-opus-5 | 5.00 | 25.00 |
| anthropic | claude-opus-4-8 | 5.00 | 25.00 |
| anthropic | claude-opus-4-7 | 5.00 | 25.00 |
| anthropic | claude-opus-4-6 | 5.00 | 25.00 |
| anthropic | claude-opus-4-5 | 5.00 | 25.00 |
| anthropic | claude-opus-4-1 | 15.00 | 75.00 |
| anthropic | claude-opus-4 | 15.00 | 75.00 |
| anthropic | claude-sonnet-4-6 | 3.00 | 15.00 |
| anthropic | claude-sonnet-4-5 | 3.00 | 15.00 |
| anthropic | claude-sonnet-4 | 3.00 | 15.00 |

The page also notes that OpenAI's GPT-5.6 Sol price is promotional "at least
through November 21, 2026". When it ends, that is a new version.

## 3. Idempotent ingest: a retried event is never counted twice

The SDK reports an event after the LLM call returns, and networks fail, so
the SDK retries. Every event carries a client-chosen `eventId` (1–128 chars
of `[A-Za-z0-9._:-]`; the SDK uses a UUID it generates before the call). The
database holds `UNIQUE (org_id, event_key)`, and the write is one statement:

```sql
INSERT INTO ledger_events (…) VALUES (…)
ON CONFLICT (org_id, event_key) DO NOTHING
RETURNING id
```

A returned row means **accepted**. No row means the id was already used, and
the stored row is read back. Its `fingerprint` (SHA-256 over the canonical
tenant, feature, user, provider, model and token counts) decides the answer:

- same fingerprint: **`duplicate`**. The response carries the stored event's
  id and cost, and nothing is counted again;
- different fingerprint: **`conflict`**. A different call reused the id. The
  first write wins, and the new one is refused and reported, never merged.

There is no read-then-insert check, so two concurrent retries of one event
cannot both be accepted, and a test fires them concurrently. The outcome is
read from `RETURNING`, never from `rowCount` after a write without it
(runbook trap 22). api-edge's `Idempotency-Key` header still works as the
baseline's whole-request replay, but correctness does not depend on it:
a retry that arrives without the header, or with a new one, is still a
`duplicate`.

A batch holds 1 to 100 events. It is validated whole first (any invalid event
→ 422 naming `events[i].field`, nothing written), then each event is claimed
in order. The response lists one result per event, in order, plus
`accepted`, `duplicates` and `conflicts` counts, and answers 200 even when
every event was a duplicate, because a retry is a success.

`occurredAt` may be at most 5 minutes in the future and at most 35 days in
the past. The lower bound keeps late retries possible and closed months (MW2's
budget periods) closed.

## 4. The API

### 4.1 MW1: `ledger-worker`, behind api-edge's `ledger` facade

All routes are under `/v1/organizations/{org}/`, authenticated at api-edge
(a session or a baseline API key), and authorized in the worker through
membership and policy. A caller that is not allowed gets **404**, never 403.

| route | action | answer |
|---|---|---|
| `POST llm-events` | `ledger.ingest` | 200 `{ results[], accepted, duplicates, conflicts }`; 422 on an invalid batch |
| `GET llm-events?tenant=&feature=&model=&limit=&before=` | `ledger.read` | the newest events, paged by `received_at` |
| `GET llm-costs?by=tenant\|feature\|model\|provider\|user&from=&to=&tenant=` | `ledger.read` | `{ by, from, to, currency: "USD", rows[], totals, priceVersions[] }`; each row has `key`, `events`, `inputTokens`, `outputTokens`, `costNanoUsd`, `costUsd`, `unpricedEvents`, `avgLatencyMs` |
| `GET llm-prices?version=` | `ledger.read` | the versions, and the rows of one version (default: the latest) with their sources |

`from` and `to` are UTC dates, both inclusive, defaulting to the first of the
current month and today. The window is at most 366 days. An ingest result
item is `{ eventId, id, status: accepted|duplicate|conflict, priceStatus,
priceVersion, costNanoUsd, costUsd }`.

Policy: `ledger.read` for every org role (owner, admin, builder, viewer,
billing_admin), `ledger.ingest` for owner, admin and builder. The SDK's API
key is created with the `builder` role.

### 4.2 MW2

| route | action |
|---|---|
| `GET / PUT / DELETE budgets/{tenant}` and `GET budgets` | `ledger.read` / `ledger.budget.write` (owner, admin) |
| `POST llm-check` `{ tenant, feature?, user?, provider, model, estimatedInputTokens? }` | `ledger.ingest`: `{ decision: allow\|warn\|deny\|downgrade, model, spentNanoUsd, softLimitNanoUsd, hardLimitNanoUsd, reason }` |
| `GET alerts` | `ledger.read` |

The check never calls a provider and never blocks a call by itself. It
answers, and the SDK (or MW3's proxy) acts on the answer.

### 4.3 MW3: `proxy-worker`, its own public origin

`POST https://meterwise-proxy-{env}.<subdomain>.workers.dev/v1/chat/completions`,
OpenAI-compatible, streaming and not. §7 is its specification.

## 5. Authentication, authorization and rate limits

**The SDK's credential is a baseline API key.** An owner or admin creates it
in the console (`POST /v1/organizations/{org}/api-keys`, role `builder`); the
secret is shown once, and identity-worker stores only its SHA-256 and prefix.
The SDK sends it as `Authorization: Bearer <key>`. api-edge resolves it
through identity-worker into a `service_principal` actor carrying the key's
org. `ledger-worker` asks membership for that principal's role binding in
the org named by the path, and policy for the action. So:

- no key, a malformed key, a revoked or an expired key → **401** at the edge;
- a valid key of org A used on org B's path → **404** (no membership in B);
- a signed-in user who is not a member → **404**.

**Revocation latency.** api-edge caches a successful bearer resolution for
`ACTOR_CACHE_TTL_SECONDS` = 30 s, colo-locally, keyed by the token's hash.
A revoked key can therefore keep working for up to 30 seconds in a colo that
just resolved it. This is the baseline's documented trade-off and Meterwise
keeps it. Stage verification waits it out before asserting the 401.

**Rate limits.** A new api-edge route family, `ledger`: 600 requests/min per
identity (per key) and 1,200/min per org for writes, generous in-isolate
buckets for reads. At 100 events per request that is 60,000 events a minute
per key before a 429, which is the baseline's own limiter, not a new one.

**Audit.** Ingest is telemetry, not an administrative act, and auditing
every LLM call would drown the audit trail the baseline keeps for people.
MW1 writes no audit event per ingest; the ledger row is the record, with
`recorded_by`. Budget changes (MW2) are audited.

## 6. MW2: budgets in D1, and the overshoot we accept

The pitch suggests Durable Objects for hot-path budgets. MW2 uses D1, and
this is the trade-off.

A budget check is advisory by construction: the SDK asks before the call,
but the call's cost is only known after it, when the event is reported.
Whatever stores the counter, N concurrent requests that all pass the check
before any of them reports can overshoot a hard budget by up to N calls. A
Durable Object serialises the counter, but it cannot serialise the future;
it would remove a race that does not exist (D1 writes all go through one
primary, and the rollup increment is a single atomic upsert, so no report is
lost or double-applied) while leaving the one that does. The only real fix
is reserve-then-settle (debit an estimate at check time and correct it at
report time), and that belongs with the proxy in MW3, which sees both ends
of the call.

So MW2 keeps `ledger_spend_rollups` in D1, read by `llm-check` from the
primary (read-your-writes, no replicas), and states the bound: **a hard
budget can be exceeded by at most the cost of the calls that were in flight
when it was crossed**. The console says so next to the hard limit. A DO or
KV cache is added only if `llm-check` latency, measured on stage, misses the
pitch's target (MW-I).

Anomaly detection runs on a `*/15 * * * *` cron over the last window:

- **runaway loop**: a `(tenant, feature)` whose event count in the window is
  over 10 × its trailing 7-day median for the same window length and over an
  absolute floor of 200 events;
- **abusive end-user**: one `user` responsible for over 50 % of a tenant's
  spend in the last hour and over $5.

Each alert is claimed in `ledger_alerts` before it is sent (§1.4) and goes to
the org's owners and admins through `notifications-worker`. `ledger-worker` is
on the notifications internal-actor allow-list from MW1, so MW2 adds only
templates, the binding and the `dependsOn`.

Plan allowance: the Free plan tracks up to $1,000 of LLM spend a month
(pitch). MW2 reports tracked spend into the baseline metering context and
reads the entitlement through its quota check, rather than inventing a
second metering system. Whether that write goes through metering-worker's
route as a system actor or through the metering repository is MW-J.

## 7. MW3: the proxy and the customer's provider key, as a security design

### 7.1 The decision

**The customer's provider API key is passed through per request and never
stored or logged by Meterwise.** It arrives in the request, is copied into
exactly one outbound request to the provider, and is gone when the request
ends. It is not written to D1, KV, R2, the Cache API, an audit or domain
event payload, a ledger row, a notification, an error message or a log line,
on any path, including every error path.

Storing keys (so customers configure them once) was considered and rejected
for this release. It would make Meterwise a vault of every customer's OpenAI
and Anthropic credentials, the most valuable thing an attacker could take
from it; it would need envelope encryption with a key outside D1, a rotation
story, an access model for who can read or replace a key, and an audit trail
of every decryption. None of that buys anything the customer's own secret
store does not already do. Per-request pass-through is also what the OpenAI
SDK already does: the customer changes `baseURL`, keeps `apiKey`, and adds
one header.

### 7.2 Threat model

| threat | what stops it |
|---|---|
| a key lands in the database | `proxy-worker` has **no D1, KV or R2 binding at all**, so it cannot write one. It reports usage to `ledger-worker` as a structured event over a service binding, and that request carries no `Authorization` header, a test asserts it. |
| a key lands in a log | the proxy never logs a header, a request body or an upstream error body. Its only log line is a fixed-shape JSON object built from an allow-list of fields (§7.4). Workers Logs and `wrangler tail` see only that. |
| a key comes back in an error | error bodies are built from fixed strings. An upstream 4xx/5xx body is passed to the caller unchanged (it is the provider's answer to the caller's own request) but never parsed into a Meterwise message, logged or stored. |
| a key goes somewhere other than the provider | the upstream origin is fixed per provider in the Worker's configuration (`https://api.openai.com`); nothing in the request can change it. There is no "base URL" parameter, so the proxy is not an open relay for credentials. |
| Meterwise's own key leaks to the provider | the proxy strips `x-meterwise-key` and every `x-meterwise-*` header before forwarding. |
| a Meterwise key is confused with the provider key | they travel in different headers: `x-meterwise-key` authenticates to Meterwise, `Authorization` is the provider's. The proxy never sends `Authorization` to identity-worker, and api-edge's generic bearer resolution is not in the path (§7.3). |
| Cloudflare observability captures headers | Workers Logs records `console` output and invocation metadata, not request headers, unless the code logs them. Logpush with request headers is not enabled for the proxy, and enabling it is an explicit, reviewed change (MW-K). |

### 7.3 What flows where

```
customer app ──► proxy-worker (public origin)
                  │  x-meterwise-key ──► identity-worker /v1/auth/resolve  (service binding; only that header, as a bearer)
                  │  x-meterwise-tenant/feature/user ──► tags
                  │  Authorization (provider key) ──► api.openai.com only
                  │  response stream ──► customer, teed to a usage parser
                  └► ledger-worker internal ingest (service binding): tenant, feature, user,
                     provider, model, tokens, latency. No headers from the customer.
```

The proxy is its own Worker on its own origin, not a route behind api-edge,
because api-edge resolves `Authorization` as a Meterwise bearer on every
route. Sending a provider key through it would hand the key to the
resolver, the actor cache's hash input and identity-worker. The proxy caches
a successful Meterwise-key resolution for 30 s by hash, as api-edge does,
to keep the added latency near the pitch's 15 ms target.

### 7.4 Rules the code follows

1. The provider key is read in one function, `forwardHeaders()`, which
   builds the upstream request's headers from an allow-list (`authorization`,
   `content-type`, `openai-organization`, `openai-project`, `accept`). No
   other function reads `authorization`.
2. The only log call is `logEvent({ requestId, org, route, status,
   upstreamStatus, latencyMs, model, tokens })`. Its argument type has no
   string field that could carry a header, and a test asserts the shape.
3. No `catch` block logs or returns the caught error's message. Errors map to
   fixed codes: `upstream_unreachable` (502), `upstream_timeout` (504),
   `invalid_request` (400), `unauthenticated` (401).
4. No `Request` or `Headers` object is ever serialised (`JSON.stringify`,
   template string) anywhere in the worker.

### 7.5 Metering a stream

For `stream: true` the proxy sets `stream_options.include_usage = true` if
the caller did not, so OpenAI sends a final usage chunk (the chunk has an
empty `choices` array, which the OpenAI SDKs already accept). The response
body is teed: one branch goes to the caller untouched and unbuffered, the
other is parsed for `usage` without blocking the first. The event is
reported with `ctx.waitUntil` after the stream ends. A stream that ends
without a usage chunk (the client disconnected) is reported with the tokens
known so far and `price_status = 'usage_incomplete'` (a new status MW3 adds),
never silently dropped. Before forwarding, the proxy calls MW2's check and
refuses a `deny` with 429 `budget_exceeded`, or rewrites `model` on a
`downgrade`, telling the caller in `x-meterwise-model`.

### 7.6 Tests MW3 must carry

All against a mock upstream bound in place of the provider origin; no test
calls a real provider.

1. The mock upstream receives the provider key byte-for-byte, and does not
   receive `x-meterwise-key` or any `x-meterwise-*` header.
2. After proxied calls (streamed, non-streamed, upstream 401, upstream 500,
   upstream unreachable, client abort), a full scan of every table in the
   SQLite database behind `ledger-worker` finds no occurrence of the key.
3. A spy on `console.log/info/warn/error/debug` across all of those calls
   captures no occurrence of the key or of a distinctive substring of it.
4. No response body Meterwise builds contains the key, including 400, 401,
   429, 502 and 504.
5. The request `proxy-worker` sends to `ledger-worker` has no
   `authorization` header and no field containing the key.
6. The `proxy-worker` wrangler configuration has no `d1_databases`,
   `kv_namespaces` or `r2_buckets` entry (a configuration test).
7. A streamed call is metered with the same `cost_nanousd` as the same
   usage reported through the SDK path.

## 8. Events, audit, notifications, secrets

- MW1 writes no domain events for ingest (§5). MW2 audits
  `ledger.budget.set`, `ledger.budget.removed` and `ledger.alert.raised`
  through the D1-portable events path, and events-worker learns the
  `mwb_` and `mwa_` subject prefixes then.
- `ledger-worker` is on `NOTIFICATIONS_INTERNAL_ACTOR_VALUES` from MW1.
- MW1 and MW2 need no secret. MW3 needs none either: it holds no provider
  credential of its own.

## 9. The console

- **Costs** (`/orgs/[org]/costs`): the month-to-date total, a table grouped
  by tenant, feature, model or user (a tab each), the window picker, the
  unpriced-event count with the reason, and the recent events.
- **Price table** (`/orgs/[org]/prices`): the versions, and each row's
  prices with its source link and the day it was read.
- **API keys** are the baseline's page; the Costs page links to it with a
  "create an ingest key (role: builder)" hint and an SDK snippet.
- MW2 adds Budgets and Alerts. The Solo profile is off.

## 10. Out of scope

- The gross-margin view against Stripe revenue and export to Stripe metered
  billing: no Stripe credential was handed to this build (MW-D).
- The pricing simulator (MW-E).
- Calling any real LLM provider, from code or from a test.
- Google Gemini, Azure OpenAI, Bedrock and other providers in the price
  table, and prompt-cache, batch, priority and long-context pricing (MW-B,
  MW-C).
- Analytics Engine for raw events (MW-G), and the `meterwise.app` domain.
