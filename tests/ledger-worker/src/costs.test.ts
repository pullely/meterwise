/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { OWNER, VIEWER, world } from "./harness";
import { ORG, costs, ev, get, ingest, ok } from "./fixtures";

// The same fixture every test reads (n$ = nano-USD, hand-computed from the 2026-09-24 table):
//   acme  / summarize / u-1  openai gpt-4o          1000 in  500 out → 7,500,000
//   acme  / summarize / u-2  openai gpt-4o          2000 in 1000 out → 15,000,000
//   acme  / chat      / u-1  anthropic claude-sonnet-5 2000 in 300 → 7,000,000
//   globex/ chat      / —    openai gpt-6-luna         7 in   3 out → 2,200
//   globex/ —         / —    google gemini-3-pro   (unpriced)
async function seed(): Promise<ReturnType<typeof world>> {
  const w = world();
  await ok(
    await ingest(w, [
      ev({ tenant: "acme", feature: "summarize", user: "u-1", model: "gpt-4o", inputTokens: 1000, outputTokens: 500, latencyMs: 800 }),
      ev({ tenant: "acme", feature: "summarize", user: "u-2", model: "gpt-4o", inputTokens: 2000, outputTokens: 1000, latencyMs: 1200 }),
      ev({ tenant: "acme", feature: "chat", user: "u-1", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 2000, outputTokens: 300, latencyMs: null }),
      ev({ tenant: "globex", feature: "chat", user: null, model: "gpt-6-luna", inputTokens: 7, outputTokens: 3, latencyMs: 100 }),
      ev({ tenant: "globex", feature: null, user: null, provider: "google", model: "gemini-3-pro", inputTokens: 50, outputTokens: 50, latencyMs: null }),
    ]),
  );
  return w;
}

function table(c: any): [unknown, number, number, number][] {
  return c.rows.map((r: any) => [r.key, r.events, r.costNanoUsd, r.unpricedEvents]);
}

describe("cost reads", () => {
  it("by tenant", async () => {
    const c = await costs(await seed(), "by=tenant");
    expect(c.by).toBe("tenant");
    expect(c.currency).toBe("USD");
    expect(table(c)).toEqual([
      [{ tenant: "acme" }, 3, 29_500_000, 0],
      [{ tenant: "globex" }, 2, 2_200, 1],
    ]);
    expect(c.rows[0].costUsd).toBe("0.029500000");
    expect(c.rows[0]).toMatchObject({ inputTokens: 5000, outputTokens: 1800, avgLatencyMs: 1000 });
    expect(c.totals).toEqual({
      events: 5,
      inputTokens: 5057,
      outputTokens: 1853,
      costNanoUsd: 29_502_200,
      costUsd: "0.029502200",
      unpricedEvents: 1,
    });
    expect(c.priceVersions).toEqual(["2026-09-24"]);
  });

  it("by feature, with the unreported feature as its own null row", async () => {
    const c = await costs(await seed(), "by=feature");
    expect(table(c)).toEqual([
      [{ feature: "summarize" }, 2, 22_500_000, 0],
      [{ feature: "chat" }, 2, 7_002_200, 0],
      [{ feature: null }, 1, 0, 1],
    ]);
  });

  it("by model, keyed by provider and model", async () => {
    const c = await costs(await seed(), "by=model");
    expect(table(c)).toEqual([
      [{ provider: "openai", model: "gpt-4o" }, 2, 22_500_000, 0],
      [{ provider: "anthropic", model: "claude-sonnet-5" }, 1, 7_000_000, 0],
      [{ provider: "openai", model: "gpt-6-luna" }, 1, 2_200, 0],
      [{ provider: "google", model: "gemini-3-pro" }, 1, 0, 1],
    ]);
  });

  it("by provider and by user", async () => {
    const w = await seed();
    expect(table(await costs(w, "by=provider"))).toEqual([
      [{ provider: "openai" }, 3, 22_502_200, 0],
      [{ provider: "anthropic" }, 1, 7_000_000, 0],
      [{ provider: "google" }, 1, 0, 1],
    ]);
    expect(table(await costs(w, "by=user"))).toEqual([
      [{ user: "u-2" }, 1, 15_000_000, 0],
      [{ user: "u-1" }, 2, 14_500_000, 0],
      [{ user: null }, 2, 2_200, 1],
    ]);
  });

  it("filters to one tenant", async () => {
    const c = await costs(await seed(), "by=model&tenant=globex");
    expect(table(c)).toEqual([
      [{ provider: "openai", model: "gpt-6-luna" }, 1, 2_200, 0],
      [{ provider: "google", model: "gemini-3-pro" }, 1, 0, 1],
    ]);
  });

  it("windows by occurredAt (inclusive UTC dates)", async () => {
    const w = world();
    const yesterday = new Date(Date.now() - 86_400_000);
    await ok(await ingest(w, [ev({ occurredAt: yesterday.toISOString() }), ev()]));
    const y = yesterday.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    expect((await costs(w, `from=${y}&to=${y}`)).totals.events).toBe(1);
    expect((await costs(w, `from=${today}&to=${today}`)).totals.events).toBe(1);
    expect((await costs(w, `from=${y}&to=${today}`)).totals.events).toBe(2);
  });

  it("an empty window is zero, not an error", async () => {
    const c = await costs(world(), "from=2026-01-01&to=2026-01-31");
    expect(c.rows).toEqual([]);
    expect(c.totals).toMatchObject({ events: 0, costNanoUsd: 0, costUsd: "0.000000000" });
    expect(c.priceVersions).toEqual([]);
  });

  it("validates the query", async () => {
    const w = world();
    for (const q of ["by=org", "from=2026-13-01", "from=2026-09-10&to=2026-09-01", "from=2025-01-01&to=2026-09-24", "tenant="]) {
      expect((await get(w, `/v1/organizations/${ORG}/llm-costs?${q}`, OWNER)).status).toBe(422);
    }
  });

  it("a viewer reads costs, events and prices", async () => {
    const w = await seed();
    expect((await costs(w, "by=tenant", VIEWER)).totals.events).toBe(5);
    const events = await ok(await get(w, `/v1/organizations/${ORG}/llm-events`, VIEWER));
    expect(events.events).toHaveLength(5);
    const prices = await ok(await get(w, `/v1/organizations/${ORG}/llm-prices`, VIEWER));
    expect(prices.version).toBe("2026-09-24");
    expect(prices.prices).toHaveLength(37);
    expect(prices.prices.find((p: any) => p.model === "gpt-4o")).toEqual({
      provider: "openai",
      model: "gpt-4o",
      displayName: "GPT-4o",
      inputMicrosPerMtok: 2_500_000,
      outputMicrosPerMtok: 10_000_000,
      inputPerMtok: "$2.50",
      outputPerMtok: "$10.00",
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      checkedOn: "2026-09-24",
    });
    expect((await get(w, `/v1/organizations/${ORG}/llm-prices?version=1999-01-01`, VIEWER)).status).toBe(404);
  });

  it("pages the event list without skipping rows that share a timestamp", async () => {
    const w = world();
    await ok(await ingest(w, Array.from({ length: 7 }, () => ev())));
    const seen = new Set<string>();
    let before: string | null = null;
    for (let page = 0; page < 5; page++) {
      const q: string = before ? `?limit=3&before=${encodeURIComponent(before)}` : "?limit=3";
      const data = await ok(await get(w, `/v1/organizations/${ORG}/llm-events${q}`, OWNER));
      for (const e of data.events) seen.add(e.id);
      before = data.nextBefore;
      if (!before) break;
    }
    expect(seen.size).toBe(7);
    const filtered = await ok(await get(w, `/v1/organizations/${ORG}/llm-events?tenant=acme&model=GPT-4o`, OWNER));
    expect(filtered.events).toHaveLength(7);
    expect((await get(w, `/v1/organizations/${ORG}/llm-events?before=garbage`, OWNER)).status).toBe(422);
  });
});
