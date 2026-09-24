import { createSqlExecutor } from "@saas/db/d1";
import { createLedgerRepository } from "@saas/db/ledger";
import { KEY_A, KEY_B, MEMBER, ORG_A, OTHER_OWNER, OWNER, STRANGER, VIEWER, d1Over, world } from "./harness";
import { ORG, OTHER_ORG, call, costs, ev, eventCount, get, ingest, ok } from "./fixtures";

const READS = ["llm-events", "llm-costs", "llm-prices"];

describe("the tenant boundary", () => {
  it("owner, builder and a builder API key ingest; a viewer cannot (404, nothing written)", async () => {
    const w = world();
    for (const who of [OWNER, MEMBER, KEY_A]) expect((await ingest(w, [ev()], who)).status).toBe(200);
    expect((await ingest(w, [ev()], VIEWER)).status).toBe(404);
    expect(eventCount(w)).toBe(3);
  });

  it("another org's API key, another org's owner and a stranger get 404 on every route", async () => {
    const w = world();
    await ok(await ingest(w, [ev()]));
    for (const who of [KEY_B, OTHER_OWNER, STRANGER]) {
      for (const r of READS) expect((await get(w, `/v1/organizations/${ORG}/${r}`, who)).status).toBe(404);
      expect((await ingest(w, [ev()], who)).status).toBe(404);
    }
    expect(eventCount(w)).toBe(1);
  });

  it("an org sees only its own events and costs", async () => {
    const w = world();
    await ok(await ingest(w, [ev({ tenant: "only-a" })], KEY_A, ORG));
    await ok(await ingest(w, [ev({ tenant: "only-b" }), ev({ tenant: "only-b" })], KEY_B, OTHER_ORG));
    const a = await costs(w, "by=tenant", KEY_A, ORG);
    const b = await costs(w, "by=tenant", KEY_B, OTHER_ORG);
    expect(a.rows.map((r: { key: unknown }) => r.key)).toEqual([{ tenant: "only-a" }]);
    expect(b.rows.map((r: { key: unknown }) => r.key)).toEqual([{ tenant: "only-b" }]);
  });

  it("no actor is 401; a malformed org id is 404; an unknown route is 404; a wrong method is 405", async () => {
    const w = world();
    expect((await call(w, `/v1/organizations/${ORG}/llm-costs`)).status).toBe(401);
    expect((await get(w, `/v1/organizations/not-an-org/llm-costs`, OWNER)).status).toBe(404);
    expect((await get(w, `/v1/organizations/${ORG}/llm-budgets`, OWNER)).status).toBe(404);
    expect((await call(w, `/v1/organizations/${ORG}/llm-costs`, { method: "POST", headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user" } })).status).toBe(405);
    expect((await call(w, `/health`)).status).toBe(200);
  });
});

describe("trap 22 pins: the D1 executor counts returned rows", () => {
  it("claimEvent learns the outcome from RETURNING, not rowCount", async () => {
    const w = world();
    const executor = createSqlExecutor(d1Over(w.db));
    const repo = createLedgerRepository(executor);
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      orgId: ORG_A,
      eventKey: "k-1",
      fingerprint: "a".repeat(64),
      tenant: "t",
      feature: null,
      endUser: null,
      provider: "openai",
      model: "gpt-4o",
      pricedModel: null,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: null,
      occurredAt: "2026-09-24T00:00:00.000Z",
      receivedAt: "2026-09-24T00:00:00.000Z",
      priceStatus: "unknown_model" as const,
      priceVersion: null,
      inputPriceMicros: null,
      outputPriceMicros: null,
      costNanoUsd: null,
      source: "sdk" as const,
      recordedBy: null,
    };
    expect(await repo.claimEvent(row)).toBe(row.id);
    expect(await repo.claimEvent({ ...row, id: "00000000-0000-4000-8000-000000000002" })).toBeNull();
    // Why RETURNING: the same insert WITHOUT it reports rowCount 0 on this executor even when it wrote.
    const plain = await executor.execute(
      `INSERT INTO ledger_price_versions (version, effective_from, published_on, description) VALUES ('pin', 'x', 'x', 'x')`,
    );
    expect(plain.rowCount).toBe(0);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM ledger_price_versions WHERE version = 'pin'").get()).toEqual({ n: 1 });
  });
});
