/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { applyMigration, migratedDatabase, world } from "./harness";
import { ev, ingest, ok } from "./fixtures";

const INDEXES = [
  "idx_ledger_events_occurred",
  "idx_ledger_events_org_occurred",
  "idx_ledger_events_org_received",
  "idx_ledger_events_org_tenant_occurred",
  "uq_ledger_events_org_key",
];

describe("migration 220_ledger_usage_incomplete (a table rebuild)", () => {
  it("keeps every row and every index through the rebuild, and replays", async () => {
    const full = world();
    await ok(await ingest(full, [ev(), ev({ tenant: "globex" }), ev({ model: "no-such-model" })]));
    const rows = full.db.prepare("SELECT * FROM ledger_events ORDER BY id").all() as Record<string, any>[];

    const db = migratedDatabase("210_ledger_guardrails");
    const cols = Object.keys(rows[0]!);
    const insert = db.prepare(`INSERT INTO ledger_events (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const r of rows) insert.run(...cols.map((c) => r[c]));
    // Before 220 the status does not exist.
    expect(() => db.exec("UPDATE ledger_events SET price_status = 'usage_incomplete', price_version = NULL, priced_model = NULL, input_price_micros = NULL, output_price_micros = NULL, cost_nanousd = NULL, source = 'proxy' WHERE tenant = 'globex'")).toThrow(/CHECK/);

    applyMigration(db, "220_ledger_usage_incomplete");
    applyMigration(db, "220_ledger_usage_incomplete");
    expect(db.prepare("SELECT * FROM ledger_events ORDER BY id").all()).toEqual(rows);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger_events' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(INDEXES);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ledger_events_v220'").get()).toBeUndefined();

    // The unique claim key survived the rebuild.
    expect(() => db.prepare(`INSERT INTO ledger_events (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => (c === "id" ? crypto.randomUUID() : rows[0]![c])))).toThrow(/UNIQUE/);
  });

  it("allows usage_incomplete only unpriced and only from the proxy", () => {
    const db = migratedDatabase();
    const row = (status: string, source: string, cost: number | null) =>
      db
        .prepare(
          `INSERT INTO ledger_events (id, org_id, event_key, fingerprint, tenant, provider, model, input_tokens, output_tokens, occurred_at, received_at, price_status, cost_nanousd, source)
           VALUES (?, 'o', ?, ?, 't', 'openai', 'gpt-4o', 0, 2, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z', ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), crypto.randomUUID(), "f".repeat(64), status, cost, source);
    expect(() => row("usage_incomplete", "proxy", null)).not.toThrow();
    expect(() => row("usage_incomplete", "sdk", null)).toThrow(/CHECK/);
    expect(() => row("usage_incomplete", "proxy", 5)).toThrow(/CHECK/);
  });
});
