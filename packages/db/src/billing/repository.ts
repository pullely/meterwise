import type { SqlExecutor } from "../d1/executor.js";
import type {
  BillingRepository,
  BillingResult,
  CursorPosition,
  PagedResult,
  PageQueryParams,
  Plan,
  PlanStatus,
  BillingInterval,
  CreatePlanInput,
  ListPlansQuery,
  BillingCustomer,
  BillingCustomerStatus,
  UpsertBillingCustomerInput,
  Subscription,
  SubscriptionStatus,
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
  Invoice,
  InvoiceStatus,
  UpsertInvoiceInput,
  ListInvoicesQuery,
  Entitlement,
  EntitlementValueType,
  EntitlementSource,
  UpsertEntitlementInput,
  ListEntitlementsQuery,
  BillingSummary,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";
import { parseBooleanColumn, parseNullableJsonColumn } from "../json.js";

// ── Row mappers ────────────────────────────────────────────

function toDate(v: unknown): Date {
  return new Date(v as string);
}

function toDateOrNull(v: unknown): Date | null {
  return v == null ? null : new Date(v as string);
}

function mapPlan(row: Record<string, unknown>): Plan {
  return {
    id: row.id as string,
    code: row.code as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    status: row.status as PlanStatus,
    billingInterval: row.billing_interval as BillingInterval,
    priceAmountCents: row.price_amount_cents == null ? null : Number(row.price_amount_cents),
    priceCurrency: row.price_currency as string,
    metadata: parseNullableJsonColumn<Record<string, unknown>>(row.metadata),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapBillingCustomer(row: Record<string, unknown>): BillingCustomer {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    displayName: (row.display_name as string) ?? null,
    email: (row.email as string) ?? null,
    status: row.status as BillingCustomerStatus,
    provider: (row.provider as string) ?? null,
    providerCustomerId: (row.provider_customer_id as string) ?? null,
    metadata: parseNullableJsonColumn<Record<string, unknown>>(row.metadata),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapSubscription(row: Record<string, unknown>): Subscription {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    billingCustomerId: row.billing_customer_id as string,
    planId: row.plan_id as string,
    status: row.status as SubscriptionStatus,
    currentPeriodStart: toDateOrNull(row.current_period_start),
    currentPeriodEnd: toDateOrNull(row.current_period_end),
    trialEnd: toDateOrNull(row.trial_end),
    cancelAt: toDateOrNull(row.cancel_at),
    canceledAt: toDateOrNull(row.canceled_at),
    provider: (row.provider as string) ?? null,
    providerSubscriptionId: (row.provider_subscription_id as string) ?? null,
    metadata: parseNullableJsonColumn<Record<string, unknown>>(row.metadata),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapInvoice(row: Record<string, unknown>): Invoice {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    billingCustomerId: row.billing_customer_id as string,
    subscriptionId: (row.subscription_id as string) ?? null,
    number: (row.number as string) ?? null,
    status: row.status as InvoiceStatus,
    amountDueCents: Number(row.amount_due_cents),
    amountPaidCents: Number(row.amount_paid_cents),
    currency: row.currency as string,
    issuedAt: toDateOrNull(row.issued_at),
    dueAt: toDateOrNull(row.due_at),
    paidAt: toDateOrNull(row.paid_at),
    periodStart: toDateOrNull(row.period_start),
    periodEnd: toDateOrNull(row.period_end),
    provider: (row.provider as string) ?? null,
    providerInvoiceId: (row.provider_invoice_id as string) ?? null,
    hostedUrl: (row.hosted_url as string) ?? null,
    metadata: parseNullableJsonColumn<Record<string, unknown>>(row.metadata),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapEntitlement(row: Record<string, unknown>): Entitlement {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    subscriptionId: (row.subscription_id as string) ?? null,
    entitlementKey: row.entitlement_key as string,
    valueType: row.value_type as EntitlementValueType,
    enabled: parseBooleanColumn(row.enabled),
    limitValue: row.limit_value == null ? null : Number(row.limit_value),
    source: row.source as EntitlementSource,
    metadata: parseNullableJsonColumn<Record<string, unknown>>(row.metadata),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

// ── Helpers ────────────────────────────────────────────────

function safeError(message: string): BillingResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}


async function pagedList<T>(
  executor: SqlExecutor,
  sql: string,
  values: unknown[],
  limit: number,
  cursor: CursorPosition | null,
  mapper: (row: Record<string, unknown>) => T,
  cursorDateField = "created_at",
): Promise<BillingResult<PagedResult<T>>> {
  try {
    const fetchLimit = limit + 1;
    let fullSql: string;
    let fullValues: unknown[];
    const baseIdx = values.length;

    if (cursor) {
      fullSql = `${sql} AND (${cursorDateField}, id) < ($${baseIdx + 2}, $${baseIdx + 3}) ORDER BY ${cursorDateField} DESC, id DESC LIMIT $${baseIdx + 1}`;
      fullValues = [...values, fetchLimit, cursor.createdAt, cursor.id];
    } else {
      fullSql = `${sql} ORDER BY ${cursorDateField} DESC, id DESC LIMIT $${baseIdx + 1}`;
      fullValues = [...values, fetchLimit];
    }

    const result = await executor.execute<Record<string, unknown>>(fullSql, fullValues);
    const rows = result.rows.map(mapper);
    let nextCursor: CursorPosition | null = null;
    if (rows.length > limit) {
      rows.pop();
      const last = rows[rows.length - 1]!;
      nextCursor = {
        createdAt: (last as unknown as { createdAt: Date }).createdAt.toISOString(),
        id: (last as unknown as { id: string }).id,
      };
    }
    return { ok: true, value: { items: rows, nextCursor } };
  } catch {
    return safeError("Failed to list records");
  }
}

function jsonOrNull(v: Record<string, unknown> | null | undefined): string | null {
  return v == null ? null : JSON.stringify(v);
}

function isoOrNull(v: Date | null | undefined): string | null {
  return v == null ? null : v.toISOString();
}

// ── Repository factory ─────────────────────────────────────

export function createBillingRepository(executor: SqlExecutor): BillingRepository {
  return {
    // ── Plans ──────────────────────────────────────────────
    async createPlan(input: CreatePlanInput): Promise<BillingResult<Plan>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO billing_plans
             (id, code, name, description, status, billing_interval, price_amount_cents, price_currency, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (code) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.code,
            input.name,
            input.description ?? null,
            input.status ?? "active",
            input.billingInterval ?? "month",
            input.priceAmountCents ?? null,
            input.priceCurrency ?? "usd",
            jsonOrNull(input.metadata),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "plan" } };
        }
        return { ok: true, value: mapPlan(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "plan" } };
        }
        return safeError("Failed to create plan");
      }
    },

    async getPlan(id: string): Promise<BillingResult<Plan>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM billing_plans WHERE id = $1`,
          [id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapPlan(result.rows[0]!) };
      } catch {
        return safeError("Failed to get plan");
      }
    },

    async getPlanByCode(code: string): Promise<BillingResult<Plan>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM billing_plans WHERE code = $1`,
          [code],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapPlan(result.rows[0]!) };
      } catch {
        return safeError("Failed to get plan");
      }
    },

    async listPlans(query: ListPlansQuery = {}): Promise<BillingResult<Plan[]>> {
      try {
        const conditions: string[] = [];
        const values: unknown[] = [];
        if (query.status) {
          conditions.push(`status = $${values.length + 1}`);
          values.push(query.status);
        }
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM billing_plans ${where} ORDER BY code ASC`,
          values,
        );
        return { ok: true, value: result.rows.map(mapPlan) };
      } catch {
        return safeError("Failed to list plans");
      }
    },

    // ── Billing customers ──────────────────────────────────
    async upsertBillingCustomer(
      input: UpsertBillingCustomerInput,
    ): Promise<BillingResult<BillingCustomer>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO billing_billing_customers
             (id, org_id, display_name, email, status, provider, provider_customer_id, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (org_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             email = EXCLUDED.email,
             status = EXCLUDED.status,
             provider = EXCLUDED.provider,
             provider_customer_id = EXCLUDED.provider_customer_id,
             metadata = EXCLUDED.metadata,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.displayName ?? null,
            input.email ?? null,
            input.status ?? "active",
            input.provider ?? null,
            input.providerCustomerId ?? null,
            jsonOrNull(input.metadata),
          ],
        );
        return { ok: true, value: mapBillingCustomer(result.rows[0]!) };
      } catch {
        return safeError("Failed to upsert billing customer");
      }
    },

    async getBillingCustomer(orgId: string): Promise<BillingResult<BillingCustomer>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM billing_billing_customers WHERE org_id = $1`,
          [orgId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapBillingCustomer(result.rows[0]!) };
      } catch {
        return safeError("Failed to get billing customer");
      }
    },

    // ── Subscriptions ──────────────────────────────────────
    async createSubscription(
      input: CreateSubscriptionInput,
    ): Promise<BillingResult<Subscription>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO billing_subscriptions
             (id, org_id, billing_customer_id, plan_id, status,
              current_period_start, current_period_end, trial_end, cancel_at, canceled_at,
              provider, provider_subscription_id, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.billingCustomerId,
            input.planId,
            input.status ?? "active",
            isoOrNull(input.currentPeriodStart),
            isoOrNull(input.currentPeriodEnd),
            isoOrNull(input.trialEnd),
            isoOrNull(input.cancelAt),
            isoOrNull(input.canceledAt),
            input.provider ?? null,
            input.providerSubscriptionId ?? null,
            jsonOrNull(input.metadata),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "subscription" } };
        }
        return { ok: true, value: mapSubscription(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "subscription" } };
        }
        return safeError("Failed to create subscription");
      }
    },

    async getSubscription(
      orgId: string,
      id: string,
    ): Promise<BillingResult<Subscription>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM billing_subscriptions WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapSubscription(result.rows[0]!) };
      } catch {
        return safeError("Failed to get subscription");
      }
    },

    async getActiveSubscription(orgId: string): Promise<BillingResult<Subscription>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM billing_subscriptions
             WHERE org_id = $1 AND status IN ('trialing', 'active', 'past_due')
             ORDER BY created_at DESC
             LIMIT 1`,
          [orgId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapSubscription(result.rows[0]!) };
      } catch {
        return safeError("Failed to get active subscription");
      }
    },

    async listSubscriptions(
      orgId: string,
      params: PageQueryParams,
    ): Promise<BillingResult<PagedResult<Subscription>>> {
      return pagedList(
        executor,
        "SELECT * FROM billing_subscriptions WHERE org_id = $1",
        [orgId],
        params.limit,
        params.cursor,
        mapSubscription,
      );
    },

    async updateSubscription(
      orgId: string,
      id: string,
      input: UpdateSubscriptionInput,
    ): Promise<BillingResult<Subscription>> {
      try {
        const sets: string[] = [];
        const values: unknown[] = [orgId, id];
        let idx = 3;
        const push = (col: string, val: unknown) => {
          sets.push(`${col} = $${idx}`);
          values.push(val);
          idx++;
        };
        if (input.status !== undefined) push("status", input.status);
        if (input.currentPeriodStart !== undefined)
          push("current_period_start", isoOrNull(input.currentPeriodStart));
        if (input.currentPeriodEnd !== undefined)
          push("current_period_end", isoOrNull(input.currentPeriodEnd));
        if (input.trialEnd !== undefined) push("trial_end", isoOrNull(input.trialEnd));
        if (input.cancelAt !== undefined) push("cancel_at", isoOrNull(input.cancelAt));
        if (input.canceledAt !== undefined)
          push("canceled_at", isoOrNull(input.canceledAt));
        if (input.provider !== undefined) push("provider", input.provider);
        if (input.providerSubscriptionId !== undefined)
          push("provider_subscription_id", input.providerSubscriptionId);
        if (input.metadata !== undefined) push("metadata", jsonOrNull(input.metadata));

        if (sets.length === 0) {
          // Nothing to update — return current
          return this.getSubscription(orgId, id);
        }
        sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
        const sql = `UPDATE billing_subscriptions SET ${sets.join(", ")}
                     WHERE org_id = $1 AND id = $2 RETURNING *`;
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapSubscription(result.rows[0]!) };
      } catch {
        return safeError("Failed to update subscription");
      }
    },

    // ── Invoices ───────────────────────────────────────────
    async upsertInvoice(input: UpsertInvoiceInput): Promise<BillingResult<Invoice>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO billing_invoices
             (id, org_id, billing_customer_id, subscription_id, number, status,
              amount_due_cents, amount_paid_cents, currency,
              issued_at, due_at, paid_at, period_start, period_end,
              provider, provider_invoice_id, hosted_url, metadata,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             amount_due_cents = EXCLUDED.amount_due_cents,
             amount_paid_cents = EXCLUDED.amount_paid_cents,
             currency = EXCLUDED.currency,
             issued_at = EXCLUDED.issued_at,
             due_at = EXCLUDED.due_at,
             paid_at = EXCLUDED.paid_at,
             period_start = EXCLUDED.period_start,
             period_end = EXCLUDED.period_end,
             provider = EXCLUDED.provider,
             provider_invoice_id = EXCLUDED.provider_invoice_id,
             hosted_url = EXCLUDED.hosted_url,
             metadata = EXCLUDED.metadata,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE billing_invoices.org_id = EXCLUDED.org_id
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.billingCustomerId,
            input.subscriptionId ?? null,
            input.number ?? null,
            input.status ?? "draft",
            input.amountDueCents ?? 0,
            input.amountPaidCents ?? 0,
            input.currency ?? "usd",
            isoOrNull(input.issuedAt),
            isoOrNull(input.dueAt),
            isoOrNull(input.paidAt),
            isoOrNull(input.periodStart),
            isoOrNull(input.periodEnd),
            input.provider ?? null,
            input.providerInvoiceId ?? null,
            input.hostedUrl ?? null,
            jsonOrNull(input.metadata),
          ],
        );
        if (result.rowCount === 0) {
          // Cross-org id collision — refuse rather than leak
          return { ok: false, error: { kind: "conflict", entity: "invoice" } };
        }
        return { ok: true, value: mapInvoice(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "invoice" } };
        }
        return safeError("Failed to upsert invoice");
      }
    },

    async getInvoice(orgId: string, id: string): Promise<BillingResult<Invoice>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM billing_invoices WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapInvoice(result.rows[0]!) };
      } catch {
        return safeError("Failed to get invoice");
      }
    },

    async listInvoices(
      query: ListInvoicesQuery,
      params: PageQueryParams,
    ): Promise<BillingResult<PagedResult<Invoice>>> {
      const conditions: string[] = ["org_id = $1"];
      const values: unknown[] = [query.orgId];
      let idx = 2;
      if (query.billingCustomerId) {
        conditions.push(`billing_customer_id = $${idx}`);
        values.push(query.billingCustomerId);
        idx++;
      }
      if (query.subscriptionId) {
        conditions.push(`subscription_id = $${idx}`);
        values.push(query.subscriptionId);
        idx++;
      }
      if (query.status) {
        conditions.push(`status = $${idx}`);
        values.push(query.status);
        idx++;
      }
      const where = conditions.join(" AND ");
      return pagedList(
        executor,
        `SELECT * FROM billing_invoices WHERE ${where}`,
        values,
        params.limit,
        params.cursor,
        mapInvoice,
      );
    },

    // ── Entitlements ───────────────────────────────────────
    async upsertEntitlement(
      input: UpsertEntitlementInput,
    ): Promise<BillingResult<Entitlement>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO billing_entitlements
             (id, org_id, subscription_id, entitlement_key, value_type,
              enabled, limit_value, source, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (org_id, entitlement_key) DO UPDATE SET
             subscription_id = EXCLUDED.subscription_id,
             value_type = EXCLUDED.value_type,
             enabled = EXCLUDED.enabled,
             limit_value = EXCLUDED.limit_value,
             source = EXCLUDED.source,
             metadata = EXCLUDED.metadata,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.subscriptionId ?? null,
            input.entitlementKey,
            input.valueType,
            input.enabled ?? true,
            input.limitValue ?? null,
            input.source ?? "plan",
            jsonOrNull(input.metadata),
          ],
        );
        return { ok: true, value: mapEntitlement(result.rows[0]!) };
      } catch {
        return safeError("Failed to upsert entitlement");
      }
    },

    async getEntitlement(
      orgId: string,
      entitlementKey: string,
    ): Promise<BillingResult<Entitlement>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM billing_entitlements WHERE org_id = $1 AND entitlement_key = $2`,
          [orgId, entitlementKey],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapEntitlement(result.rows[0]!) };
      } catch {
        return safeError("Failed to get entitlement");
      }
    },

    async listEntitlements(
      query: ListEntitlementsQuery,
    ): Promise<BillingResult<Entitlement[]>> {
      try {
        const conditions: string[] = ["org_id = $1"];
        const values: unknown[] = [query.orgId];
        let idx = 2;
        if (query.subscriptionId) {
          conditions.push(`subscription_id = $${idx}`);
          values.push(query.subscriptionId);
          idx++;
        }
        if (query.source) {
          conditions.push(`source = $${idx}`);
          values.push(query.source);
          idx++;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM billing_entitlements WHERE ${conditions.join(" AND ")}
           ORDER BY entitlement_key ASC`,
          values,
        );
        return { ok: true, value: result.rows.map(mapEntitlement) };
      } catch {
        return safeError("Failed to list entitlements");
      }
    },

    // ── Billing summary ────────────────────────────────────
    async getBillingSummary(orgId: string): Promise<BillingResult<BillingSummary>> {
      // PERF3 (task 0132): collapse 4 sequential round-trips into 2 parallel
      // phases on the shared connection pool. Phase 1 (customer + active
      // subscription) then phase 2 (plan + entitlements) each run concurrently;
      // the plan read follows because it needs the resolved subscription. Query
      // order is preserved (customer, subscription, plan, entitlements).
      const [customerRes, subRes] = await Promise.all([
        this.getBillingCustomer(orgId),
        this.getActiveSubscription(orgId),
      ]);

      const customer = customerRes.ok ? customerRes.value : null;
      if (!customerRes.ok && customerRes.error.kind === "internal") {
        return safeError(customerRes.error.message);
      }

      const activeSubscription = subRes.ok ? subRes.value : null;
      if (!subRes.ok && subRes.error.kind === "internal") {
        return safeError(subRes.error.message);
      }

      const [planRes, entRes] = await Promise.all([
        activeSubscription ? this.getPlan(activeSubscription.planId) : Promise.resolve(null),
        this.listEntitlements({ orgId }),
      ]);

      let plan: Plan | null = null;
      if (planRes) {
        if (planRes.ok) plan = planRes.value;
        else if (planRes.error.kind === "internal") return safeError(planRes.error.message);
      }

      if (!entRes.ok) {
        const msg = entRes.error.kind === "internal" ? entRes.error.message : "Failed to load entitlements";
        return safeError(msg);
      }

      return {
        ok: true,
        value: {
          customer,
          activeSubscription,
          plan,
          entitlements: entRes.value,
        },
      };
    },
  };
}
