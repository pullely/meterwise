import {
  parseAssignPlanBody,
  assignPlanWithRepos,
} from "@billing-worker/handlers/assign-plan";
import {
  PLAN_CATALOG,
  getPlanDefinition,
  isKnownPlanCode,
  DEFAULT_PLAN_CODE,
} from "@billing-worker/plan-catalog";
import type {
  BillingRepository,
  BillingResult,
  Subscription,
  Entitlement,
  BillingCustomer,
  Plan,
} from "@saas/db/billing";

const ORG_PUBLIC = "org_2f65ddde1f5b4e938c0b80e030e31229";
const ORG_HEX = "2f65ddde-1f5b-4e93-8c0b-80e030e31229";

// ── Catalog ────────────────────────────────────────────────
describe("plan catalog", () => {
  it("declares free + pro with the bootstrap-critical limit keys", () => {
    const free = getPlanDefinition("free")!;
    const pro = getPlanDefinition("pro")!;
    const freeKeys = free.entitlements.map((e) => e.entitlementKey);
    expect(freeKeys).toEqual(
      expect.arrayContaining(["limit.projects", "limit.environments", "limit.members"]),
    );
    // Pro limits exceed free (proves upgrade has an effect).
    const projFree = free.entitlements.find((e) => e.entitlementKey === "limit.projects")!.limitValue!;
    const projPro = pro.entitlements.find((e) => e.entitlementKey === "limit.projects")!.limitValue!;
    expect(projPro).toBeGreaterThan(projFree);
  });

  it("free limits are >= the PR-#209 stopgap so retiring it cannot regress", () => {
    const free = getPlanDefinition("free")!;
    const byKey = Object.fromEntries(free.entitlements.map((e) => [e.entitlementKey, e.limitValue]));
    expect(byKey["limit.projects"]).toBeGreaterThanOrEqual(3);
    expect(byKey["limit.environments"]).toBeGreaterThanOrEqual(3);
    expect(byKey["limit.members"]).toBeGreaterThanOrEqual(5);
  });

  it("DEFAULT_PLAN_CODE is a known plan", () => {
    expect(isKnownPlanCode(DEFAULT_PLAN_CODE)).toBe(true);
    expect(getPlanDefinition(DEFAULT_PLAN_CODE)).not.toBeNull();
  });

  it("adds business + enterprise tiers and the multi-org entitlement keys (D5)", () => {
    expect(PLAN_CATALOG.map((p) => p.code)).toEqual(["free", "pro", "business", "enterprise"]);
    expect(isKnownPlanCode("business")).toBe(true);
    expect(isKnownPlanCode("enterprise")).toBe(true);

    const multiOrg = (code: string) =>
      getPlanDefinition(code)!.entitlements.find((e) => e.entitlementKey === "feature.multi_org")!;
    const orgLimit = (code: string) =>
      getPlanDefinition(code)!.entitlements.find((e) => e.entitlementKey === "limit.organizations")!;

    // Multi-org unlocks at Business; free/pro stay single-org.
    expect(multiOrg("free").enabled).toBe(false);
    expect(orgLimit("free").limitValue).toBe(1);
    expect(multiOrg("pro").enabled).toBe(false);
    expect(orgLimit("pro").limitValue).toBe(1);
    expect(multiOrg("business").enabled).toBe(true);
    expect(orgLimit("business").limitValue).toBe(5);
    expect(multiOrg("enterprise").enabled).toBe(true);
    expect(orgLimit("enterprise").limitValue).toBeNull(); // unlimited
  });
});

describe("parseAssignPlanBody", () => {
  it("rejects non-object / missing fields / unknown plan / malformed org", () => {
    expect("error" in parseAssignPlanBody(null)).toBe(true);
    expect("error" in parseAssignPlanBody({ planCode: "free" })).toBe(true);
    expect("error" in parseAssignPlanBody({ orgId: ORG_PUBLIC })).toBe(true);
    expect("error" in parseAssignPlanBody({ orgId: ORG_PUBLIC, planCode: "platinum" })).toBe(true);
    expect("error" in parseAssignPlanBody({ orgId: "org_short", planCode: "free" })).toBe(true);
  });
  it("accepts a well-formed payload and maps the org public id to hex", () => {
    const parsed = parseAssignPlanBody({ orgId: ORG_PUBLIC, planCode: "free" });
    expect(parsed).toEqual({ publicOrgId: ORG_PUBLIC, orgId: ORG_HEX, planCode: "free" });
  });
});

// ── Fake repository ────────────────────────────────────────
function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: "plan_free",
    code: "free",
    name: "Free",
    description: null,
    status: "active",
    billingInterval: "month",
    priceAmountCents: 0,
    priceCurrency: "usd",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

interface FakeState {
  customers: BillingCustomer[];
  subscriptions: Subscription[];
  entitlements: Entitlement[];
  events: { type: string }[];
}

function makeFakeRepo(state: FakeState, opts: { activePlanId?: string } = {}) {
  let n = 0;
  const repo: Pick<
    BillingRepository,
    | "createPlan"
    | "getPlanByCode"
    | "upsertBillingCustomer"
    | "getActiveSubscription"
    | "createSubscription"
    | "updateSubscription"
    | "upsertEntitlement"
  > = {
    createPlan: async (input): Promise<BillingResult<Plan>> => ({ ok: true, value: makePlan({ id: input.id, code: input.code, name: input.name }) }),
    getPlanByCode: async (code): Promise<BillingResult<Plan>> => {
      const def = PLAN_CATALOG.find((p) => p.code === code);
      if (!def) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: makePlan({ id: def.id, code: def.code, name: def.name }) };
    },
    upsertBillingCustomer: async (input): Promise<BillingResult<BillingCustomer>> => {
      let cust = state.customers.find((c) => c.orgId === input.orgId);
      if (!cust) {
        cust = { id: input.id, orgId: input.orgId, displayName: null, email: null, status: "active", provider: null, providerCustomerId: null, metadata: null, createdAt: new Date(), updatedAt: new Date() };
        state.customers.push(cust);
      }
      return { ok: true, value: cust };
    },
    getActiveSubscription: async (orgId): Promise<BillingResult<Subscription>> => {
      const sub = state.subscriptions.find((s) => s.orgId === orgId && s.status === "active");
      if (!sub) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: sub };
    },
    createSubscription: async (input): Promise<BillingResult<Subscription>> => {
      const sub: Subscription = { id: input.id, orgId: input.orgId, billingCustomerId: input.billingCustomerId, planId: input.planId, status: input.status ?? "active", currentPeriodStart: input.currentPeriodStart ?? null, currentPeriodEnd: null, trialEnd: null, cancelAt: null, canceledAt: null, provider: null, providerSubscriptionId: null, metadata: null, createdAt: new Date(), updatedAt: new Date() };
      state.subscriptions.push(sub);
      return { ok: true, value: sub };
    },
    updateSubscription: async (orgId, id, input): Promise<BillingResult<Subscription>> => {
      const sub = state.subscriptions.find((s) => s.orgId === orgId && s.id === id);
      if (!sub) return { ok: false, error: { kind: "not_found" } };
      if (input.status) sub.status = input.status;
      if (input.canceledAt !== undefined) sub.canceledAt = input.canceledAt;
      return { ok: true, value: sub };
    },
    upsertEntitlement: async (input): Promise<BillingResult<Entitlement>> => {
      const idx = state.entitlements.findIndex((e) => e.orgId === input.orgId && e.entitlementKey === input.entitlementKey);
      const ent: Entitlement = { id: input.id, orgId: input.orgId, subscriptionId: input.subscriptionId ?? null, entitlementKey: input.entitlementKey, valueType: input.valueType, enabled: input.enabled ?? true, limitValue: input.limitValue ?? null, source: input.source ?? "plan", metadata: null, createdAt: new Date(), updatedAt: new Date() };
      if (idx >= 0) state.entitlements[idx] = ent;
      else state.entitlements.push(ent);
      return { ok: true, value: ent };
    },
  };
  // seed an active subscription if requested
  if (opts.activePlanId) {
    state.subscriptions.push({ id: "sub_old", orgId: ORG_HEX, billingCustomerId: "cus_x", planId: opts.activePlanId, status: "active", currentPeriodStart: null, currentPeriodEnd: null, trialEnd: null, cancelAt: null, canceledAt: null, provider: null, providerSubscriptionId: null, metadata: null, createdAt: new Date(), updatedAt: new Date() });
  }
  void n;
  return repo;
}

function fakeEvents(state: FakeState) {
  return {
    appendEventWithAudit: async (input: { event: { type: string } }) => {
      state.events.push({ type: input.event.type });
      return { ok: true as const, value: {} as never };
    },
  };
}

const parsed = { publicOrgId: ORG_PUBLIC, orgId: ORG_HEX, planCode: "free" };
const opts = () => ({ now: new Date("2026-06-02T00:00:00Z"), genId: ((c) => () => `id_${++c}`)(0), actor: { id: "usr_1", type: "user" }, requestId: "req_test" });

describe("assignPlanWithRepos", () => {
  it("creates a subscription and materializes the free plan's entitlements (bootstrap)", async () => {
    const state: FakeState = { customers: [], subscriptions: [], entitlements: [], events: [] };
    const repo = makeFakeRepo(state);
    const def = getPlanDefinition("free")!;
    const out = await assignPlanWithRepos(repo, fakeEvents(state), parsed, def, opts());
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.created).toBe(true);
    expect(out.changed).toBe(false);
    // entitlements materialized for every catalog key, bound to the subscription
    const keys = state.entitlements.map((e) => e.entitlementKey).sort();
    expect(keys).toEqual(def.entitlements.map((e) => e.entitlementKey).sort());
    const proj = state.entitlements.find((e) => e.entitlementKey === "limit.projects")!;
    expect(proj.limitValue).toBe(3);
    expect(proj.source).toBe("plan");
    expect(proj.subscriptionId).toBe(out.subscriptionId);
    // events emitted
    expect(state.events.map((e) => e.type)).toEqual(["subscription.created", "entitlements.updated"]);
  });

  it("is idempotent when the same plan is already active (no new subscription, re-materializes)", async () => {
    const state: FakeState = { customers: [], subscriptions: [], entitlements: [], events: [] };
    const repo = makeFakeRepo(state, { activePlanId: "plan_free" });
    const def = getPlanDefinition("free")!;
    const out = await assignPlanWithRepos(repo, fakeEvents(state), parsed, def, opts());
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.created).toBe(false);
    expect(out.changed).toBe(false);
    expect(out.subscriptionId).toBe("sub_old");
    expect(state.subscriptions.filter((s) => s.status === "active")).toHaveLength(1);
  });

  it("upgrades: cancels the old active subscription and creates a new one with higher limits", async () => {
    const state: FakeState = { customers: [], subscriptions: [], entitlements: [], events: [] };
    const repo = makeFakeRepo(state, { activePlanId: "plan_free" });
    const def = getPlanDefinition("pro")!;
    const out = await assignPlanWithRepos(repo, fakeEvents(state), { ...parsed, planCode: "pro" }, def, opts());
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.created).toBe(true);
    expect(out.changed).toBe(true);
    const old = state.subscriptions.find((s) => s.id === "sub_old")!;
    expect(old.status).toBe("canceled");
    const proj = state.entitlements.find((e) => e.entitlementKey === "limit.projects")!;
    expect(proj.limitValue).toBe(25); // pro
    expect(state.events.map((e) => e.type)).toContain("subscription.created");
  });

  it("surfaces repo_error if the subscription create fails", async () => {
    const state: FakeState = { customers: [], subscriptions: [], entitlements: [], events: [] };
    const repo = makeFakeRepo(state);
    repo.createSubscription = async () => ({ ok: false, error: { kind: "internal", message: "boom" } });
    const out = await assignPlanWithRepos(repo, null, parsed, getPlanDefinition("free")!, opts());
    expect(out.kind).toBe("repo_error");
  });

  it("still succeeds when event emission throws (best-effort)", async () => {
    const state: FakeState = { customers: [], subscriptions: [], entitlements: [], events: [] };
    const repo = makeFakeRepo(state);
    const throwingEvents = { appendEventWithAudit: async () => { throw new Error("events down"); } };
    const out = await assignPlanWithRepos(repo, throwingEvents as never, parsed, getPlanDefinition("free")!, opts());
    expect(out.kind).toBe("ok");
    expect(state.entitlements.length).toBeGreaterThan(0);
  });
});
