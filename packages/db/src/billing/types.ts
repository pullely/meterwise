export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";

// ── Result type ─────────────────────────────────────────────

export type BillingRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type BillingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BillingRepositoryError };

// ── Cursor pagination ───────────────────────────────────────

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

// ── Plans ───────────────────────────────────────────────────

export type PlanStatus = "active" | "archived";
export type BillingInterval = "month" | "year" | "none";

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: PlanStatus;
  billingInterval: BillingInterval;
  priceAmountCents: number | null;
  priceCurrency: string;
  /** Bounded safe metadata only — no secrets, tokens, or credentials. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePlanInput {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  status?: PlanStatus;
  billingInterval?: BillingInterval;
  priceAmountCents?: number | null;
  priceCurrency?: string;
  metadata?: Record<string, unknown> | null;
}

export interface ListPlansQuery {
  status?: PlanStatus;
}

// ── Billing customers ───────────────────────────────────────

export type BillingCustomerStatus = "active" | "inactive";

export interface BillingCustomer {
  id: string;
  orgId: string;
  displayName: string | null;
  email: string | null;
  status: BillingCustomerStatus;
  /** Opaque adapter id (e.g. 'stripe'). */
  provider: string | null;
  /** Opaque external customer reference. Never a secret/API key. */
  providerCustomerId: string | null;
  /** Bounded safe metadata only — no secrets, tokens, or credentials. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertBillingCustomerInput {
  id: string;
  orgId: string;
  displayName?: string | null;
  email?: string | null;
  status?: BillingCustomerStatus;
  provider?: string | null;
  providerCustomerId?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ── Subscriptions ───────────────────────────────────────────

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "expired";

export interface Subscription {
  id: string;
  orgId: string;
  billingCustomerId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAt: Date | null;
  canceledAt: Date | null;
  provider: string | null;
  providerSubscriptionId: string | null;
  /** Bounded safe metadata only — no secrets, tokens, or credentials. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSubscriptionInput {
  id: string;
  orgId: string;
  billingCustomerId: string;
  planId: string;
  status?: SubscriptionStatus;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  trialEnd?: Date | null;
  cancelAt?: Date | null;
  canceledAt?: Date | null;
  provider?: string | null;
  providerSubscriptionId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateSubscriptionInput {
  status?: SubscriptionStatus;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  trialEnd?: Date | null;
  cancelAt?: Date | null;
  canceledAt?: Date | null;
  /** Opaque payment-provider id (e.g. 'polar'); set when linking a provider sub. */
  provider?: string | null;
  /** Opaque provider subscription id; set/backfilled from verified webhooks. */
  providerSubscriptionId?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ── Invoices ────────────────────────────────────────────────

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

export interface Invoice {
  id: string;
  orgId: string;
  billingCustomerId: string;
  subscriptionId: string | null;
  number: string | null;
  status: InvoiceStatus;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  provider: string | null;
  providerInvoiceId: string | null;
  /** Safe display URL only; callers must never embed bearer tokens or session secrets. */
  hostedUrl: string | null;
  /** Bounded safe metadata only — no secrets, tokens, credentials, or raw provider payloads. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertInvoiceInput {
  id: string;
  orgId: string;
  billingCustomerId: string;
  subscriptionId?: string | null;
  number?: string | null;
  status?: InvoiceStatus;
  amountDueCents?: number;
  amountPaidCents?: number;
  currency?: string;
  issuedAt?: Date | null;
  dueAt?: Date | null;
  paidAt?: Date | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  provider?: string | null;
  providerInvoiceId?: string | null;
  hostedUrl?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListInvoicesQuery {
  orgId: string;
  billingCustomerId?: string;
  subscriptionId?: string;
  status?: InvoiceStatus;
}

// ── Entitlements ────────────────────────────────────────────

export type EntitlementValueType = "boolean" | "quantity" | "feature";
export type EntitlementSource = "plan" | "override";

export interface Entitlement {
  id: string;
  orgId: string;
  subscriptionId: string | null;
  entitlementKey: string;
  valueType: EntitlementValueType;
  enabled: boolean;
  /** NULL means unlimited (when enabled). */
  limitValue: number | null;
  source: EntitlementSource;
  /** Bounded safe metadata only — no secrets, tokens, or credentials. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertEntitlementInput {
  id: string;
  orgId: string;
  subscriptionId?: string | null;
  entitlementKey: string;
  valueType: EntitlementValueType;
  enabled?: boolean;
  limitValue?: number | null;
  source?: EntitlementSource;
  metadata?: Record<string, unknown> | null;
}

export interface ListEntitlementsQuery {
  orgId: string;
  subscriptionId?: string;
  source?: EntitlementSource;
}

// ── Billing summary ─────────────────────────────────────────

export interface BillingSummary {
  customer: BillingCustomer | null;
  activeSubscription: Subscription | null;
  plan: Plan | null;
  entitlements: Entitlement[];
}

// ── Repository interface ────────────────────────────────────

export interface BillingRepository {
  // Plans
  createPlan(input: CreatePlanInput): Promise<BillingResult<Plan>>;
  getPlan(id: string): Promise<BillingResult<Plan>>;
  getPlanByCode(code: string): Promise<BillingResult<Plan>>;
  listPlans(query?: ListPlansQuery): Promise<BillingResult<Plan[]>>;

  // Billing customers
  upsertBillingCustomer(
    input: UpsertBillingCustomerInput,
  ): Promise<BillingResult<BillingCustomer>>;
  getBillingCustomer(orgId: string): Promise<BillingResult<BillingCustomer>>;

  // Subscriptions
  createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<BillingResult<Subscription>>;
  getSubscription(
    orgId: string,
    id: string,
  ): Promise<BillingResult<Subscription>>;
  getActiveSubscription(orgId: string): Promise<BillingResult<Subscription>>;
  listSubscriptions(
    orgId: string,
    params: PageQueryParams,
  ): Promise<BillingResult<PagedResult<Subscription>>>;
  updateSubscription(
    orgId: string,
    id: string,
    input: UpdateSubscriptionInput,
  ): Promise<BillingResult<Subscription>>;

  // Invoices
  upsertInvoice(input: UpsertInvoiceInput): Promise<BillingResult<Invoice>>;
  getInvoice(orgId: string, id: string): Promise<BillingResult<Invoice>>;
  listInvoices(
    query: ListInvoicesQuery,
    params: PageQueryParams,
  ): Promise<BillingResult<PagedResult<Invoice>>>;

  // Entitlements
  upsertEntitlement(
    input: UpsertEntitlementInput,
  ): Promise<BillingResult<Entitlement>>;
  getEntitlement(
    orgId: string,
    entitlementKey: string,
  ): Promise<BillingResult<Entitlement>>;
  listEntitlements(
    query: ListEntitlementsQuery,
  ): Promise<BillingResult<Entitlement[]>>;

  // Billing summary
  getBillingSummary(orgId: string): Promise<BillingResult<BillingSummary>>;
}
