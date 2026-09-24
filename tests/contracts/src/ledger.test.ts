import {
  COST_DIMENSIONS,
  EVENT_ID_RE,
  LEDGER_MAX_BATCH,
  PROVIDER_RE,
  costNanoUsd,
  formatUsd,
  modelCandidates,
  normalizeModel,
} from "@saas/contracts/ledger";

describe("ledger contracts", () => {
  it("prices in integer nano-USD with one round-half-up", () => {
    expect(costNanoUsd(1000, 500, 2_500_000, 10_000_000)).toBe(7_500_000);
    expect(costNanoUsd(3, 0, 500, 0)).toBe(2); // 1.5 → 2
    expect(formatUsd(7_500_000)).toBe("0.007500000");
  });

  it("matches models exactly or by one snapshot suffix, never by prefix", () => {
    expect(normalizeModel("  GPT-4o ")).toBe("gpt-4o");
    expect(modelCandidates("gpt-4.1-2025-04-14")).toEqual(["gpt-4.1-2025-04-14", "gpt-4.1"]);
    expect(modelCandidates("o4-mini")).toEqual(["o4-mini"]);
    expect(modelCandidates("gpt-4o-realtime-preview")).toEqual(["gpt-4o-realtime-preview"]);
  });

  it("keeps the wire limits and identifiers tight", () => {
    expect(LEDGER_MAX_BATCH).toBe(100);
    expect(COST_DIMENSIONS).toEqual(["tenant", "feature", "model", "provider", "user"]);
    expect(EVENT_ID_RE.test("3f2c9a7e-1b2d-4c5e-8f90-123456789abc")).toBe(true);
    expect(EVENT_ID_RE.test("has space")).toBe(false);
    expect(EVENT_ID_RE.test("x".repeat(129))).toBe(false);
    expect(PROVIDER_RE.test("openai")).toBe(true);
    expect(PROVIDER_RE.test("Open AI")).toBe(false);
  });
});
