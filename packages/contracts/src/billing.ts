/**
 * Billing contract types.
 *
 * These types define the public/shared shapes for plan, billing customer,
 * subscription, invoice, and entitlement APIs. They are provider-neutral —
 * payment-provider ids may appear only as opaque references and never carry
 * API keys, webhook signing secrets, raw provider payloads, checkout/portal
 * session secrets, or plaintext secret material.
 *
 * Billing consumes normalized metering outputs (rollups). It does not own
 * raw usage facts; usage shapes live in '@saas/contracts/metering'.
 */

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export type PublicPlanStatus = "active" | "archived";
export type PublicBillingInterval = "month" | "year" | "none";

export interface PublicPlan {
  id: string;
  /** Stable machine code (e.g. 'starter', 'pro'). */
  code: string;
  name: string;
  description: string | null;
  status: PublicPlanStatus;
  billingInterval: PublicBillingInterval;
  /** Nominal display price in minor units; null when interval is 'none' or unpriced. */
  priceAmountCents: number | null;
  /** ISO-4217 lowercase currency code. */
  priceCurrency: string;
  /** Bounded safe metadata — no secrets, tokens, or credentials. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListPlansRequest {
  status?: PublicPlanStatus;
}

export interface ListPlansResponse {
  plans: PublicPlan[];
}

// ---------------------------------------------------------------------------
// Billing customers
// ---------------------------------------------------------------------------

export type PublicBillingCustomerStatus = "active" | "inactive";

export interface PublicBillingCustomer {
  id: string;
  orgId: string;
  displayName: string | null;
  email: string | null;
  status: PublicBillingCustomerStatus;
  /** Opaque adapter id (e.g. 'stripe'). Never an API key. */
  provider: string | null;
  /** Opaque external customer reference. Never a secret. */
  providerCustomerId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface GetBillingCustomerResponse {
  customer: PublicBillingCustomer;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type PublicSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "expired";

export interface PublicSubscription {
  id: string;
  orgId: string;
  billingCustomerId: string;
  planId: string;
  status: PublicSubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAt: string | null;
  canceledAt: string | null;
  provider: string | null;
  providerSubscriptionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export type PublicInvoiceStatus =
  | "draft"
  | "open"
  | "paid"
  | "void"
  | "uncollectible";

export interface PublicInvoice {
  id: string;
  orgId: string;
  billingCustomerId: string;
  subscriptionId: string | null;
  number: string | null;
  status: PublicInvoiceStatus;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  provider: string | null;
  providerInvoiceId: string | null;
  /**
   * Safe display URL only. Must not embed bearer tokens, session secrets,
   * or credential material in query string or fragment.
   */
  hostedUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListInvoicesRequest {
  subscriptionId?: string;
  status?: PublicInvoiceStatus;
  limit?: number;
  cursor?: { createdAt: string; id: string } | null;
}

export interface ListInvoicesResponse {
  invoices: PublicInvoice[];
  nextCursor: { createdAt: string; id: string } | null;
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export type PublicEntitlementValueType = "boolean" | "quantity" | "feature";
export type PublicEntitlementSource = "plan" | "override";

export interface PublicEntitlement {
  id: string;
  orgId: string;
  subscriptionId: string | null;
  entitlementKey: string;
  valueType: PublicEntitlementValueType;
  enabled: boolean;
  /** NULL means unlimited (when enabled). */
  limitValue: number | null;
  source: PublicEntitlementSource;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface GetEntitlementsRequest {
  subscriptionId?: string;
  source?: PublicEntitlementSource;
}

export interface GetEntitlementsResponse {
  entitlements: PublicEntitlement[];
}

// ---------------------------------------------------------------------------
// Entitlement decision (internal seam)
// ---------------------------------------------------------------------------

/**
 * Request shape for the private billing entitlement decision seam consumed by
 * other bounded contexts (over a service binding) that need to gate
 * product behavior on a named entitlement without reading billing tables
 * directly.
 *
 * Provider-neutral: callers pass the organization id and a stable entitlement
 * key only. No provider ids, secrets, or billing internals are required.
 */
export interface CheckBillingEntitlementRequest {
  /** Public organization identifier (e.g. 'org_<32-hex>'). */
  orgId: string;
  /** Stable machine entitlement key (e.g. 'feature.custom_domains'). */
  entitlementKey: string;
}

/**
 * Reason an entitlement decision is denied. Kept narrow and provider-neutral.
 *
 * - 'disabled': the entitlement is configured for the org but explicitly off.
 * - 'not_configured': no entitlement record exists for this (org, key).
 */
export type BillingEntitlementDeniedReason = "disabled" | "not_configured";

/**
 * Successful, allowed entitlement decision. Carries only non-secret, safe
 * billing facts that already appear in PublicEntitlement.
 */
export interface BillingEntitlementAllowedDecision {
  allowed: true;
  orgId: string;
  entitlementKey: string;
  /** Mirrors PublicEntitlement.valueType. */
  valueType: PublicEntitlementValueType;
  /** NULL means unlimited (when allowed). */
  limitValue: number | null;
  /** Where this decision came from. */
  source: PublicEntitlementSource;
  /** Opaque public subscription reference if scoped to one, otherwise null. */
  subscriptionId: string | null;
}

/**
 * Denied entitlement decision. Same response envelope as allowed but carries a
 * narrow reason. Missing entitlements MUST surface here (not as 5xx) so callers
 * fail closed deterministically.
 */
export interface BillingEntitlementDeniedDecision {
  allowed: false;
  orgId: string;
  entitlementKey: string;
  reason: BillingEntitlementDeniedReason;
}

export type CheckBillingEntitlementResponse =
  | BillingEntitlementAllowedDecision
  | BillingEntitlementDeniedDecision;

// ---------------------------------------------------------------------------
// Billing summary
// ---------------------------------------------------------------------------

export interface GetBillingSummaryResponse {
  customer: PublicBillingCustomer | null;
  activeSubscription: PublicSubscription | null;
  plan: PublicPlan | null;
  entitlements: PublicEntitlement[];
}

// ---------------------------------------------------------------------------
// Checkout & customer portal (provider hand-off)
// ---------------------------------------------------------------------------

/**
 * Initiate a hosted checkout to purchase/upgrade a plan. Provider-neutral: the
 * caller names a plan code and the billing-worker resolves it to the active
 * provider's product, returning a hosted, safe-to-display checkout URL. Only
 * purchasable plans (those with a configured provider product) are accepted.
 */
export interface CreateCheckoutRequest {
  /** Stable plan code to purchase (e.g. 'pro', 'business'). */
  planCode: string;
  /**
   * Origin of the page that will embed the checkout (the console's
   * `window.location.origin`). When present and valid, the returned checkout can
   * be loaded as an in-app embedded overlay instead of a full-page redirect to
   * the provider. Server-validated; ignored if malformed.
   */
  embedOrigin?: string;
  /**
   * Root-relative console path (e.g. `/orgs/acme/settings/billing?checkout=complete`)
   * to return the buyer to after a hosted (non-embedded) checkout. Combined with
   * `embedOrigin` server-side into a same-origin success URL so the fallback path
   * still lands back in the console. Server-validated; ignored if malformed.
   */
  returnPath?: string;
}

export interface CreateCheckoutResponse {
  /** Hosted URL to redirect the buyer to. Safe display URL only — no secrets. */
  checkoutUrl: string;
  /**
   * Whether the URL is a fresh `checkout` (first purchase) or the customer
   * `portal` (plan change for an org that already has an active subscription —
   * providers manage paid→paid changes there). The client redirects to
   * `checkoutUrl` regardless; `mode` lets it tailor its copy.
   */
  mode?: "checkout" | "portal";
}

/**
 * Create a hosted customer-portal session for managing the existing
 * subscription/payment method. No body — the org scope is the URL.
 */
export interface CreatePortalSessionResponse {
  /** Hosted customer-portal URL. Safe display URL only — no secrets. */
  portalUrl: string;
}

/**
 * Cancel the account's paid subscription natively (no hosted-portal redirect).
 * No body — the org scope is the URL. The authoritative downgrade still arrives
 * via the provider webhook; the response is just the acknowledged intent.
 */
export interface CancelSubscriptionResponse {
  /** True when the provider scheduled cancellation at period end (vs. immediate). */
  cancelAtPeriodEnd: boolean;
}

/**
 * Change an existing paid subscription to another plan natively (no hosted-portal
 * redirect). The re-materialization arrives via the webhook; the response is the
 * acknowledged intent. First purchases go through checkout, not this endpoint.
 */
export interface ChangePlanRequest {
  /** Target plan code (must be a known, purchasable plan). */
  planCode: string;
}

export interface ChangePlanResponse {
  /** True once the provider accepted the plan change (proration handled provider-side). */
  changed: boolean;
}

/**
 * Reconcile our billing state from the provider (self-heal a missed/dropped
 * webhook). `reconciled: false` (with a reason) is a normal outcome, not an
 * error — e.g. there's no provider subscription to link.
 */
export interface ReconcileResponse {
  reconciled: boolean;
  planCode?: string;
  reason?: string;
}

/** A saved card, safe-to-display fields only (never a full PAN or secret). */
export interface PublicPaymentMethod {
  id: string;
  /** Card brand, e.g. "visa". */
  brand: string;
  /** Last 4 digits only. */
  last4: string;
  expMonth: number;
  expYear: number;
}

/**
 * Saved cards on file for the account, shown next to the (PCI-gated) "Update
 * payment method" deep-link. Display-only; empty when none / provider blip.
 */
export interface ListPaymentMethodsResponse {
  paymentMethods: PublicPaymentMethod[];
}
