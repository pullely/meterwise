/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { openDb } from "@ledger-worker/context";
import { runSweep, type Enqueue } from "@ledger-worker/sweep";
import { runScheduledSweep } from "@ledger-worker/scheduled";
import { ORG_A, OWNER, world, type TestWorld } from "./harness";
import { ORG, ev, get, ingest, ok, send } from "./fixtures";

// Membership stores the PUBLIC subject id ("usr_<32 hex>") on D1 and identity
// the UUID (runbook trap 39): the recipients are seeded exactly that way.
const PEOPLE = [
  { uuid: "a1a1a1a1-0000-4000-8000-000000000001", email: "owner@acme.test", role: "owner", status: "active" },
  { uuid: "a1a1a1a1-0000-4000-8000-000000000002", email: "admin@acme.test", role: "admin", status: "active" },
  { uuid: "a1a1a1a1-0000-4000-8000-000000000003", email: "builder@acme.test", role: "builder", status: "active" },
  { uuid: "a1a1a1a1-0000-4000-8000-000000000004", email: "gone-admin@acme.test", role: "admin", status: "removed" },
];

function seedPeople(w: TestWorld): void {
  for (const p of PEOPLE) {
    const pub = `usr_${p.uuid.replace(/-/g, "")}`;
    w.db.prepare("INSERT INTO identity_users (id, email, email_lower) VALUES (?, ?, ?)").run(p.uuid, p.email, p.email);
    w.db.prepare("INSERT INTO membership_organization_members (id, org_id, subject_id, status) VALUES (?, ?, ?, ?)").run(crypto.randomUUID(), ORG_A, pub, p.status);
    w.db.prepare("INSERT INTO membership_role_assignments (id, org_id, subject_id, role) VALUES (?, ?, ?, ?)").run(crypto.randomUUID(), ORG_A, pub, p.role);
  }
}

interface Sent {
  templateKey: string;
  to: string;
  idempotencyKey: string;
  data: Record<string, unknown>;
}

function recorder(fail = false): { enqueue: Enqueue; sent: Sent[] } {
  const sent: Sent[] = [];
  const enqueue: Enqueue = async (r) => {
    if (fail) return { ok: false, reason: "non_2xx" };
    sent.push({ templateKey: r.templateKey, to: r.recipient.address, idempotencyKey: r.idempotencyKey!, data: r.templateData as any });
    return { ok: true, notificationId: `ntf_${sent.length}` };
  };
  return { enqueue, sent };
}

async function sweep(w: TestWorld, at: Date, enqueue: Enqueue | null) {
  const db = openDb(w.env)!;
  try {
    return await runSweep({ guard: db.guard, executor: db.executor, enqueue }, at);
  } finally {
    await db.dispose();
  }
}

/** The next quarter-hour tick after now, and the one after it. */
function ticks(): [Date, Date] {
  const q = 15 * 60 * 1000;
  const t = Math.ceil((Date.now() + 1) / q) * q;
  return [new Date(t + 1000), new Date(t + q + 1000)];
}

function burst(n: number, over: Record<string, unknown> = {}): Record<string, unknown>[] {
  return Array.from({ length: n }, () => ev({ feature: "summarize", inputTokens: 10, outputTokens: 10, ...over }));
}

async function ingestAll(w: TestWorld, events: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < events.length; i += 100) await ok(await ingest(w, events.slice(i, i + 100)));
}

function alerts(w: TestWorld): any[] {
  return w.db.prepare("SELECT kind, subject, status, recipients, accepted FROM ledger_alerts ORDER BY rowid").all() as any[];
}

describe("the anomaly sweep", () => {
  it("a burst raises exactly ONE runaway_loop alert across two ticks, emailing the active owners and admins", async () => {
    const w = world();
    seedPeople(w);
    await ingestAll(w, burst(250));
    const [t1, t2] = ticks();
    const r = recorder();
    const first = await sweep(w, t1, r.enqueue);
    expect(first).toMatchObject({ raised: 1, alreadyRaised: 0, emailsAccepted: 2 });
    expect(r.sent.map((s) => [s.templateKey, s.to])).toEqual([
      ["ledger.anomaly.detected", "admin@acme.test"],
      ["ledger.anomaly.detected", "owner@acme.test"],
    ]);
    expect(r.sent[0]!.data).toMatchObject({ kind: "runaway_loop", tenant: "acme", feature: "summarize", events: 250, baselineMedian: 0 });
    expect(r.sent[0]!.idempotencyKey).toMatch(/^ledger\.anomaly\.detected:mwa_[0-9a-f]{32}:admin@acme\.test$/);

    const second = await sweep(w, t2, r.enqueue);
    expect(second).toMatchObject({ raised: 0, alreadyRaised: 1, emailsAccepted: 0 });
    // The same tick run twice (a retried cron) sends nothing either.
    expect(await sweep(w, t1, r.enqueue)).toMatchObject({ raised: 0, alreadyRaised: 1 });
    expect(r.sent).toHaveLength(2);
    expect(alerts(w)).toEqual([{ kind: "runaway_loop", subject: '["acme","summarize"]', status: "notified", recipients: 2, accepted: 2 }]);

    const audit = w.db.prepare("SELECT event_type, actor_type, actor_id, subject_kind FROM events_audit_entries").all() as any[];
    expect(audit).toEqual([{ event_type: "ledger.alert.raised", actor_type: "system", actor_id: "ledger-worker", subject_kind: "ledger_alert" }]);

    const listed = await ok(await get(w, `/v1/organizations/${ORG}/alerts`, OWNER));
    expect(listed.alerts).toHaveLength(1);
    expect(listed.alerts[0]).toMatchObject({ kind: "runaway_loop", tenant: "acme", feature: "summarize", user: null, status: "notified", accepted: 2, recipients: 2 });
    expect(listed.alerts[0].id).toMatch(/^mwa_[0-9a-f]{32}$/);
  });

  it("stays quiet under the 200-event floor, and when the burst is within 10× the 7-day hourly median", async () => {
    const w = world();
    seedPeople(w);
    await ingestAll(w, burst(150));
    const [t1] = ticks();
    expect(await sweep(w, t1, recorder().enqueue)).toMatchObject({ candidates: 0, raised: 0 });

    // A tenant that normally makes 30 calls an hour, every hour of the last week.
    const w2 = world();
    const insert = w2.db.prepare(
      `INSERT INTO ledger_events (id, org_id, event_key, fingerprint, tenant, feature, provider, model, input_tokens, output_tokens,
         occurred_at, received_at, price_status, source)
       VALUES (?, ?, ?, ?, 'acme', 'summarize', 'openai', 'nope', 1, 1, ?, ?, 'unknown_model', 'sdk')`,
    );
    const hour = Math.floor(t1.getTime() / 3_600_000) * 3_600_000 - 3_600_000;
    w2.db.exec("BEGIN");
    for (let h = 1; h <= 170; h++) {
      for (let i = 0; i < 30; i++) {
        const at = new Date(hour - h * 3_600_000 + i * 1000).toISOString();
        insert.run(crypto.randomUUID(), ORG_A, `hist-${h}-${i}`, "f".repeat(64), at, at);
      }
    }
    w2.db.exec("COMMIT");
    await ingestAll(w2, burst(250)); // 250 < 10 × 30
    expect(await sweep(w2, t1, recorder().enqueue)).toMatchObject({ candidates: 0, raised: 0 });
    await ingestAll(w2, burst(60)); // 310 > 300
    expect(await sweep(w2, t1, recorder().enqueue)).toMatchObject({ candidates: 1, raised: 1 });
  });

  it("an end-user over half a tenant's hourly spend and over $5 raises one abusive_user alert", async () => {
    const w = world();
    seedPeople(w);
    // 2,100,000 input tokens of gpt-4o = $5.25; the rest of the tenant spends $0.0075.
    await ok(await ingest(w, [ev({ user: "u-9", inputTokens: 2_100_000, outputTokens: 0 }), ev({ user: "u-1" })]));
    await ok(await ingest(w, [ev({ tenant: "globex", user: "u-2", inputTokens: 1_000_000, outputTokens: 0 })])); // $2.50: under $5
    const [t1, t2] = ticks();
    const r = recorder();
    expect(await sweep(w, t1, r.enqueue)).toMatchObject({ raised: 1 });
    expect(await sweep(w, t2, r.enqueue)).toMatchObject({ raised: 0, alreadyRaised: 1 });
    expect(alerts(w)).toEqual([{ kind: "abusive_user", subject: '["acme","u-9"]', status: "notified", recipients: 2, accepted: 2 }]);
    expect(r.sent[0]!.data).toMatchObject({ kind: "abusive_user", user: "u-9", userCostUsd: "5.250000000", tenantCostUsd: "5.257500000" });
  });

  it("a tenant reaching its soft and then its hard budget gets one email per level per month", async () => {
    const w = world();
    seedPeople(w);
    await ok(await send(w, `/v1/organizations/${ORG}/budgets/acme`, OWNER, { softLimitNanoUsd: 10_000_000, hardLimitNanoUsd: 20_000_000 }, "PUT"), 201);
    await ok(await ingest(w, [ev(), ev()])); // 15,000,000: soft
    const [t1, t2] = ticks();
    const r = recorder();
    await sweep(w, t1, r.enqueue);
    expect(alerts(w).map((a) => a.kind)).toEqual(["budget_soft"]);
    await ok(await ingest(w, [ev()])); // 22,500,000: hard
    await sweep(w, t2, r.enqueue);
    await sweep(w, t2, r.enqueue);
    expect(alerts(w).map((a) => a.kind)).toEqual(["budget_soft", "budget_hard"]);
    expect(r.sent.filter((s) => s.templateKey === "ledger.budget.crossed").map((s) => s.data.level)).toEqual(["soft", "soft", "hard", "hard"]);
    expect(r.sent[2]!.data).toMatchObject({ tenant: "acme", spentUsd: "0.022500000", limitUsd: "0.020000000" });
  });

  it("gives a claim back when no email was accepted, so the next tick sends it; no recipients is recorded, not retried", async () => {
    const w = world();
    seedPeople(w);
    await ingestAll(w, burst(250));
    const [t1, t2] = ticks();
    expect(await sweep(w, t1, recorder(true).enqueue)).toMatchObject({ raised: 0, deferred: 1 });
    expect(alerts(w)).toEqual([]);
    expect(await sweep(w, t1, null)).toMatchObject({ deferred: 1 });
    const r = recorder();
    expect(await sweep(w, t2, r.enqueue)).toMatchObject({ raised: 1, emailsAccepted: 2 });

    const lonely = world(); // nobody to tell
    await ingestAll(lonely, burst(250));
    expect(await sweep(lonely, t1, r.enqueue)).toMatchObject({ raised: 1, emailsAccepted: 0 });
    expect(alerts(lonely)).toEqual([{ kind: "runaway_loop", subject: '["acme","summarize"]', status: "no_recipients", recipients: 0, accepted: 0 }]);
  });

  it("reconciles a rollup the ingest-time upsert never applied", async () => {
    const w = world();
    await ok(await ingest(w, [ev(), ev({ tenant: "globex" })]));
    w.db.exec("DELETE FROM ledger_spend_rollups WHERE tenant = 'acme'");
    w.db.exec("UPDATE ledger_spend_rollups SET cost_nanousd = 1 WHERE tenant = 'globex'");
    const [t1] = ticks();
    expect(await sweep(w, t1, null)).toMatchObject({ reconciled: 2 });
    expect(await sweep(w, t1, null)).toMatchObject({ reconciled: 0 });
    const rows = w.db.prepare("SELECT tenant, cost_nanousd, events FROM ledger_spend_rollups ORDER BY tenant").all();
    expect(rows).toEqual([
      { tenant: "acme", cost_nanousd: 7_500_000, events: 1 },
      { tenant: "globex", cost_nanousd: 7_500_000, events: 1 },
    ]);
  });

  it("scheduled() sends through the NOTIFICATIONS_WORKER binding as the ledger-worker internal actor", async () => {
    const w = world();
    seedPeople(w);
    await ingestAll(w, burst(250));
    const calls: { headers: Record<string, string>; body: any }[] = [];
    w.env.NOTIFICATIONS_WORKER = {
      async fetch(_url: string, init: RequestInit) {
        calls.push({ headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(String(init.body)) });
        return Response.json({ data: { notification: { id: `ntf_${calls.length}` } } }, { status: 202 });
      },
    } as unknown as Fetcher;
    const [t1] = ticks();
    const report = await runScheduledSweep(w.env, t1);
    expect(report).toMatchObject({ raised: 1, emailsAccepted: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["x-internal-actor"]).toBe("ledger-worker");
    expect(calls[0]!.body).toMatchObject({ orgId: ORG, category: "product", templateKey: "ledger.anomaly.detected", recipient: { channel: "email" } });
  });
});
