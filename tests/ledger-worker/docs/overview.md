# ledger-worker-tests — overview

Tests for `apps/ledger-worker` on a real SQLite engine (`node:sqlite`) with
every migration applied, so the unique claim, the CHECK constraints and the
seeded `2026-09-24` price table are the ones D1 runs. Covers the pricing
arithmetic against the seeded rows (hand-computed expectations), model
matching (snapshot suffixes, no prefix matching, the `gpt-4o-2024-05-13`
row), idempotent ingest (sequential retry, a concurrent retry race with
exactly one `accepted`, in-batch repeats, `conflict` on a reused id),
aggregation by every dimension with windows, validation, a service-principal
(API key) caller, and the tenant boundary.
