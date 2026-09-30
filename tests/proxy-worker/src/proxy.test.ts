/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { route as ledgerRoute } from "@ledger-worker/router";
import { LOG_KEYS, logEvent } from "@proxy-worker/log";
import { FAKE_KEY, MW_KEY_OTHER_ORG, ORG_A_PUBLIC, OWNER, KEY_A, chat, proxyWorld } from "./harness";

function events(w: ReturnType<typeof proxyWorld>): any[] {
  return w.db.prepare("SELECT * FROM ledger_events ORDER BY rowid").all() as any[];
}

async function setBudget(w: ReturnType<typeof proxyWorld>, body: unknown): Promise<void> {
  const res = await ledgerRoute(
    new Request(`https://ledger.internal/v1/organizations/${ORG_A_PUBLIC}/budgets/acme`, {
      method: "PUT",
      headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    w.ledgerEnv,
  );
  expect(res.status).toBe(201);
}

describe("proxy-worker", () => {
  it("streams a completion back unchanged and meters it from the usage chunk it asked for", async () => {
    const w = proxyWorld();
    const { res, body } = await w.call("/v1/chat/completions", chat({ stream: true, stream_options: { include_usage: false } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-meterwise-model")).toBe("gpt-4o");
    expect(res.headers.get("x-meterwise-decision")).toBe("allow");
    expect(res.headers.get("x-meterwise-request-id")).toMatch(/^px_[0-9a-f]{24}$/);
    expect(body).toContain('"content":" mock"');
    expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    // include_usage is forced on, over the caller's false.
    expect(JSON.parse(w.upstreamCalls[0]!.body)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    const [e] = events(w);
    expect(e).toMatchObject({
      source: "proxy",
      price_status: "priced",
      tenant: "acme",
      feature: "support-bot",
      end_user: "u-7",
      model: "gpt-4o-2024-08-06",
      input_tokens: 1000,
      output_tokens: 500,
      cost_nanousd: 7_500_000,
      recorded_by: KEY_A,
    });
    expect(e.event_key).toMatch(/^px-[0-9a-f]{24}$/);
    // The rollup MW2's check reads moved with it.
    expect(w.db.prepare("SELECT cost_nanousd FROM ledger_spend_rollups WHERE tenant = 'acme'").get()).toEqual({ cost_nanousd: 7_500_000 });
  });

  it("meters a non-streamed completion from its usage object", async () => {
    const w = proxyWorld();
    const { res, body } = await w.call("/v1/chat/completions", chat({ model: "gpt-4o-mini" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(body).usage).toEqual({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
    expect(events(w)[0]).toMatchObject({ model: "gpt-4o-mini-2024-08-06", priced_model: "gpt-4o-mini", cost_nanousd: 450_000 });
  });

  it("a stream cut short is recorded usage_incomplete with the chunks seen, never dropped", async () => {
    const w = proxyWorld();
    const { res } = await w.call("/v1/chat/completions", chat({ model: "mock-disconnect", stream: true }));
    expect(res.status).toBe(200);
    expect(events(w)).toHaveLength(1);
    expect(events(w)[0]).toMatchObject({ price_status: "usage_incomplete", source: "proxy", input_tokens: 0, output_tokens: 2, cost_nanousd: null });
    const costs = await ledgerRoute(
      new Request(`https://ledger.internal/v1/organizations/${ORG_A_PUBLIC}/llm-costs?by=tenant`, { headers: { "x-actor-subject-id": KEY_A, "x-actor-subject-type": "service_principal" } }),
      w.ledgerEnv,
    );
    expect(((await costs.json()) as any).data.totals).toMatchObject({ events: 1, unpricedEvents: 1, costNanoUsd: 0 });
  });

  it("passes a provider error through untouched and meters nothing", async () => {
    const w = proxyWorld();
    for (const model of ["mock-error-401", "mock-error-500"]) {
      const { res, body } = await w.call("/v1/chat/completions", chat({ model }));
      expect(res.status).toBe(model.endsWith("401") ? 401 : 500);
      expect(JSON.parse(body).error.type).toBe(model.endsWith("401") ? "invalid_request_error" : "server_error");
    }
    expect(events(w)).toEqual([]);
  });

  it("honours MW2's check: deny → 429 before any upstream call; downgrade → the mapped model, said in x-meterwise-model", async () => {
    const w = proxyWorld();
    await w.call("/v1/chat/completions", chat()); // 7,500,000 spent
    await setBudget(w, { softLimitNanoUsd: 1_000_000, hardLimitNanoUsd: 8_000_000, downgrade: { "gpt-4o": "gpt-4o-mini" } });
    const down = await w.call("/v1/chat/completions", chat({ model: "GPT-4o" }));
    expect(down.res.status).toBe(200);
    expect(down.res.headers.get("x-meterwise-decision")).toBe("downgrade");
    expect(down.res.headers.get("x-meterwise-model")).toBe("gpt-4o-mini");
    expect(JSON.parse(w.upstreamCalls[1]!.body).model).toBe("gpt-4o-mini");
    await w.call("/v1/chat/completions", chat()); // downgraded again: 8,400,000, past the hard limit
    const before = w.upstreamCalls.length;
    const denied = await w.call("/v1/chat/completions", chat());
    expect(denied.res.status).toBe(429);
    expect(JSON.parse(denied.body).error.code).toBe("budget_exceeded");
    expect(w.upstreamCalls.length).toBe(before);
  });

  it("authenticates with x-meterwise-key only, and meters into the key's own org", async () => {
    const w = proxyWorld();
    expect((await w.call("/v1/chat/completions", chat({}, { "x-meterwise-key": "" }))).res.status).toBe(401);
    expect((await w.call("/v1/chat/completions", chat({}, { "x-meterwise-key": "sk_mwtest_unknown000" }))).res.status).toBe(401);
    const other = await w.call("/v1/chat/completions", chat({}, { "x-meterwise-key": MW_KEY_OTHER_ORG }));
    expect(other.res.status).toBe(200);
    expect(events(w).map((e) => [e.org_id, e.recorded_by])).toEqual([["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "sp_fedcba9876543210fedcba9876543210"]]);
    expect(w.upstreamCalls).toHaveLength(1);
  });

  it("answers 400 without a tenant or with a body that is not a chat request, 404/405 elsewhere, and a health check", async () => {
    const w = proxyWorld();
    for (const init of [
      chat({}, { "x-meterwise-tenant": "" }),
      chat({}, { "x-meterwise-feature": "x".repeat(65) }),
      chat({ messages: [] }),
      chat({ model: "gpt 4o" }),
      { ...chat(), body: "not json" },
    ]) {
      expect((await w.call("/v1/chat/completions", init)).res.status).toBe(400);
    }
    expect((await w.call("/v1/chat/completions", { method: "GET" })).res.status).toBe(405);
    expect((await w.call("/v1/embeddings", chat())).res.status).toBe(404);
    const health = await w.call("/health", { method: "GET" });
    expect(JSON.parse(health.body)).toMatchObject({ status: "ok", service: "proxy-worker", checks: { identity: { configured: true }, ledger: { configured: true }, upstream: "override" } });
    expect(w.upstreamCalls).toEqual([]);
  });

  it("logs exactly one fixed-shape line per request, and logEvent drops anything that is not the shape", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (s: string) => void lines.push(s);
    try {
      logEvent({
        requestId: `px_${"a".repeat(24)}`,
        org: `Bearer ${FAKE_KEY}`,
        route: "chat_completions",
        outcome: "ok",
        status: 200,
        upstreamStatus: 200,
        latencyMs: 12.4,
        model: FAKE_KEY,
        tokens: { input: 1, output: 2 },
        metered: true,
        ...({ authorization: FAKE_KEY } as object),
      } as any);
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(lines[0]!);
    expect(Object.keys(parsed)).toEqual([...LOG_KEYS]);
    expect(parsed).toMatchObject({ org: null, model: null, latencyMs: 12 });
    expect(lines[0]).not.toContain(FAKE_KEY);
  });

  it("the internal ledger route answers only proxy-worker's caller header", async () => {
    const w = proxyWorld();
    const res = await ledgerRoute(
      new Request(`https://ledger.internal/v1/internal/organizations/${ORG_A_PUBLIC}/proxy-events`, {
        method: "POST",
        headers: { "x-actor-subject-id": KEY_A, "x-actor-subject-type": "service_principal", "content-type": "application/json" },
        body: JSON.stringify({ usageComplete: true, event: { eventId: "x", tenant: "acme", provider: "openai", model: "gpt-4o", inputTokens: 1, outputTokens: 1 } }),
      }),
      w.ledgerEnv,
    );
    expect(res.status).toBe(404);
    expect(events(w)).toEqual([]);
  });
});
