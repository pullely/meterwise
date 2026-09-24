import { handleWebhookIntake } from "@billing-worker/handlers/webhook-intake";
import { route } from "@billing-worker/router";
import { PLAN_CATALOG } from "@billing-worker/plan-catalog";
import type { Env } from "@billing-worker/env";
import type { BillingProviderRegistry } from "@billing-worker/billing-provider/registry";
import type {
  BillingProvider,
  NormalizedEvent,
  VerifyWebhookResult,
} from "@billing-worker/billing-provider/types";
import type {
  BillingRepository,
  BillingResult,
  Subscription,
  BillingCustomer,
  Entitlement,
  Plan,
} from "@saas/db/billing";

const ORG_PUBLIC = "org_2f65ddde1f5b4e938c0b80e030e31229";
const ORG_HEX = "2f65ddde-1f5b-4e93-8c0b-80e030e31229";
const PRODUCT_MAP = { pro: "prod_p", business: "prod_b" };

type RepoSlice = Pick<
  BillingRepository,
  | "createPlan"
  | "getPlanByCode"
  | "upsertBillingCustomer"
  | "getActiveSubscription"
  | "createSubscription"
  | "updateSubscription"
  | "upsertEntitlement"
>;

interface State {
  subscriptions: Subscription[];
  entitlements: Entitlement[];
}

function fakeRepo(state: State): RepoSlice {
  let n = 0;
  const id = () => `id_${++n}`;
  return {
    createPlan: async (i): Promise<BillingResult<Plan>> => ({
      ok: true,
      value: { id: i.id, code: i.code, name: i.name } as Plan,
    }),
    getPlanByCode: async (code): Promise<BillingResult<Plan>> => {
      const def = PLAN_CATALOG.find((p) => p.code === code);
      if (!def) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: { id: def.id, code: def.code, name: def.name } as Plan };
    },
    upsertBillingCustomer: async (i): Promise<BillingResult<BillingCustomer>> => ({
      ok: true,
      value: { id: i.id ?? id(), orgId: i.orgId } as BillingCustomer,
    }),
    getActiveSubscription: async (orgId): Promise<BillingResult<Subscription>> => {
      const s = state.subscriptions.find((x) => x.orgId === orgId && x.status === "active");
      return s ? { ok: true, value: s } : { ok: false, error: { kind: "not_found" } };
    },
    createSubscription: async (i): Promise<BillingResult<Subscription>> => {
      const sub = {
        id: i.id,
        orgId: i.orgId,
        planId: i.planId,
        status: "active",
        provider: i.provider ?? null,
        providerSubscriptionId: i.providerSubscriptionId ?? null,
        currentPeriodEnd: i.currentPeriodEnd ?? null,
      } as Subscription;
      state.subscriptions.push(sub);
      return { ok: true, value: sub };
    },
    updateSubscription: async (orgId, sid, patch): Promise<BillingResult<Subscription>> => {
      const s = state.subscriptions.find((x) => x.orgId === orgId && x.id === sid)!;
      if (patch.status) s.status = patch.status;
      if (patch.provider !== undefined) s.provider = patch.provider;
      if (patch.providerSubscriptionId !== undefined) s.providerSubscriptionId = patch.providerSubscriptionId;
      return { ok: true, value: s };
    },
    upsertEntitlement: async (i): Promise<BillingResult<Entitlement>> => {
      const ent = { id: i.id, orgId: i.orgId, entitlementKey: i.entitlementKey } as Entitlement;
      state.entitlements.push(ent);
      return { ok: true, value: ent };
    },
  };
}

function fullProvider(verify: VerifyWebhookResult): BillingProvider {
  return {
    id: "polar",
    createCheckout: async () => ({ checkoutUrl: "https://x/checkout" }),
    createPortalSession: async () => ({ portalUrl: "https://x/portal" }),
    getCustomerByExternalId: async () => null,
    hasActiveSubscription: async () => false,
    cancelSubscription: async () => ({ cancelAtPeriodEnd: true }),
    changeSubscriptionPlan: async () => ({ changed: true }),
    getActiveSubscription: async () => null,
    listPaymentMethods: async () => [],
    verifyWebhook: async () => verify,
  };
}

function registryFor(
  verify: VerifyWebhookResult,
  resolveFail?: "not_configured" | "unknown_provider",
): BillingProviderRegistry {
  const provider = fullProvider(verify);
  return {
    get: () => provider,
    resolve: () => (resolveFail ? { ok: false, reason: resolveFail } : { ok: true, provider }),
  };
}

function intakeReq(): Request {
  return new Request("https://billing-worker/v1/internal/billing/webhooks/polar", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-caller": "api-edge" },
    body: "{}",
  });
}

const env = { ENVIRONMENT: "test" } as Env;
const subEvent = (over: Partial<NormalizedEvent> = {}): VerifyWebhookResult => ({
  ok: true,
  event: {
    providerEventId: "evt_1",
    provider: "polar",
    type: "subscription.activated",
    orgId: ORG_PUBLIC,
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
    productId: "prod_b",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    ...over,
  } as NormalizedEvent,
});

describe("handleWebhookIntake", () => {
  function deps(verify: VerifyWebhookResult, state: State, resolveFail?: "not_configured") {
    return {
      registry: registryFor(verify, resolveFail),
      productMap: PRODUCT_MAP,
      repoFactory: () => fakeRepo(state),
      generateId: ((c) => () => `id_${++c}`)(0),
    };
  }

  it("assigns the mapped plan on subscription.activated", async () => {
    const state: State = { subscriptions: [], entitlements: [] };
    const res = await handleWebhookIntake(intakeReq(), env, "req_t", deps(subEvent(), state));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { handled: string } };
    expect(body.data.handled).toBe("assigned:business");
    expect(state.subscriptions[0]!.planId).toBe("plan_business");
    expect(state.subscriptions[0]!.orgId).toBe(ORG_HEX);
    // The provider linkage must be persisted so the sub is manageable later.
    expect(state.subscriptions[0]!.provider).toBe("polar");
    expect(state.subscriptions[0]!.providerSubscriptionId).toBe("sub_1");
  });

  it("back-fills provider linkage on a same-plan subscription.updated", async () => {
    // Seed an existing business sub created without provider linkage (the bug).
    const state: State = {
      subscriptions: [
        { id: "sub_old", orgId: ORG_HEX, planId: "plan_business", status: "active", provider: null, providerSubscriptionId: null } as Subscription,
      ],
      entitlements: [],
    };
    await handleWebhookIntake(
      intakeReq(),
      env,
      "req_t",
      deps(subEvent({ type: "subscription.updated" }), state),
    );
    const sub = state.subscriptions.find((s) => s.id === "sub_old")!;
    expect(sub.provider).toBe("polar");
    expect(sub.providerSubscriptionId).toBe("sub_1");
  });

  it("triggers child refanout after subscription.activated (MO3)", async () => {
    const state: State = { subscriptions: [], entitlements: [] };
    const calls: Array<{ org: string; mode: string }> = [];
    const d = {
      ...deps(subEvent(), state),
      syncChildren: async (org: string, mode: "refanout" | "freeze") => { calls.push({ org, mode }); },
    };
    await handleWebhookIntake(intakeReq(), env, "req_t", d);
    expect(calls).toEqual([{ org: ORG_PUBLIC, mode: "refanout" }]);
  });

  it("triggers child freeze after subscription.canceled (MO3)", async () => {
    const state: State = { subscriptions: [], entitlements: [] };
    const calls: Array<{ org: string; mode: string }> = [];
    const d = {
      ...deps(subEvent({ type: "subscription.canceled" }), state),
      syncChildren: async (org: string, mode: "refanout" | "freeze") => { calls.push({ org, mode }); },
    };
    await handleWebhookIntake(intakeReq(), env, "req_t", d);
    expect(calls).toEqual([{ org: ORG_PUBLIC, mode: "freeze" }]);
  });

  it("downgrades to free on subscription.canceled", async () => {
    const state: State = { subscriptions: [], entitlements: [] };
    const verify = subEvent({ type: "subscription.canceled" });
    const res = await handleWebhookIntake(intakeReq(), env, "req_t", deps(verify, state));
    const body = (await res.json()) as { data: { handled: string } };
    expect(body.data.handled).toBe("assigned:free");
    expect(state.subscriptions[0]!.planId).toBe("plan_free");
  });

  it("no-ops on an unmapped product id", async () => {
    const state: State = { subscriptions: [], entitlements: [] };
    const verify = subEvent({ productId: "prod_unknown" });
    const res = await handleWebhookIntake(intakeReq(), env, "req_t", deps(verify, state));
    const body = (await res.json()) as { data: { handled: string } };
    expect(body.data.handled).toBe("noop:unknown-product");
    expect(state.subscriptions).toHaveLength(0);
  });

  it("acks ignored / invoice events without state change", async () => {
    const state: State = { subscriptions: [], entitlements: [] };
    const verify: VerifyWebhookResult = {
      ok: true,
      event: { providerEventId: "e", provider: "polar", type: "ignored", providerType: "benefit.created" },
    };
    const res = await handleWebhookIntake(intakeReq(), env, "req_t", deps(verify, state));
    expect(res.status).toBe(200);
    expect(state.subscriptions).toHaveLength(0);
  });

  it("rejects an invalid signature with 401", async () => {
    const state: State = { subscriptions: [], entitlements: [] };
    const verify: VerifyWebhookResult = { ok: false, reason: "invalid_signature" };
    const res = await handleWebhookIntake(intakeReq(), env, "req_t", deps(verify, state));
    expect(res.status).toBe(401);
  });

  it("returns 503 when the provider is not configured", async () => {
    const state: State = { subscriptions: [], entitlements: [] };
    const res = await handleWebhookIntake(
      intakeReq(),
      env,
      "req_t",
      deps(subEvent(), state, "not_configured"),
    );
    expect(res.status).toBe(503);
  });
});

describe("intake route auth", () => {
  it("rejects the intake route without a valid x-internal-caller (403)", async () => {
    const req = new Request("https://billing-worker/v1/internal/billing/webhooks/polar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await route(req, env);
    expect(res.status).toBe(403);
  });
});
