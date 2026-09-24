import { costNanoUsd, formatPricePerMtok, formatUsd, modelCandidates } from "@saas/contracts/ledger";
import { createLedgerRepository } from "@saas/db/ledger";
import { createSqlExecutor } from "@saas/db/d1";
import { PriceBook } from "@ledger-worker/pricing";
import { d1Over, migratedDatabase } from "./harness";

// Every expectation below is computed by hand from the 2026-09-24 table
// (design §2.5): cost_nanousd = (in × Pin + out × Pout) / 1000, Pin/Pout in
// micro-USD per million tokens.

function book(): Promise<PriceBook> {
  return PriceBook.load(createLedgerRepository(createSqlExecutor(d1Over(migratedDatabase()))));
}

describe("the pricing arithmetic", () => {
  it("prices a call exactly in nano-USD", () => {
    // gpt-4o: $2.50 in / $10.00 out → 1000 × 2.5e6 + 500 × 1e7 = 7.5e9 → 7,500,000 n$ = $0.0075
    expect(costNanoUsd(1000, 500, 2_500_000, 10_000_000)).toBe(7_500_000);
    expect(costNanoUsd(0, 0, 2_500_000, 10_000_000)).toBe(0);
  });

  it("rounds half up, once", () => {
    expect(costNanoUsd(1, 0, 1500, 0)).toBe(2); // 1.5
    expect(costNanoUsd(1, 0, 1499, 0)).toBe(1); // 1.499
    expect(costNanoUsd(1, 0, 500, 0)).toBe(1); // 0.5
    expect(costNanoUsd(1, 0, 499, 0)).toBe(0); // 0.499
    // one rounding for the sum, not one per side: 0.5 + 0.5 = 1, not 1 + 1
    expect(costNanoUsd(1, 1, 500, 500)).toBe(1);
  });

  it("cannot overflow at the limits", () => {
    expect(costNanoUsd(10_000_000, 10_000_000, 999_999_999, 999_999_999)).toBe(19_999_999_980_000);
  });

  it("refuses non-integers and negatives", () => {
    expect(() => costNanoUsd(1.5, 0, 1, 1)).toThrow(RangeError);
    expect(() => costNanoUsd(-1, 0, 1, 1)).toThrow(RangeError);
  });

  it("formats nano-USD as an exact nine-place decimal", () => {
    expect(formatUsd(7_500_000)).toBe("0.007500000");
    expect(formatUsd(0)).toBe("0.000000000");
    expect(formatUsd(12_345_678_901)).toBe("12.345678901");
    expect(formatUsd(1)).toBe("0.000000001");
    expect(formatPricePerMtok(2_500_000)).toBe("$2.50");
    expect(formatPricePerMtok(50_000)).toBe("$0.05");
    expect(formatPricePerMtok(15_000_000)).toBe("$15.00");
    expect(formatPricePerMtok(62_500)).toBe("$0.0625");
  });

  it("matches the exact model, then one snapshot suffix, and never a prefix", () => {
    expect(modelCandidates("GPT-4o")).toEqual(["gpt-4o"]);
    expect(modelCandidates("gpt-4o-mini-2024-07-18")).toEqual(["gpt-4o-mini-2024-07-18", "gpt-4o-mini"]);
    expect(modelCandidates("claude-haiku-4-5-20251001")).toEqual(["claude-haiku-4-5-20251001", "claude-haiku-4-5"]);
    expect(modelCandidates("gpt-4o-audio-preview")).toEqual(["gpt-4o-audio-preview"]);
    expect(modelCandidates("gpt-4o-2024-08-06-2024-09-01")).toEqual(["gpt-4o-2024-08-06-2024-09-01", "gpt-4o-2024-08-06"]);
  });
});

describe("the seeded 2026-09-24 price table", () => {
  it("has one version, effective 2026-09-24, and 37 cited rows", async () => {
    const db = migratedDatabase();
    const versions = db.prepare("SELECT version, effective_from FROM ledger_price_versions").all();
    expect(versions).toEqual([{ version: "2026-09-24", effective_from: "2026-09-24T00:00:00.000Z" }]);
    const rows = db.prepare("SELECT provider, source_url, checked_on FROM ledger_model_prices").all() as {
      provider: string;
      source_url: string;
      checked_on: string;
    }[];
    expect(rows).toHaveLength(37);
    for (const r of rows) {
      expect(r.checked_on).toBe("2026-09-24");
      expect(r.source_url).toBe(
        r.provider === "openai"
          ? "https://developers.openai.com/api/docs/pricing"
          : "https://platform.claude.com/docs/en/about-claude/pricing",
      );
    }
  });

  it("prices real model names by hand-computed expectations", async () => {
    const b = await book();
    const at = "2026-09-24T12:00:00.000Z";
    const cases: [string, string, number, number, number, string][] = [
      // provider, reported model, in, out, expected n$, matched row
      ["openai", "gpt-4o", 1000, 500, 7_500_000, "gpt-4o"],
      ["openai", "gpt-4o-2024-08-06", 1000, 500, 7_500_000, "gpt-4o"],
      // its own, higher, row: 1000 × 5e6 + 500 × 15e6 = 12.5e9
      ["openai", "gpt-4o-2024-05-13", 1000, 500, 12_500_000, "gpt-4o-2024-05-13"],
      // 10000 × 150000 + 2000 × 600000 = 2.7e9
      ["openai", "gpt-4o-mini-2024-07-18", 10_000, 2_000, 2_700_000, "gpt-4o-mini"],
      // 7 × 100000 + 3 × 500000 = 2.2e6 → 2,200 n$
      ["openai", "gpt-6-luna", 7, 3, 2_200, "gpt-6-luna"],
      // 2000 × 2e6 + 300 × 1e7 = 7e9
      ["anthropic", "claude-sonnet-5", 2000, 300, 7_000_000, "claude-sonnet-5"],
      // 1234 × 1e6 + 567 × 5e6 = 4.069e9
      ["anthropic", "claude-haiku-4-5-20251001", 1234, 567, 4_069_000, "claude-haiku-4-5"],
      // 100 × 15e6 + 100 × 75e6 = 9e9
      ["anthropic", "claude-opus-4-1-20250805", 100, 100, 9_000_000, "claude-opus-4-1"],
    ];
    for (const [provider, model, i, o, cost, row] of cases) {
      const p = await b.price(provider, model, i, o, at);
      expect({ model, ...p }).toEqual({
        model,
        priceStatus: "priced",
        priceVersion: "2026-09-24",
        pricedModel: row,
        inputPriceMicros: expect.any(Number),
        outputPriceMicros: expect.any(Number),
        costNanoUsd: cost,
      });
    }
  });

  it("does not price by prefix, by the wrong provider, or before the first version", async () => {
    const b = await book();
    expect((await b.price("openai", "gpt-4o-audio-preview", 1, 1, "2026-09-24T12:00:00Z")).priceStatus).toBe("unknown_model");
    expect((await b.price("azure", "gpt-4o", 1, 1, "2026-09-24T12:00:00Z")).priceStatus).toBe("unknown_model");
    expect((await b.price("anthropic", "gpt-4o", 1, 1, "2026-09-24T12:00:00Z")).priceStatus).toBe("unknown_model");
    const early = await b.price("openai", "gpt-4o", 1, 1, "2026-09-23T23:59:59.999Z");
    expect(early).toEqual({
      priceStatus: "before_price_table",
      priceVersion: null,
      pricedModel: null,
      inputPriceMicros: null,
      outputPriceMicros: null,
      costNanoUsd: null,
    });
    expect(b.versionAt("2026-09-24T00:00:00.000Z")?.version).toBe("2026-09-24");
  });

  it("a later version prices later events, and leaves earlier ones on the old price", async () => {
    const db = migratedDatabase();
    db.exec(`INSERT INTO ledger_price_versions VALUES ('2026-11-01', '2026-11-01T00:00:00.000Z', '2026-11-01', 'test')`);
    db.exec(`INSERT INTO ledger_model_prices VALUES ('2026-11-01', 'openai', 'gpt-4o', 'GPT-4o', 1000000, 4000000, 'https://developers.openai.com/api/docs/pricing', '2026-11-01')`);
    const b = await PriceBook.load(createLedgerRepository(createSqlExecutor(d1Over(db))));
    expect((await b.price("openai", "gpt-4o", 1000, 500, "2026-10-31T23:59:59Z")).costNanoUsd).toBe(7_500_000);
    const later = await b.price("openai", "gpt-4o", 1000, 500, "2026-11-02T00:00:00Z");
    expect(later.priceVersion).toBe("2026-11-01");
    expect(later.costNanoUsd).toBe(3_000_000); // 1000 × 1e6 + 500 × 4e6 = 3e9
    // a model only the old version knows is unknown in the new one: versions are whole tables
    expect((await b.price("openai", "gpt-4o-mini", 1, 1, "2026-11-02T00:00:00Z")).priceStatus).toBe("unknown_model");
  });

  it("the schema refuses a priced row without its provenance, and an unpriced row with a cost", () => {
    const db = migratedDatabase();
    const base = `INSERT INTO ledger_events (id, org_id, event_key, fingerprint, tenant, provider, model, input_tokens, output_tokens,
       occurred_at, received_at, price_status, price_version, priced_model, input_price_micros, output_price_micros, cost_nanousd)
       VALUES ('x', 'o', 'k', '${"0".repeat(64)}', 't', 'openai', 'gpt-4o', 1, 1, 'a', 'b', `;
    expect(() => db.exec(base + `'priced', NULL, 'gpt-4o', 1, 1, 1)`)).toThrow(/CHECK/);
    expect(() => db.exec(base + `'unknown_model', NULL, NULL, NULL, NULL, 5)`)).toThrow(/CHECK/);
    expect(() => db.exec(base + `'free', NULL, NULL, NULL, NULL, NULL)`)).toThrow(/CHECK/);
    db.exec(base + `'unknown_model', NULL, NULL, NULL, NULL, NULL)`);
  });
});
