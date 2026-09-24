# meterwise-cost-attribution — risks and open questions

Each entry has a letter, a title and a state:

- **RISK**: open, with a mitigation.
- **RESOLVED**: decided. The entry says what was decided and why.
- **ACCEPTED**: a cost we carry knowingly.
- **SETTLED**: decided for now, to be revisited on a stated cadence.

## MW-A — Custody of the customer's provider API key in the MW3 proxy (RESOLVED)

The proxy must handle each customer's OpenAI or Anthropic key. Decided: pass
it through per request, never store or log it (design §7). The proxy has no
database binding, so it structurally cannot persist the key. It reads the key
in one function, logs one fixed shape, and returns fixed error strings. Seven
tests (design §7.6) run against a mock upstream and scan the database, the
logs, the error bodies and the ledger request for the key. Storing keys was
rejected because it would make Meterwise a vault of every customer's provider
credentials, and it would need envelope encryption with a key held outside D1,
rotation, an access model and a decryption audit trail, for a convenience the
customer's own secret store already gives them. Revisit only if a customer
needs server-side calls with no key in their own runtime, and then as its own
security design.

## MW-B — Providers beyond OpenAI and Anthropic (RISK, open)

The `2026-09-24` table prices OpenAI and Anthropic only. Google's Gemini
pricing page (`ai.google.dev/gemini-api/docs/pricing`) redirected to a Google
sign-in when this build fetched it, so no price could be read from the source,
and a price that is not read from the source does not go in the table. Azure
OpenAI, Bedrock and Vertex list their own prices (often regional) and report
model ids with provider prefixes (`anthropic.claude-sonnet-5`). Their events
are stored as `unknown_model` and counted as unpriced until a version adds
them. Mitigation: each new provider is a new price version with cited rows.

## MW-C — Cache, batch, priority and long-context pricing (RISK, open)

MW1 prices `inputTokens` at the base input rate and `outputTokens` at the base
output rate. Real bills differ. OpenAI bills cached input at about a tenth of
the input rate, and its `prompt_tokens` includes cached tokens, so MW1
over-states OpenAI cost for cache-heavy workloads. Anthropic reports cache
reads and writes separately from `input_tokens` at different rates, so an SDK
that reports only `input_tokens` under-states it. Batch is half price, and
priority ("Fast mode") costs more. OpenAI's `gpt-5.5` and `gpt-5.4` cost more
above 272K input tokens, and MW1 stores only the short-context price. All of
these are known, bounded mis-statements, and the Costs page says "list price,
base rates". Mitigation: a later price version adds `cached_input`,
`cache_write` and a `tier` dimension, and the ingest schema adds optional
`cachedInputTokens` / `cacheWriteTokens` / `tier` fields. Existing events keep
their version (design §2.3).

## MW-D — Stripe revenue join and export to Stripe metered billing (RISK, open)

The pitch's gross-margin view needs each customer's Stripe revenue per
tenant, and the export needs to write meter events to their Stripe account.
Both need a Stripe credential or a Stripe Connect app, and neither was handed
to this build. Not built. It needs an owner decision on Connect (OAuth,
revocable, least privilege) versus restricted keys, an integrations-worker
provider, and a mapping from Meterwise `tenant` strings to Stripe customer
ids.

## MW-E — The pricing simulator (RISK, open)

"What would this usage cost on seat, usage or hybrid pricing" is a pure
function over the ledger once MW-D gives revenue. Not scheduled.

## MW-F — Re-pricing unpriced events (RISK, open)

An event for a model the table did not know is stored `unknown_model`. When a
later version adds the model, those events stay unpriced. Mitigation: an
owner-triggered re-price (`POST llm-events/reprice`) that prices only rows
still `unknown_model` with the version in effect at their `occurred_at`, and
never touches a priced row. Not in MW1–MW3.

## MW-G — Raw-event volume in D1 (RISK, open)

Every LLM call is one row. D1 is comfortable at the tens of millions of rows a
seed-stage customer produces in a year, but aggregate reads over large windows
slow down linearly. Mitigation, in order: MW2's monthly rollups serve the hot
path; a daily rollup table for the Costs page; Workers Analytics Engine for raw
events (the pitch's suggestion) if a customer's volume demands it. No
retention policy yet. Events are kept, and deleting a customer's data follows
the baseline's organization deletion.

## MW-H — Integer ceilings (ACCEPTED)

Costs are nano-USD, summed by SQLite as 64-bit integers and returned to
JavaScript as numbers, which are exact to 2⁵³ ≈ $9.0M per cost row per window.
A single event's arithmetic is BigInt and cannot overflow. Accepted until a
single tenant spends $9M in one window, when sums move to BigInt strings.

## MW-I — Budget overshoot under concurrency (ACCEPTED)

A hard budget can be exceeded by the cost of the calls in flight when it is
crossed, because the check precedes the call and the cost follows it. A
Durable Object would not remove this (design §6). Accepted for MW2, and
stated in the console. MW3's proxy can reserve-then-settle because it sees
both ends of the call. A DO or KV cache is added only if `llm-check` misses
its latency target on stage.

## MW-J — How ledger-worker reports tracked spend to the metering context (RISK, open)

The plan's allowance ($1,000/month tracked on Free) belongs in the baseline's
metering and quota context. `metering-worker`'s routes authorize a member with
`organization.metering.write`, which the SDK's `builder` key lacks and a cron
has no member to act as. Options for MW2: an internal, system-actor route on
metering-worker, or a daily cron in ledger-worker writing through the metering
repository. The first keeps the context boundary and is preferred. Decide in
MW2.

## MW-K — Observability capturing headers in front of the proxy (RISK, open)

Custody (MW-A) covers what Meterwise's code does. Cloudflare Logpush with
request headers, a tail Worker, or a future observability change could
capture `Authorization` in front of the code. Mitigation: none of these is
enabled for `proxy-worker`, and the proxy's `component.yaml` and wrangler
template carry a comment that enabling any of them needs a security review
against design §7.

## MW-L — API key revocation takes up to 30 seconds at the edge (ACCEPTED)

The baseline's api-edge caches a successful bearer resolution for 30 s per
colo. A revoked ingest key can report events for up to 30 s in a colo where it
was just used. Those events are the customer's own usage, attributed to their
own org, so the exposure is small. Accepted as the baseline's trade-off.

## MW-M — Ingest keys carry the whole `builder` role (RISK, open)

The baseline's API keys take an organization role. The narrowest that can
ingest is `builder`, which can also create projects and read config. A leaked
SDK key is therefore more than an ingest key. Mitigation: an `ingest`-only
role or a key scope in the identity context. That is a baseline change and is
not scheduled here. Customers are told to keep the key server-side, like the
provider key it sits next to.

## MW-N — The price table goes stale (SETTLED, reviewed monthly)

Provider prices change, often with little notice, and OpenAI's `gpt-5.6-sol`
price is explicitly promotional until at least 2026-11-21. A stale table
mis-prices silently. Settled: the table is versioned data, every row records
the day it was read, the Price table page shows that date, and the table is
re-read from the sources monthly (and on any announced change) into a new
version.
