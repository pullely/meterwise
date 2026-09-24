import { createBillingRepository } from "@saas/db/billing";
import type {
  CreatePlanInput,
  UpsertBillingCustomerInput,
  CreateSubscriptionInput,
  UpsertInvoiceInput,
  UpsertEntitlementInput,
} from "@saas/db/billing";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

// ── Mock executor ──────────────────────────────────────────

interface MockCall {
  sql: string;
  params: unknown[];
}

function createMockExecutor(
  handler?: (sql: string, params: unknown[]) => SqlExecutorResult<Record<string, unknown>>,
): SqlExecutor & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  return {
    calls,
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<SqlExecutorResult<T>> {
      calls.push({ sql: text, params });
      if (handler) {
        return handler(text, params) as unknown as SqlExecutorResult<T>;
      }
      return { rows: [] as T[], rowCount: 0 };
    },
  };
}

// ── Constants ──────────────────────────────────────────────

const ORG_ID = "org-test-001";
const OTHER_ORG_ID = "org-test-other";
const PLAN_ID = "plan-001";
const CUSTOMER_ID = "bcust-001";
const SUB_ID = "sub-001";
const INVOICE_ID = "inv-001";
const ENT_ID = "ent-001";

// ── Row factories ──────────────────────────────────────────

function planRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PLAN_ID,
    code: "starter",
    name: "Starter",
    description: null,
    status: "active",
    billing_interval: "month",
    price_amount_cents: "0",
    price_currency: "usd",
    metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function customerRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CUSTOMER_ID,
    org_id: ORG_ID,
    display_name: null,
    email: null,
    status: "active",
    provider: null,
    provider_customer_id: null,
    metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function subRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SUB_ID,
    org_id: ORG_ID,
    billing_customer_id: CUSTOMER_ID,
    plan_id: PLAN_ID,
    status: "active",
    current_period_start: "2026-01-01T00:00:00.000Z",
    current_period_end: "2026-02-01T00:00:00.000Z",
    trial_end: null,
    cancel_at: null,
    canceled_at: null,
    provider: null,
    provider_subscription_id: null,
    metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function invoiceRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INVOICE_ID,
    org_id: ORG_ID,
    billing_customer_id: CUSTOMER_ID,
    subscription_id: SUB_ID,
    number: "INV-0001",
    status: "open",
    amount_due_cents: "1000",
    amount_paid_cents: "0",
    currency: "usd",
    issued_at: "2026-01-15T00:00:00.000Z",
    due_at: "2026-02-01T00:00:00.000Z",
    paid_at: null,
    period_start: "2026-01-01T00:00:00.000Z",
    period_end: "2026-02-01T00:00:00.000Z",
    provider: null,
    provider_invoice_id: null,
    hosted_url: null,
    metadata: null,
    created_at: "2026-01-15T00:00:00.000Z",
    updated_at: "2026-01-15T00:00:00.000Z",
    ...o,
  };
}

function entRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENT_ID,
    org_id: ORG_ID,
    subscription_id: SUB_ID,
    entitlement_key: "feature.custom_domains",
    value_type: "boolean",
    enabled: true,
    limit_value: null,
    source: "plan",
    metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

// ── Input helpers ──────────────────────────────────────────

function planInput(o: Partial<CreatePlanInput> = {}): CreatePlanInput {
  return { id: PLAN_ID, code: "starter", name: "Starter", ...o };
}

function customerInput(
  o: Partial<UpsertBillingCustomerInput> = {},
): UpsertBillingCustomerInput {
  return { id: CUSTOMER_ID, orgId: ORG_ID, ...o };
}

function subInput(o: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput {
  return {
    id: SUB_ID,
    orgId: ORG_ID,
    billingCustomerId: CUSTOMER_ID,
    planId: PLAN_ID,
    ...o,
  };
}

function invoiceInput(o: Partial<UpsertInvoiceInput> = {}): UpsertInvoiceInput {
  return {
    id: INVOICE_ID,
    orgId: ORG_ID,
    billingCustomerId: CUSTOMER_ID,
    ...o,
  };
}

function entInput(o: Partial<UpsertEntitlementInput> = {}): UpsertEntitlementInput {
  return {
    id: ENT_ID,
    orgId: ORG_ID,
    entitlementKey: "feature.custom_domains",
    valueType: "boolean",
    ...o,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe("Billing Repository — Plans", () => {
  it("createPlan inserts and returns the plan", async () => {
    const executor = createMockExecutor(() => ({ rows: [planRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    const result = await repo.createPlan(planInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.code).toBe("starter");
      expect(result.value.status).toBe("active");
      expect(result.value.billingInterval).toBe("month");
    }
  });

  it("createPlan returns conflict on duplicate code", async () => {
    const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
    const repo = createBillingRepository(executor);
    const result = await repo.createPlan(planInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conflict");
    }
  });

  it("createPlan parameterizes all values — no SQL interpolation", async () => {
    const executor = createMockExecutor(() => ({ rows: [planRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.createPlan(planInput({ code: "pro'; DROP TABLE" }));
    const call = executor.calls[0]!;
    expect(call.sql).toContain("$1");
    expect(call.sql).not.toContain("DROP TABLE");
    expect(call.params).toContain("pro'; DROP TABLE");
  });

  it("getPlanByCode returns the plan", async () => {
    const executor = createMockExecutor(() => ({ rows: [planRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    const result = await repo.getPlanByCode("starter");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.code).toBe("starter");
  });

  it("listPlans applies optional status filter", async () => {
    const executor = createMockExecutor(() => ({ rows: [planRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.listPlans({ status: "active" });
    const call = executor.calls[0]!;
    expect(call.sql).toContain("status = $1");
    expect(call.params).toContain("active");
  });
});

describe("Billing Repository — Billing Customers", () => {
  it("upsertBillingCustomer creates a new row", async () => {
    const executor = createMockExecutor(() => ({ rows: [customerRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    const result = await repo.upsertBillingCustomer(customerInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orgId).toBe(ORG_ID);
      expect(result.value.status).toBe("active");
    }
  });

  it("upsertBillingCustomer uses ON CONFLICT on org_id (V1 invariant)", async () => {
    const executor = createMockExecutor(() => ({ rows: [customerRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.upsertBillingCustomer(customerInput());
    const call = executor.calls[0]!;
    expect(call.sql).toContain("ON CONFLICT (org_id)");
  });

  it("getBillingCustomer scopes by orgId", async () => {
    const executor = createMockExecutor(() => ({ rows: [customerRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.getBillingCustomer(ORG_ID);
    const call = executor.calls[0]!;
    expect(call.sql).toContain("WHERE org_id = $1");
    expect(call.params[0]).toBe(ORG_ID);
  });

  it("getBillingCustomer returns not_found when no row", async () => {
    const executor = createMockExecutor(() => ({ rows: [], rowCount: 0 }));
    const repo = createBillingRepository(executor);
    const result = await repo.getBillingCustomer(ORG_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("BillingCustomer type omits any plaintext provider credentials", () => {
    const row = customerRow({ provider: "stripe", provider_customer_id: "cus_abc" });
    const executor = createMockExecutor(() => ({ rows: [row], rowCount: 1 }));
    return createBillingRepository(executor)
      .getBillingCustomer(ORG_ID)
      .then((r) => {
        if (!r.ok) throw new Error("expected ok");
        // No api_key / secret / token fields should ever be present
        expect(Object.keys(r.value)).not.toEqual(
          expect.arrayContaining(["apiKey", "secret", "token", "providerSecret"]),
        );
        // Provider id is opaque only
        expect(r.value.providerCustomerId).toBe("cus_abc");
      });
  });
});

describe("Billing Repository — Subscriptions", () => {
  it("createSubscription inserts row and returns it", async () => {
    const executor = createMockExecutor(() => ({ rows: [subRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    const result = await repo.createSubscription(subInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orgId).toBe(ORG_ID);
      expect(result.value.status).toBe("active");
      expect(result.value.currentPeriodEnd).toBeInstanceOf(Date);
    }
  });

  it("getSubscription scopes by both org_id AND id (tenant isolation)", async () => {
    const executor = createMockExecutor(() => ({ rows: [subRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.getSubscription(ORG_ID, SUB_ID);
    const call = executor.calls[0]!;
    expect(call.sql).toContain("org_id = $1");
    expect(call.sql).toContain("id = $2");
    expect(call.params).toEqual([ORG_ID, SUB_ID]);
  });

  it("getSubscription cross-org lookup returns not_found", async () => {
    const executor = createMockExecutor((_sql, params) => {
      // Mimic DB: row only returned when org_id matches
      if (params[0] === OTHER_ORG_ID) return { rows: [], rowCount: 0 };
      return { rows: [subRow()], rowCount: 1 };
    });
    const repo = createBillingRepository(executor);
    const result = await repo.getSubscription(OTHER_ORG_ID, SUB_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("getActiveSubscription only returns trialing/active/past_due", async () => {
    const executor = createMockExecutor(() => ({ rows: [subRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.getActiveSubscription(ORG_ID);
    const call = executor.calls[0]!;
    expect(call.sql).toContain("trialing");
    expect(call.sql).toContain("active");
    expect(call.sql).toContain("past_due");
    expect(call.sql).not.toContain("canceled");
  });

  it("listSubscriptions scopes by org and paginates", async () => {
    const executor = createMockExecutor(() => ({
      rows: [subRow(), subRow({ id: "sub-002" })],
      rowCount: 2,
    }));
    const repo = createBillingRepository(executor);
    const result = await repo.listSubscriptions(ORG_ID, { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items.length).toBe(2);
    expect(executor.calls[0]!.sql).toContain("org_id = $1");
  });

  it("updateSubscription applies dynamic SET and requires org_id+id", async () => {
    const executor = createMockExecutor(() => ({
      rows: [subRow({ status: "canceled" })],
      rowCount: 1,
    }));
    const repo = createBillingRepository(executor);
    const result = await repo.updateSubscription(ORG_ID, SUB_ID, {
      status: "canceled",
      canceledAt: new Date("2026-01-20T00:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    const call = executor.calls[0]!;
    expect(call.sql).toContain("UPDATE billing_subscriptions");
    expect(call.sql).toContain("WHERE org_id = $1 AND id = $2");
    expect(call.params[0]).toBe(ORG_ID);
    expect(call.params[1]).toBe(SUB_ID);
  });
});

describe("Billing Repository — Invoices", () => {
  it("upsertInvoice creates and maps amounts and timestamps", async () => {
    const executor = createMockExecutor(() => ({ rows: [invoiceRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    const result = await repo.upsertInvoice(invoiceInput({ status: "open" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.amountDueCents).toBe(1000);
      expect(result.value.amountPaidCents).toBe(0);
      expect(result.value.status).toBe("open");
      expect(result.value.issuedAt).toBeInstanceOf(Date);
    }
  });

  it("upsertInvoice ON CONFLICT only updates when org_id matches (no cross-org overwrite)", async () => {
    const executor = createMockExecutor(() => ({ rows: [invoiceRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.upsertInvoice(invoiceInput());
    const call = executor.calls[0]!;
    expect(call.sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(call.sql).toContain("WHERE billing_invoices.org_id = EXCLUDED.org_id");
  });

  it("listInvoices requires orgId and applies optional filters", async () => {
    const executor = createMockExecutor(() => ({
      rows: [invoiceRow()],
      rowCount: 1,
    }));
    const repo = createBillingRepository(executor);
    await repo.listInvoices(
      { orgId: ORG_ID, subscriptionId: SUB_ID, status: "open" },
      { limit: 25, cursor: null },
    );
    const call = executor.calls[0]!;
    expect(call.sql).toContain("org_id = $1");
    expect(call.sql).toContain("subscription_id = $2");
    expect(call.sql).toContain("status = $3");
    expect(call.params[0]).toBe(ORG_ID);
  });

  it("getInvoice scopes by org_id AND id", async () => {
    const executor = createMockExecutor(() => ({ rows: [invoiceRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.getInvoice(ORG_ID, INVOICE_ID);
    const call = executor.calls[0]!;
    expect(call.sql).toContain("org_id = $1");
    expect(call.sql).toContain("id = $2");
  });

  it("Invoice type exposes safe hostedUrl only — never raw provider payloads", () => {
    const row = invoiceRow({
      hosted_url: "https://invoice.stripe.com/i/abc/safe-display",
      provider: "stripe",
      provider_invoice_id: "in_abc",
    });
    const executor = createMockExecutor(() => ({ rows: [row], rowCount: 1 }));
    return createBillingRepository(executor)
      .getInvoice(ORG_ID, INVOICE_ID)
      .then((r) => {
        if (!r.ok) throw new Error("expected ok");
        // Sanity check: type has no provider_payload, no secret field
        expect(Object.keys(r.value)).not.toEqual(
          expect.arrayContaining(["providerPayload", "rawPayload", "secret", "apiKey"]),
        );
        expect(r.value.hostedUrl).toBe("https://invoice.stripe.com/i/abc/safe-display");
      });
  });
});

describe("Billing Repository — Entitlements", () => {
  it("upsertEntitlement creates and returns row", async () => {
    const executor = createMockExecutor(() => ({ rows: [entRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    const result = await repo.upsertEntitlement(entInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entitlementKey).toBe("feature.custom_domains");
      expect(result.value.enabled).toBe(true);
      expect(result.value.limitValue).toBeNull();
    }
  });

  it("upsertEntitlement upserts on (org_id, entitlement_key)", async () => {
    const executor = createMockExecutor(() => ({ rows: [entRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.upsertEntitlement(entInput());
    expect(executor.calls[0]!.sql).toContain("ON CONFLICT (org_id, entitlement_key)");
  });

  it("upsertEntitlement supports quantity with limit_value", async () => {
    const row = entRow({
      entitlement_key: "limit.projects",
      value_type: "quantity",
      limit_value: "10",
    });
    const executor = createMockExecutor(() => ({ rows: [row], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    const result = await repo.upsertEntitlement(
      entInput({
        entitlementKey: "limit.projects",
        valueType: "quantity",
        limitValue: 10,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.valueType).toBe("quantity");
      expect(result.value.limitValue).toBe(10);
    }
  });

  it("getEntitlement scopes by org_id and entitlement_key", async () => {
    const executor = createMockExecutor(() => ({ rows: [entRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.getEntitlement(ORG_ID, "feature.custom_domains");
    const call = executor.calls[0]!;
    expect(call.sql).toContain("org_id = $1");
    expect(call.sql).toContain("entitlement_key = $2");
    expect(call.params).toEqual([ORG_ID, "feature.custom_domains"]);
  });

  it("listEntitlements requires orgId; applies subscription/source filters", async () => {
    const executor = createMockExecutor(() => ({ rows: [entRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);
    await repo.listEntitlements({
      orgId: ORG_ID,
      subscriptionId: SUB_ID,
      source: "override",
    });
    const call = executor.calls[0]!;
    expect(call.sql).toContain("org_id = $1");
    expect(call.sql).toContain("subscription_id = $2");
    expect(call.sql).toContain("source = $3");
    expect(call.params[0]).toBe(ORG_ID);
  });

  it("cross-org getEntitlement returns not_found", async () => {
    const executor = createMockExecutor((_sql, params) => {
      if (params[0] === OTHER_ORG_ID) return { rows: [], rowCount: 0 };
      return { rows: [entRow()], rowCount: 1 };
    });
    const repo = createBillingRepository(executor);
    const result = await repo.getEntitlement(OTHER_ORG_ID, "feature.custom_domains");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });
});

describe("Billing Repository — getBillingSummary", () => {
  it("composes customer + active subscription + plan + entitlements scoped to org", async () => {
    let n = 0;
    const executor = createMockExecutor(() => {
      n++;
      // 1: getBillingCustomer
      // 2: getActiveSubscription
      // 3: getPlan
      // 4: listEntitlements
      if (n === 1) return { rows: [customerRow()], rowCount: 1 };
      if (n === 2) return { rows: [subRow()], rowCount: 1 };
      if (n === 3) return { rows: [planRow()], rowCount: 1 };
      return { rows: [entRow()], rowCount: 1 };
    });
    const repo = createBillingRepository(executor);
    const result = await repo.getBillingSummary(ORG_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customer?.orgId).toBe(ORG_ID);
      expect(result.value.activeSubscription?.id).toBe(SUB_ID);
      expect(result.value.plan?.code).toBe("starter");
      expect(result.value.entitlements.length).toBe(1);
    }
    // Every org-scoped call must pass ORG_ID; plan lookup is by plan_id.
    for (const call of executor.calls) {
      if (call.sql.includes("billing_plans WHERE id")) continue;
      expect(call.params[0]).toBe(ORG_ID);
    }
  });

  it("returns nulls when no customer / subscription / plan but still includes entitlements list", async () => {
    let n = 0;
    const executor = createMockExecutor(() => {
      n++;
      if (n === 1) return { rows: [], rowCount: 0 }; // no customer
      if (n === 2) return { rows: [], rowCount: 0 }; // no sub
      // listEntitlements
      return { rows: [], rowCount: 0 };
    });
    const repo = createBillingRepository(executor);
    const result = await repo.getBillingSummary(ORG_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customer).toBeNull();
      expect(result.value.activeSubscription).toBeNull();
      expect(result.value.plan).toBeNull();
      expect(result.value.entitlements).toEqual([]);
    }
  });
});

describe("Billing Repository — metering/billing boundary", () => {
  it("never reads from or writes to metering-owned tables", async () => {
    const executor = createMockExecutor(() => ({ rows: [planRow()], rowCount: 1 }));
    const repo = createBillingRepository(executor);

    await repo.createPlan(planInput());
    await repo.upsertBillingCustomer(customerInput());
    await repo.createSubscription(subInput());
    await repo.upsertInvoice(invoiceInput());
    await repo.upsertEntitlement(entInput());
    await repo.listEntitlements({ orgId: ORG_ID });
    await repo.getEntitlement(ORG_ID, "feature.custom_domains");
    await repo.listSubscriptions(ORG_ID, { limit: 10, cursor: null });
    await repo.listInvoices({ orgId: ORG_ID }, { limit: 10, cursor: null });

    for (const call of executor.calls) {
      expect(call.sql).not.toMatch(/metering\./);
    }
  });
});
