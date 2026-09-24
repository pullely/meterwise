import { handleListEntitlementDecisions } from "@admin-worker/handlers/list-entitlement-decisions";
import type { ListEntitlementDecisionsDeps } from "@admin-worker/handlers/list-entitlement-decisions";
import type { SupportRequestContext } from "@admin-worker/handlers/record-support-action";
import type { Env } from "@admin-worker/env";
import type {
  DecisionAggregateBucket,
  DecisionAggregateQuery,
  BillingResult,
} from "@saas/db/billing";

function createFakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: {} as unknown as D1Database,
  };
}

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const ORG_PUBLIC = `org_${ORG_UUID.replace(/-/g, "")}`;

function createDeps(
  buckets: DecisionAggregateBucket[],
  capture: { orgId: string; query: DecisionAggregateQuery }[] = [],
  events: unknown[] = [],
  result?: BillingResult<DecisionAggregateBucket[]>,
): ListEntitlementDecisionsDeps {
  return {
    decisionRepo: {
      async aggregateDecisions(
        orgId: string,
        query: DecisionAggregateQuery,
      ): Promise<BillingResult<DecisionAggregateBucket[]>> {
        capture.push({ orgId, query });
        return result ?? { ok: true, value: buckets };
      },
    },
    eventsRepo: {
      async appendEventWithAudit(args: unknown) {
        events.push(args);
        return { ok: true, value: { eventId: "evt", auditId: "aud" } } as never;
      },
    },
    now: () => new Date("2026-02-01T00:00:00.000Z"),
    generateId: () => "00000000-0000-4000-8000-000000000001",
  };
}

function ctx(overrides: Partial<SupportRequestContext> = {}): SupportRequestContext {
  return {
    actor: { subjectId: "usr_agent", subjectType: "user" },
    supportRoleClaim: "support_admin",
    systemOverride: false,
    ...overrides,
  };
}

function url(query = ""): URL {
  return new URL(`http://admin/v1/internal/support/organizations/${ORG_PUBLIC}/entitlement-decisions${query}`);
}

describe("admin-worker: list-entitlement-decisions", () => {
  it("denies an unauthorized caller and audits the denial (support.access_denied)", async () => {
    const events: unknown[] = [];
    const deps = createDeps([], [], events);
    const res = await handleListEntitlementDecisions(
      createFakeEnv(),
      "req_1",
      ctx({ actor: null, supportRoleClaim: null }),
      ORG_PUBLIC,
      url(),
      deps,
    );
    expect(res.status).toBe(403);
    expect(events).toHaveLength(1);
    const ev = events[0] as { event: { type: string } };
    expect(ev.event.type).toBe("support.access_denied");
  });

  it("does not query the repo when the caller is denied", async () => {
    const capture: { orgId: string; query: DecisionAggregateQuery }[] = [];
    const deps = createDeps([], capture);
    await handleListEntitlementDecisions(
      createFakeEnv(),
      "req_1b",
      ctx({ actor: null, supportRoleClaim: null }),
      ORG_PUBLIC,
      url(),
      deps,
    );
    expect(capture).toHaveLength(0);
  });

  it("returns 404 for a malformed org id", async () => {
    const deps = createDeps([]);
    const res = await handleListEntitlementDecisions(
      createFakeEnv(),
      "req_2",
      ctx(),
      "not-an-org-id",
      undefined,
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("returns per-(entitlementKey, outcome) counts for an authorized caller", async () => {
    const buckets: DecisionAggregateBucket[] = [
      { entitlementKey: "feature.custom_domains", outcome: "allowed", denialReason: null, count: 7 },
      { entitlementKey: "feature.custom_domains", outcome: "denied", denialReason: "disabled", count: 3 },
      { entitlementKey: "limit.projects", outcome: "denied", denialReason: "not_configured", count: 1 },
    ];
    const deps = createDeps(buckets);
    const res = await handleListEntitlementDecisions(
      createFakeEnv(),
      "req_3",
      ctx(),
      ORG_PUBLIC,
      url(),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        orgId: string;
        windowHours: number;
        decisions: Array<{ entitlementKey: string; outcome: string; count: number; denialReason?: string }>;
      };
    };
    expect(body.data.orgId).toBe(ORG_PUBLIC);
    expect(body.data.windowHours).toBe(24);
    expect(body.data.decisions).toHaveLength(3);
    const allowed = body.data.decisions.find((d) => d.outcome === "allowed");
    expect(allowed).toEqual({ entitlementKey: "feature.custom_domains", outcome: "allowed", count: 7 });
    const disabled = body.data.decisions.find((d) => d.denialReason === "disabled");
    expect(disabled).toEqual({
      entitlementKey: "feature.custom_domains",
      outcome: "denied",
      count: 3,
      denialReason: "disabled",
    });
  });

  it("projection exposes ONLY counts — no limit values, subscription IDs, sources, or secrets", async () => {
    const buckets: DecisionAggregateBucket[] = [
      { entitlementKey: "feature.custom_domains", outcome: "allowed", denialReason: null, count: 5 },
    ];
    const deps = createDeps(buckets);
    const res = await handleListEntitlementDecisions(createFakeEnv(), "req_4", ctx(), ORG_PUBLIC, url(), deps);
    const raw = await res.text();
    for (const forbidden of ["limitValue", "subscriptionId", "subscription_id", "source", "valueType", "metadata", "secret"]) {
      expect(raw).not.toContain(forbidden);
    }
    const body = JSON.parse(raw) as { data: { decisions: Array<Record<string, unknown>> } };
    expect(Object.keys(body.data.decisions[0]!).sort()).toEqual(["count", "entitlementKey", "outcome"]);
  });

  it("honors a bounded windowHours query param and derives the since bound", async () => {
    const capture: { orgId: string; query: DecisionAggregateQuery }[] = [];
    const deps = createDeps([], capture);
    const res = await handleListEntitlementDecisions(
      createFakeEnv(),
      "req_5",
      ctx(),
      ORG_PUBLIC,
      url("?windowHours=1"),
      deps,
    );
    expect(res.status).toBe(200);
    expect(capture).toHaveLength(1);
    expect(capture[0]!.orgId).toBe(ORG_UUID);
    // now = 2026-02-01T00:00:00Z, window 1h → since 2026-01-31T23:00:00Z
    expect(capture[0]!.query.since.toISOString()).toBe("2026-01-31T23:00:00.000Z");
    expect(capture[0]!.query.until?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(capture[0]!.query.maxGroups).toBeGreaterThan(0);
  });

  it("rejects an out-of-range windowHours with 422", async () => {
    const deps = createDeps([]);
    const res = await handleListEntitlementDecisions(
      createFakeEnv(),
      "req_6",
      ctx(),
      ORG_PUBLIC,
      url("?windowHours=100000"),
      deps,
    );
    expect(res.status).toBe(422);
  });

  it("returns 500 when the aggregation repo fails", async () => {
    const deps = createDeps([], [], [], { ok: false, error: { kind: "internal", message: "boom" } });
    const res = await handleListEntitlementDecisions(createFakeEnv(), "req_7", ctx(), ORG_PUBLIC, url(), deps);
    expect(res.status).toBe(500);
  });

  it("authorizes a system-override actor", async () => {
    const buckets: DecisionAggregateBucket[] = [];
    const deps = createDeps(buckets);
    const res = await handleListEntitlementDecisions(
      createFakeEnv(),
      "req_8",
      ctx({ actor: { subjectId: "sys", subjectType: "system" }, supportRoleClaim: null, systemOverride: true }),
      ORG_PUBLIC,
      url(),
      deps,
    );
    expect(res.status).toBe(200);
  });
});
