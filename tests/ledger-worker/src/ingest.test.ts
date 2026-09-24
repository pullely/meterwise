/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { KEY_A, OWNER, world, json } from "./harness";
import { ORG, costs, ev, eventCount, ingest, ok } from "./fixtures";

describe("ingest", () => {
  it("accepts a batch from an API key and prices every event with the version that priced it", async () => {
    const w = world();
    const a = ev({ model: "gpt-4o", inputTokens: 1000, outputTokens: 500 });
    const b = ev({ provider: "anthropic", model: "claude-sonnet-5", inputTokens: 2000, outputTokens: 300 });
    const data = await ok(await ingest(w, [a, b]));
    expect(data.accepted).toBe(2);
    expect(data.duplicates).toBe(0);
    expect(data.conflicts).toBe(0);
    expect(data.results.map((r: any) => [r.eventId, r.status, r.priceStatus, r.priceVersion, r.costNanoUsd, r.costUsd])).toEqual([
      [a.eventId, "accepted", "priced", "2026-09-24", 7_500_000, "0.007500000"],
      [b.eventId, "accepted", "priced", "2026-09-24", 7_000_000, "0.007000000"],
    ]);
    expect(data.results[0].id).toMatch(/^mwe_[0-9a-f]{32}$/);
    const row = w.db.prepare("SELECT * FROM ledger_events WHERE event_key = ?").get(a.eventId as string) as any;
    expect(row).toMatchObject({
      tenant: "acme",
      feature: "summarize",
      end_user: "u-1",
      provider: "openai",
      model: "gpt-4o",
      priced_model: "gpt-4o",
      price_version: "2026-09-24",
      input_price_micros: 2_500_000,
      output_price_micros: 10_000_000,
      cost_nanousd: 7_500_000,
      source: "sdk",
      recorded_by: KEY_A,
      latency_ms: 820,
    });
  });

  it("a retried event is a duplicate: nothing is counted twice, and the stored cost comes back", async () => {
    const w = world();
    const e = ev();
    const first = await ok(await ingest(w, [e]));
    const before = await costs(w, "by=tenant");
    for (let i = 0; i < 3; i++) {
      const again = await ok(await ingest(w, [e]));
      expect(again).toMatchObject({ accepted: 0, duplicates: 1, conflicts: 0 });
      expect(again.results[0]).toMatchObject({ status: "duplicate", id: first.results[0].id, costNanoUsd: 7_500_000 });
    }
    expect(eventCount(w)).toBe(1);
    expect(await costs(w, "by=tenant")).toEqual(before);
  });

  it("a retry that differs only in latency or occurredAt is still a duplicate", async () => {
    const w = world();
    const e = ev();
    await ok(await ingest(w, [e]));
    const again = await ok(await ingest(w, [{ ...e, latencyMs: 9999, occurredAt: new Date(Date.now() - 60_000).toISOString() }]));
    expect(again.results[0].status).toBe("duplicate");
  });

  it("a different call reusing an eventId is a conflict: the first write wins", async () => {
    const w = world();
    const e = ev();
    await ok(await ingest(w, [e]));
    const clash = await ok(await ingest(w, [{ ...e, outputTokens: 9_000 }]));
    expect(clash).toMatchObject({ accepted: 0, duplicates: 0, conflicts: 1 });
    expect(clash.results[0]).toMatchObject({ status: "conflict", costNanoUsd: 7_500_000 });
    const row = w.db.prepare("SELECT output_tokens FROM ledger_events").get() as any;
    expect(row.output_tokens).toBe(500);
  });

  it("a repeat inside one batch is a duplicate of the first", async () => {
    const w = world();
    const e = ev();
    const data = await ok(await ingest(w, [e, e, ev()]));
    expect(data.results.map((r: any) => r.status)).toEqual(["accepted", "duplicate", "accepted"]);
    expect(eventCount(w)).toBe(2);
  });

  it("concurrent retries of one event: exactly one is accepted", async () => {
    const w = world();
    const e = ev();
    const responses = await Promise.all(Array.from({ length: 12 }, () => ingest(w, [e])));
    const statuses = await Promise.all(responses.map(async (r) => (await json(r)).data.results[0].status));
    expect(statuses.filter((s) => s === "accepted")).toHaveLength(1);
    expect(statuses.filter((s) => s === "duplicate")).toHaveLength(11);
    expect(eventCount(w)).toBe(1);
  });

  it("the same eventId in two organizations is two events", async () => {
    const w = world();
    const e = ev();
    await ok(await ingest(w, [e]));
    const { OTHER_OWNER } = await import("./harness");
    const { OTHER_ORG } = await import("./fixtures");
    const other = await ok(await ingest(w, [e], OTHER_OWNER, OTHER_ORG));
    expect(other.results[0].status).toBe("accepted");
    expect(eventCount(w)).toBe(2);
  });

  it("records an unknown model unpriced instead of refusing it", async () => {
    const w = world();
    const data = await ok(await ingest(w, [ev({ provider: "google", model: "gemini-3-pro" }), ev({ model: "gpt-4o-audio-preview" })]));
    expect(data.results.map((r: any) => [r.status, r.priceStatus, r.costNanoUsd, r.costUsd, r.priceVersion])).toEqual([
      ["accepted", "unknown_model", null, null, null],
      ["accepted", "unknown_model", null, null, null],
    ]);
    const c = await costs(w, "by=model");
    expect(c.totals).toMatchObject({ events: 2, costNanoUsd: 0, unpricedEvents: 2 });
  });

  it("normalises provider and model case, and trims attribution strings", async () => {
    const w = world();
    const e = ev({ provider: "OpenAI", model: "GPT-4o-Mini-2024-07-18", tenant: "  acme  ", inputTokens: 10_000, outputTokens: 2_000 });
    const data = await ok(await ingest(w, [e]));
    expect(data.results[0]).toMatchObject({ priceStatus: "priced", costNanoUsd: 2_700_000 });
    const row = w.db.prepare("SELECT provider, model, priced_model, tenant FROM ledger_events").get();
    expect(row).toEqual({ provider: "openai", model: "gpt-4o-mini-2024-07-18", priced_model: "gpt-4o-mini", tenant: "acme" });
  });

  it("validates the whole batch first and writes nothing when any event is invalid", async () => {
    const w = world();
    const res = await ingest(w, [
      ev(),
      ev({ eventId: "has space", tenant: "", provider: "Open AI!", model: "", inputTokens: -1, outputTokens: 1.5 }),
      ev({ latencyMs: 4_000_000, occurredAt: "yesterday-ish" }),
      ev({ occurredAt: new Date(Date.now() + 3_600_000).toISOString() }),
      ev({ occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString(), feature: "x".repeat(65) }),
    ]);
    expect(res.status).toBe(422);
    const fields = (await json(res)).error.details.fields;
    expect(Object.keys(fields).sort()).toEqual(
      [
        "events[1].eventId",
        "events[1].tenant",
        "events[1].provider",
        "events[1].model",
        "events[1].inputTokens",
        "events[1].outputTokens",
        "events[2].latencyMs",
        "events[2].occurredAt",
        "events[3].occurredAt",
        "events[4].occurredAt",
        "events[4].feature",
      ].sort(),
    );
    expect(eventCount(w)).toBe(0);
  });

  it("refuses an empty batch, an oversized batch and a non-JSON body", async () => {
    const w = world();
    expect((await ingest(w, [])).status).toBe(422);
    expect((await ingest(w, Array.from({ length: 101 }, () => ev()))).status).toBe(422);
    const { call } = await import("./fixtures");
    const { as } = await import("./harness");
    const res = await call(w, `/v1/organizations/${ORG}/llm-events`, { method: "POST", headers: as(OWNER), body: "not json" });
    expect(res.status).toBe(422);
    expect(eventCount(w)).toBe(0);
  });

  it("accepts a full batch of 100", async () => {
    const w = world();
    const data = await ok(await ingest(w, Array.from({ length: 100 }, () => ev())));
    expect(data.accepted).toBe(100);
    expect(eventCount(w)).toBe(100);
  });
});
