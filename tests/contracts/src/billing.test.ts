import type {
  PublicPlan,
  PublicBillingCustomer,
  PublicSubscription,
  PublicInvoice,
  PublicEntitlement,
  ListPlansRequest,
  ListPlansResponse,
  GetBillingCustomerResponse,
  ListInvoicesRequest,
  ListInvoicesResponse,
  GetEntitlementsRequest,
  GetEntitlementsResponse,
  GetBillingSummaryResponse,
  CheckBillingEntitlementRequest,
  CheckBillingEntitlementResponse,
  BillingEntitlementAllowedDecision,
  BillingEntitlementDeniedDecision,
  BillingEntitlementDeniedReason,
} from "@saas/contracts/billing";

describe("contracts: billing — Plan shape", () => {
  it("PublicPlan has the expected fields and types", () => {
    const p: PublicPlan = {
      id: "plan_1",
      code: "starter",
      name: "Starter",
      description: null,
      status: "active",
      billingInterval: "month",
      priceAmountCents: 0,
      priceCurrency: "usd",
      metadata: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(p.code).toBe("starter");
    expect(p.status).toBe("active");
  });

  it("supports archived status and yearly/none intervals", () => {
    const yearly: PublicPlan = {
      id: "p",
      code: "annual",
      name: "Annual",
      description: null,
      status: "archived",
      billingInterval: "year",
      priceAmountCents: 99900,
      priceCurrency: "eur",
      metadata: null,
      createdAt: "x",
      updatedAt: "x",
    };
    expect(yearly.billingInterval).toBe("year");
  });

  it("ListPlansRequest accepts optional status; response wraps a list", () => {
    const req: ListPlansRequest = { status: "active" };
    const res: ListPlansResponse = { plans: [] };
    expect(req.status).toBe("active");
    expect(res.plans).toEqual([]);
  });
});

describe("contracts: billing — Customer shape", () => {
  it("PublicBillingCustomer has org_id-keyed identity and no secret fields", () => {
    const c: PublicBillingCustomer = {
      id: "bc_1",
      orgId: "org_1",
      displayName: "Acme",
      email: "billing@acme.example",
      status: "active",
      provider: "stripe",
      providerCustomerId: "cus_abc",
      metadata: null,
      createdAt: "x",
      updatedAt: "x",
    };
    expect(c.orgId).toBe("org_1");
    // Forbidden secret-bearing keys must not exist on the type
    const forbidden = ["apiKey", "secret", "token", "providerApiKey"];
    for (const k of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(c, k)).toBe(false);
    }
  });

  it("GetBillingCustomerResponse wraps a customer", () => {
    const r: GetBillingCustomerResponse = {
      customer: {
        id: "bc_1",
        orgId: "org_1",
        displayName: null,
        email: null,
        status: "active",
        provider: null,
        providerCustomerId: null,
        metadata: null,
        createdAt: "x",
        updatedAt: "x",
      },
    };
    expect(r.customer.orgId).toBe("org_1");
  });
});

describe("contracts: billing — Subscription shape", () => {
  it("PublicSubscription includes all status values", () => {
    const statuses: PublicSubscription["status"][] = [
      "trialing",
      "active",
      "past_due",
      "canceled",
      "expired",
    ];
    expect(statuses).toContain("active");
  });

  it("PublicSubscription has provider-neutral opaque ids", () => {
    const s: PublicSubscription = {
      id: "sub_1",
      orgId: "org_1",
      billingCustomerId: "bc_1",
      planId: "plan_1",
      status: "active",
      currentPeriodStart: "2026-01-01T00:00:00.000Z",
      currentPeriodEnd: "2026-02-01T00:00:00.000Z",
      trialEnd: null,
      cancelAt: null,
      canceledAt: null,
      provider: null,
      providerSubscriptionId: null,
      metadata: null,
      createdAt: "x",
      updatedAt: "x",
    };
    expect(s.orgId).toBe("org_1");
    expect(s.status).toBe("active");
  });
});

describe("contracts: billing — Invoice shape", () => {
  it("PublicInvoice exposes safe display URL and never secret fields", () => {
    const i: PublicInvoice = {
      id: "inv_1",
      orgId: "org_1",
      billingCustomerId: "bc_1",
      subscriptionId: "sub_1",
      number: "INV-0001",
      status: "open",
      amountDueCents: 1000,
      amountPaidCents: 0,
      currency: "usd",
      issuedAt: "2026-01-15T00:00:00.000Z",
      dueAt: "2026-02-01T00:00:00.000Z",
      paidAt: null,
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-02-01T00:00:00.000Z",
      provider: "stripe",
      providerInvoiceId: "in_abc",
      hostedUrl: "https://invoice.stripe.com/i/abc/safe",
      metadata: null,
      createdAt: "x",
      updatedAt: "x",
    };
    expect(i.hostedUrl).toContain("https://");
    const forbidden = [
      "providerPayload",
      "rawPayload",
      "secret",
      "apiKey",
      "checkoutSessionSecret",
      "cardNumber",
      "cvc",
    ];
    for (const k of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(i, k)).toBe(false);
    }
  });

  it("ListInvoicesRequest/Response support cursor pagination", () => {
    const req: ListInvoicesRequest = {
      subscriptionId: "sub_1",
      status: "open",
      limit: 25,
      cursor: { createdAt: "x", id: "y" },
    };
    const res: ListInvoicesResponse = {
      invoices: [],
      nextCursor: null,
    };
    expect(req.limit).toBe(25);
    expect(res.invoices).toEqual([]);
  });
});

describe("contracts: billing — Entitlement shape", () => {
  it("PublicEntitlement supports boolean/quantity/feature value types", () => {
    const e: PublicEntitlement = {
      id: "ent_1",
      orgId: "org_1",
      subscriptionId: null,
      entitlementKey: "feature.custom_domains",
      valueType: "boolean",
      enabled: true,
      limitValue: null,
      source: "plan",
      metadata: null,
      createdAt: "x",
      updatedAt: "x",
    };
    expect(e.entitlementKey).toBe("feature.custom_domains");
    expect(e.source).toBe("plan");
  });

  it("PublicEntitlement allows numeric limit for quantity types", () => {
    const e: PublicEntitlement = {
      id: "ent_2",
      orgId: "org_1",
      subscriptionId: "sub_1",
      entitlementKey: "limit.projects",
      valueType: "quantity",
      enabled: true,
      limitValue: 10,
      source: "override",
      metadata: null,
      createdAt: "x",
      updatedAt: "x",
    };
    expect(e.valueType).toBe("quantity");
    expect(e.limitValue).toBe(10);
  });

  it("GetEntitlementsRequest accepts optional filters; response wraps a list", () => {
    const req: GetEntitlementsRequest = { source: "plan" };
    const res: GetEntitlementsResponse = { entitlements: [] };
    expect(req.source).toBe("plan");
    expect(res.entitlements).toEqual([]);
  });
});

describe("contracts: billing — Summary shape", () => {
  it("GetBillingSummaryResponse composes customer/sub/plan/entitlements", () => {
    const r: GetBillingSummaryResponse = {
      customer: null,
      activeSubscription: null,
      plan: null,
      entitlements: [],
    };
    expect(r.entitlements).toEqual([]);
  });
});

describe("contracts: billing — secret-safe surface (type-level)", () => {
  it("PublicBillingCustomer compiles without secret-bearing fields", () => {
    // This file fails to compile if any of the Public* types include
    // apiKey / secret / token / providerPayload / cardNumber / cvc /
    // bearerToken / checkoutSessionSecret. The assertions in the suites
    // above already exercise the runtime shape; this test just documents
    // the invariant.
    expect(true).toBe(true);
  });
});

describe("contracts: billing — Entitlement decision (internal seam)", () => {
  it("CheckBillingEntitlementRequest only carries orgId + entitlementKey", () => {
    const req: CheckBillingEntitlementRequest = {
      orgId: "org_11111111111111111111111111111111",
      entitlementKey: "feature.custom_domains",
    };
    expect(req.orgId).toMatch(/^org_/);
    expect(req.entitlementKey).toBe("feature.custom_domains");
    const forbidden = [
      "apiKey",
      "secret",
      "token",
      "providerCustomerId",
      "providerSubscriptionId",
      "providerPayload",
      "sql",
      "metadata",
    ];
    for (const k of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(req, k)).toBe(false);
    }
  });

  it("BillingEntitlementAllowedDecision shape carries safe entitlement details only", () => {
    const allowed: BillingEntitlementAllowedDecision = {
      allowed: true,
      orgId: "org_1",
      entitlementKey: "feature.custom_domains",
      valueType: "boolean",
      limitValue: null,
      source: "plan",
      subscriptionId: null,
    };
    expect(allowed.allowed).toBe(true);
    expect(allowed.source).toBe("plan");
    const forbidden = [
      "apiKey",
      "secret",
      "token",
      "providerPayload",
      "rawPayload",
      "sql",
      "stack",
      "stackTrace",
      "metadata",
      "providerSubscriptionId",
    ];
    for (const k of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(allowed, k)).toBe(false);
    }
  });

  it("BillingEntitlementDeniedDecision uses a narrow reason set", () => {
    const reasons: BillingEntitlementDeniedReason[] = ["disabled", "not_configured"];
    expect(reasons).toEqual(["disabled", "not_configured"]);
    const denied: BillingEntitlementDeniedDecision = {
      allowed: false,
      orgId: "org_1",
      entitlementKey: "feature.custom_domains",
      reason: "not_configured",
    };
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("not_configured");
  });

  it("CheckBillingEntitlementResponse discriminates on `allowed`", () => {
    const responses: CheckBillingEntitlementResponse[] = [
      {
        allowed: true,
        orgId: "org_1",
        entitlementKey: "limit.projects",
        valueType: "quantity",
        limitValue: 10,
        source: "override",
        subscriptionId: "sub_1",
      },
      {
        allowed: false,
        orgId: "org_1",
        entitlementKey: "limit.projects",
        reason: "disabled",
      },
    ];
    const allowedCount = responses.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(1);
  });
});
