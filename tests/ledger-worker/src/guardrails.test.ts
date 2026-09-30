/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { decideCheck } from "@saas/contracts/ledger";
import { KEY_A, MEMBER, OWNER, STRANGER, VIEWER, OTHER_OWNER, applyMigration, json, migratedDatabase, world, type TestWorld } from "./harness";
import { ORG, OTHER_ORG, ev, get, ingest, ok, send, call } from "./fixtures";

const SOFT = 10_000_000; // $0.01
const HARD = 20_000_000; // $0.02
const period = new Date().toISOString().slice(0, 7);

function rollup(w: TestWorld, tenant = "acme"): { cost_nanousd: number; events: number } | undefined {
  return w.db.prepare("SELECT cost_nanousd, events FROM ledger_spend_rollups WHERE tenant = ? AND period = ?").get(tenant, period) as any;
}

function putBudget(w: TestWorld, tenant: string, body: unknown, who = OWNER, org = ORG): Promise<Response> {
  return send(w, `/v1/organizations/${org}/budgets/${encodeURIComponent(tenant)}`, who, body, "PUT");
}

function check(w: TestWorld, body: Record<string, unknown>, who = KEY_A): Promise<Response> {
  return send(w, `/v1/organizations/${ORG}/llm-check`, who, { tenant: "acme", provider: "openai", model: "gpt-4o", ...body });
}

describe("migration 210_ledger_guardrails", () => {
  it("backfills the rollups once from the events MW1 stored, and replays without double-counting", async () => {
    // Ingest into a full database, then copy the events into one migrated only
    // through 200: the state MW2's migration finds on stage and prod.
    const full = world();
    await ok(await ingest(full, [ev(), ev(), ev({ tenant: "globex", model: "gpt-4o-mini" }), ev({ model: "no-such-model" })]));
    const rows = full.db.prepare("SELECT * FROM ledger_events").all() as Record<string, any>[];
    const db = migratedDatabase("200_ledger_core");
    const cols = Object.keys(rows[0]!);
    const insert = db.prepare(`INSERT INTO ledger_events (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const r of rows) insert.run(...cols.map((c) => r[c]));
    const w = { db, env: full.env } as TestWorld;
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ledger_spend_rollups'").get()).toBeUndefined();
    applyMigration(db, "210_ledger_guardrails");
    expect(rollup(w)).toEqual({ cost_nanousd: 15_000_000, events: 2 }); // the unpriced event is not spend
    applyMigration(db, "210_ledger_guardrails");
    expect(rollup(w)).toEqual({ cost_nanousd: 15_000_000, events: 2 });
    expect(rollup(w, "globex")).toEqual({ cost_nanousd: 450_000, events: 1 });
  });
});

describe("the month-to-date rollup at ingest", () => {
  it("adds every accepted priced event once, and never a duplicate, a conflict or an unpriced event", async () => {
    const w = world();
    const e = ev();
    await ok(await ingest(w, [e, ev({ model: "no-such-model" })]));
    expect(rollup(w)).toEqual({ cost_nanousd: 7_500_000, events: 1 });
    await ok(await ingest(w, [e])); // duplicate
    await ok(await ingest(w, [{ ...e, inputTokens: 9 }])); // conflict
    expect(rollup(w)).toEqual({ cost_nanousd: 7_500_000, events: 1 });
  });

  it("loses no increment under concurrent ingest, retries included", async () => {
    const w = world();
    const events = Array.from({ length: 40 }, (_, i) => ev({ inputTokens: 1000 + i, outputTokens: 10 }));
    // 8 concurrent requests of 10 events each; every event is sent twice.
    const batches = Array.from({ length: 8 }, (_, i) => events.slice((i % 4) * 10, (i % 4) * 10 + 10));
    const results = await Promise.all(batches.map(async (b) => ok(await ingest(w, b))));
    expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(40);
    expect(results.reduce((n, r) => n + r.duplicates, 0)).toBe(40);
    const truth = w.db.prepare("SELECT SUM(cost_nanousd) AS c, COUNT(*) AS n FROM ledger_events WHERE tenant = 'acme'").get() as any;
    expect(rollup(w)).toEqual({ cost_nanousd: truth.c, events: truth.n });
    expect(truth.n).toBe(40);
  });

  it("a batch costs one rollup statement per (tenant, month), not one per event", async () => {
    const w = world();
    const real = w.env.PLATFORM_DB!;
    let rollupStatements = 0;
    w.env.PLATFORM_DB = {
      prepare(q: string) {
        if (q.includes("INSERT INTO ledger_spend_rollups")) rollupStatements++;
        return real.prepare(q);
      },
    } as unknown as D1Database;
    const batch = Array.from({ length: 100 }, (_, i) => ev({ tenant: i % 2 ? "acme" : "globex" }));
    expect((await ok(await ingest(w, batch))).accepted).toBe(100);
    expect(rollupStatements).toBe(2);
    expect(rollup(w)).toEqual({ cost_nanousd: 50 * 7_500_000, events: 50 });
    expect(rollup(w, "globex")).toEqual({ cost_nanousd: 50 * 7_500_000, events: 50 });
  });

  it("reports the accepted spend once to the baseline metering context (MW-J)", async () => {
    const w = world();
    const a = ev();
    const b = ev({ provider: "anthropic", model: "claude-sonnet-5", inputTokens: 2000, outputTokens: 300 });
    await ok(await ingest(w, [a, b, ev({ model: "no-such-model" })]));
    await ok(await ingest(w, [a, b])); // a retry accepts nothing, so records nothing
    const rows = w.db.prepare("SELECT metric, quantity FROM metering_usage_records").all() as any[];
    expect(rows).toEqual([{ metric: "ledger.tracked_spend_nanousd", quantity: 14_500_000 }]);
  });
});

describe("budgets", () => {
  it("an owner creates (201), replaces (200), reads, lists and removes a budget; each change is audited", async () => {
    const w = world();
    const created = await ok(await putBudget(w, "acme", { softLimitNanoUsd: SOFT, hardLimitNanoUsd: HARD, downgrade: { "GPT-4o": "gpt-4o-mini" } }), 201);
    expect(created).toMatchObject({
      tenant: "acme",
      softLimitNanoUsd: SOFT,
      softLimitUsd: "0.010000000",
      hardLimitUsd: "0.020000000",
      downgrade: { "gpt-4o": "gpt-4o-mini" },
      period,
      spentNanoUsd: 0,
    });
    expect(created.id).toMatch(/^mwb_[0-9a-f]{32}$/);
    const replaced = await ok(await putBudget(w, "acme", { hardLimitNanoUsd: HARD }));
    expect(replaced).toMatchObject({ id: created.id, softLimitNanoUsd: null, hardLimitNanoUsd: HARD, downgrade: {} });
    await ok(await putBudget(w, "*", { softLimitNanoUsd: SOFT }), 201);
    await ok(await ingest(w, [ev()]));
    const list = await ok(await get(w, `/v1/organizations/${ORG}/budgets`, KEY_A));
    expect(list.budgets.map((b: any) => [b.tenant, b.spentNanoUsd])).toEqual([
      ["*", null],
      ["acme", 7_500_000],
    ]);
    expect((await ok(await get(w, `/v1/organizations/${ORG}/budgets/%2A`, VIEWER))).tenant).toBe("*");
    const removed = await ok(await call(w, `/v1/organizations/${ORG}/budgets/acme`, { method: "DELETE", headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user" } }));
    expect(removed.removed.id).toBe(created.id);
    expect((await call(w, `/v1/organizations/${ORG}/budgets/acme`, { method: "DELETE", headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user" } })).status).toBe(404);
    expect((await get(w, `/v1/organizations/${ORG}/budgets/acme`, OWNER)).status).toBe(404);
    const audits = w.db.prepare("SELECT event_type, category, subject_kind FROM events_audit_entries ORDER BY rowid").all() as any[];
    expect(audits.map((a) => a.event_type)).toEqual(["ledger.budget.set", "ledger.budget.set", "ledger.budget.set", "ledger.budget.removed"]);
    expect(new Set(audits.map((a) => `${a.category}/${a.subject_kind}`))).toEqual(new Set(["ledger/ledger_budget"]));
  });

  it("validates the limits and the downgrade map (422), writing nothing", async () => {
    const w = world();
    for (const bad of [
      {},
      { softLimitNanoUsd: HARD, hardLimitNanoUsd: SOFT },
      { softLimitNanoUsd: SOFT, hardLimitNanoUsd: SOFT },
      { softLimitNanoUsd: -1 },
      { softLimitNanoUsd: 1.5 },
      { hardLimitNanoUsd: "20000000" },
      { softLimitNanoUsd: SOFT, downgrade: { "gpt-4o": "gpt-4o" } },
      { softLimitNanoUsd: SOFT, downgrade: ["gpt-4o"] },
      { softLimitNanoUsd: SOFT, downgrade: { "gpt 4o": "x" } },
    ]) {
      const res = await putBudget(w, "acme", bad);
      expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 422]);
    }
    expect((await putBudget(w, "a\u0001b", { softLimitNanoUsd: SOFT })).status).toBe(404);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM ledger_budgets").get()).toEqual({ n: 0 });
  });

  it("only an owner or admin writes a budget: a builder, the SDK key, a viewer and a stranger get 404", async () => {
    const w = world();
    for (const who of [MEMBER, KEY_A, VIEWER, STRANGER, OTHER_OWNER]) {
      expect((await putBudget(w, "acme", { softLimitNanoUsd: SOFT }, who)).status).toBe(404);
    }
    expect((await putBudget(w, "acme", { softLimitNanoUsd: SOFT }, OTHER_OWNER, OTHER_ORG)).status).toBe(201);
    // ORG_B's budget is invisible from ORG_A, and ORG_A's reads do not see it.
    expect((await ok(await get(w, `/v1/organizations/${ORG}/budgets`, OWNER))).budgets).toEqual([]);
    expect((await get(w, `/v1/organizations/${OTHER_ORG}/budgets`, OWNER)).status).toBe(404);
    expect((await get(w, `/v1/organizations/${ORG}/alerts`, STRANGER)).status).toBe(404);
  });
});

describe("the decision table (contracts)", () => {
  const budget = { softLimitNanoUsd: SOFT, hardLimitNanoUsd: HARD, downgrade: { "gpt-4o": "gpt-4o-mini" } };
  it.each([
    [0, null, "gpt-4o", "allow", "gpt-4o", "no_budget"],
    [0, budget, "gpt-4o", "allow", "gpt-4o", "within_budget"],
    [SOFT - 1, budget, "gpt-4o", "allow", "gpt-4o", "within_budget"],
    [SOFT, budget, "gpt-4o", "downgrade", "gpt-4o-mini", "soft_limit_downgrade"],
    [SOFT, budget, "claude-sonnet-5", "warn", "claude-sonnet-5", "soft_limit_reached"],
    [HARD - 1, budget, "claude-sonnet-5", "warn", "claude-sonnet-5", "soft_limit_reached"],
    [HARD, budget, "gpt-4o", "deny", "gpt-4o", "hard_limit_reached"],
    [HARD * 5, { ...budget, softLimitNanoUsd: null }, "gpt-4o", "deny", "gpt-4o", "hard_limit_reached"],
    [HARD * 5, { ...budget, hardLimitNanoUsd: null }, "gpt-4o", "downgrade", "gpt-4o-mini", "soft_limit_downgrade"],
  ] as const)("spent %d → %s", (spent, b, model, decision, outModel, reason) => {
    expect(decideCheck(spent, b as any, model)).toEqual({ decision, model: outModel, reason });
  });
});

describe("POST llm-check", () => {
  it("moves allow → warn / downgrade → deny as the tenant's spend crosses its budget", async () => {
    const w = world();
    expect(await ok(await check(w, {}))).toMatchObject({ decision: "allow", reason: "no_budget", budgetTenant: null });
    await ok(await putBudget(w, "acme", { softLimitNanoUsd: SOFT, hardLimitNanoUsd: HARD, downgrade: { "gpt-4o": "gpt-4o-mini" } }), 201);
    expect(await ok(await check(w, {}))).toMatchObject({ decision: "allow", reason: "within_budget", spentNanoUsd: 0, budgetTenant: "acme" });

    await ok(await ingest(w, [ev()])); // 7,500,000
    expect((await ok(await check(w, {}))).decision).toBe("allow");
    await ok(await ingest(w, [ev()])); // 15,000,000 ≥ soft
    expect(await ok(await check(w, {}))).toMatchObject({
      decision: "downgrade",
      model: "gpt-4o-mini",
      requestedModel: "gpt-4o",
      reason: "soft_limit_downgrade",
      spentNanoUsd: 15_000_000,
      softLimitNanoUsd: SOFT,
      hardLimitNanoUsd: HARD,
      period,
    });
    expect(await ok(await check(w, { provider: "anthropic", model: "claude-sonnet-5" }))).toMatchObject({ decision: "warn", model: "claude-sonnet-5" });
    // An estimate that would cross the hard limit: 2,000 input tokens of gpt-4o = 5,000,000.
    expect(await ok(await check(w, { estimatedInputTokens: 2000 }))).toMatchObject({ decision: "deny", estimatedNanoUsd: 5_000_000 });
    await ok(await ingest(w, [ev()])); // 22,500,000 ≥ hard
    expect(await ok(await check(w, {}))).toMatchObject({ decision: "deny", reason: "hard_limit_reached", spentNanoUsd: 22_500_000 });
    // Another tenant is untouched.
    expect((await ok(await check(w, { tenant: "globex" }))).decision).toBe("allow");
  });

  it("the org-wide default applies to a tenant without its own budget, and a tenant's own budget wins", async () => {
    const w = world();
    await ok(await putBudget(w, "*", { hardLimitNanoUsd: SOFT }), 201);
    await ok(await ingest(w, [ev({ tenant: "globex" }), ev({ tenant: "globex" })]));
    expect(await ok(await check(w, { tenant: "globex" }))).toMatchObject({ decision: "deny", budgetTenant: "*" });
    await ok(await putBudget(w, "globex", { hardLimitNanoUsd: HARD * 10 }), 201);
    expect(await ok(await check(w, { tenant: "globex" }))).toMatchObject({ decision: "allow", budgetTenant: "globex" });
  });

  it("validates its body (422) and needs ledger.ingest: a viewer or a stranger gets 404", async () => {
    const w = world();
    expect((await send(w, `/v1/organizations/${ORG}/llm-check`, KEY_A, { provider: "openai", model: "gpt-4o" })).status).toBe(422);
    expect((await check(w, { estimatedInputTokens: -5 })).status).toBe(422);
    expect((await check(w, { model: "has space" })).status).toBe(422);
    expect((await check(w, {}, VIEWER)).status).toBe(404);
    expect((await check(w, {}, STRANGER)).status).toBe(404);
    const unauth = await call(w, `/v1/organizations/${ORG}/llm-check`, { method: "POST", body: "{}" });
    expect(unauth.status).toBe(401);
    expect((await json(unauth)).error.code).toBe("unauthenticated");
  });
});
