/**
 * Provider-neutral billing-provider adapter seam.
 *
 * Epic: saas-multi-org-billing / sub-epic billing-provider-abstraction (BP0).
 *
 * One interface every payment provider implements; the active provider is
 * selected per-environment by config (`BILLING_PROVIDER`, default "polar").
 * Polar (BP1) is the first implementation; Stripe (BP3) proves the seam is real
 * (switch by config, not rewrite).
 *
 * Invariants honored by every adapter:
 *  - Entitlement DECISIONS are never read live from a provider — providers
 *    mutate our billing state via webhooks; product gates read
 *    `billing_entitlements`. This seam is for purchase/manage/sync only.
 *  - No provider SDK types, secrets, raw payloads, or tokenized URLs cross this
 *    seam into `@saas/contracts`, the DB, `metadata`, or logs. Only the
 *    normalized, safe shapes below leave an adapter.
 */

export type BillingProviderId = "polar" | "stripe";

/** A normalized, provider-neutral customer reference. Never a secret. */
export interface ProviderCustomerRef {
  /** Opaque provider customer id. */
  providerCustomerId: string;
  /** The external id we set on the provider (our billing-parent org id). */
  externalId: string | null;
}

export interface CreateCheckoutInput {
  /** Public org id of the billing parent (becomes the provider customerExternalId). */
  orgId: string;
  /** Stable plan code being purchased. */
  planCode: string;
  /** Opaque provider product id, resolved from the per-env plan↔product map. */
  productId: string;
  /** Where the provider returns the buyer after a successful checkout. */
  successUrl: string;
  /**
   * Origin of the page embedding the checkout (e.g. the console's
   * `window.location.origin`). When set, the provider allows its hosted checkout
   * to be loaded in an iframe from that origin — enabling an in-app embedded
   * checkout instead of a full-page redirect. Validated by the caller.
   */
  embedOrigin?: string;
}

export interface CreateCheckoutResult {
  /** Hosted checkout URL the console redirects to. Safe display URL only. */
  checkoutUrl: string;
}

export interface CreatePortalSessionInput {
  /** Public org id of the billing parent. */
  orgId: string;
  /** Known provider customer id when already mirrored; else resolve by externalId. */
  providerCustomerId?: string | null;
  /** Optional return URL back into the console. */
  returnUrl?: string;
}

export interface CreatePortalSessionResult {
  /** Hosted customer-portal URL. Safe display URL only. */
  portalUrl: string;
}

export interface CancelSubscriptionInput {
  /** Public org id of the billing parent (the provider external customer id). */
  orgId: string;
  /** Opaque provider subscription id to cancel (resolved from our mirror). */
  providerSubscriptionId: string;
}

export interface CancelSubscriptionResult {
  /**
   * True when the provider scheduled the cancellation (vs. immediate). The
   * authoritative state change still arrives via webhook; this is just the
   * acknowledged intent so the console can show optimistic copy.
   */
  cancelAtPeriodEnd: boolean;
}

export interface ChangeSubscriptionPlanInput {
  /** Public org id of the billing parent (the provider external customer id). */
  orgId: string;
  /** Opaque provider subscription id to change (resolved from our mirror). */
  providerSubscriptionId: string;
  /** Opaque provider product id of the target plan. */
  productId: string;
}

export interface ChangeSubscriptionPlanResult {
  /** True once the provider accepted the plan change (proration handled provider-side). */
  changed: boolean;
}

/** The org's current active provider subscription, for reconciliation/backfill. */
export interface ProviderActiveSubscription {
  providerSubscriptionId: string;
  providerCustomerId: string | null;
  /** Opaque provider product id → resolved to a plan code by the caller. */
  productId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

/** A normalized, safe-to-display saved card. Never carries full PAN or secrets. */
export interface ProviderPaymentMethod {
  /** Opaque provider payment-method id. */
  id: string;
  /** Card brand, e.g. "visa". */
  brand: string;
  /** Last 4 digits only (safe to display). */
  last4: string;
  expMonth: number;
  expYear: number;
}

/** Provider-specific subset of webhook headers needed for signature verification. */
export type ProviderWebhookHeaders = Record<string, string>;

// ── Normalized events ────────────────────────────────────────
// The small internal union every provider's `verifyWebhook` maps onto. These
// map 1:1 onto the events billing-worker already emits + the assign-plan path,
// so webhook intake stays provider-agnostic.

interface NormalizedEventBase {
  /** Opaque provider event id, used for idempotent intake (dedupe). */
  providerEventId: string;
  provider: BillingProviderId;
}

export interface NormalizedSubscriptionEvent extends NormalizedEventBase {
  type:
    | "subscription.activated"
    | "subscription.updated"
    | "subscription.canceled";
  /** Our billing-parent org id (from customerExternalId / metadata). */
  orgId: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  /** Opaque provider product id → resolved to a plan code by the mapper. */
  productId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

export interface NormalizedInvoiceEvent extends NormalizedEventBase {
  type: "invoice.recorded" | "invoice.paid";
  orgId: string | null;
  providerCustomerId: string | null;
  providerInvoiceId: string | null;
  providerSubscriptionId: string | null;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  /** Safe display URL only; never embeds bearer tokens or session secrets. */
  hostedUrl: string | null;
}

export interface NormalizedPaymentFailedEvent extends NormalizedEventBase {
  type: "payment.failed";
  orgId: string | null;
  providerCustomerId: string | null;
  providerInvoiceId: string | null;
}

/** Events we do not act on yet are normalized to `ignored` (still verified). */
export interface NormalizedIgnoredEvent extends NormalizedEventBase {
  type: "ignored";
  /** The raw provider event type, for observability only (no payload). */
  providerType: string;
}

export type NormalizedEvent =
  | NormalizedSubscriptionEvent
  | NormalizedInvoiceEvent
  | NormalizedPaymentFailedEvent
  | NormalizedIgnoredEvent;

/** Result of verifying + normalizing a raw provider webhook. */
export type VerifyWebhookResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; reason: "invalid_signature" | "malformed" };

// ── The adapter interface ────────────────────────────────────

export interface BillingProvider {
  readonly id: BillingProviderId;
  /** Create a hosted checkout session for a purchase. */
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /** Create a hosted customer-portal session to manage an existing subscription. */
  createPortalSession(
    input: CreatePortalSessionInput,
  ): Promise<CreatePortalSessionResult>;
  /** Look up the provider customer mirrored to our org id, or null. */
  getCustomerByExternalId(externalId: string): Promise<ProviderCustomerRef | null>;
  /**
   * Whether the org's provider customer already has an active subscription.
   * Determines whether an "upgrade" is a first checkout or a portal-managed plan
   * change — most providers (incl. Polar) reject a second subscription created
   * via checkout, so paid→paid changes go through the customer portal.
   */
  hasActiveSubscription(externalId: string): Promise<boolean>;
  /**
   * Fetch the org's current active provider subscription (for reconciliation —
   * backfilling our row when a webhook was missed/dropped), or null. Read with
   * the org token; safe fields only.
   */
  getActiveSubscription(externalId: string): Promise<ProviderActiveSubscription | null>;
  /**
   * Cancel the org's subscription (provider decides immediate vs. period-end).
   * The authoritative downgrade still flows through the webhook; this only asks
   * the provider to cancel. Done natively so the console need not redirect to the
   * hosted portal for cancellation.
   */
  cancelSubscription(input: CancelSubscriptionInput): Promise<CancelSubscriptionResult>;
  /**
   * Change the org's subscription to a different product (plan). Proration is
   * handled provider-side; the authoritative re-materialization arrives via the
   * webhook. Done natively so plan changes need no hosted-portal redirect.
   */
  changeSubscriptionPlan(
    input: ChangeSubscriptionPlanInput,
  ): Promise<ChangeSubscriptionPlanResult>;
  /**
   * List the org's saved cards (safe display fields only). Read server-side with
   * the org token so no provider session/token reaches the console. Used to show
   * the card on file next to the (PCI-gated) "Update payment method" deep-link.
   */
  listPaymentMethods(externalId: string): Promise<ProviderPaymentMethod[]>;
  /**
   * Verify a webhook signature over the RAW body bytes and normalize it.
   * Implementations MUST fail closed (`invalid_signature`) on any verification
   * failure — never trust an unverified payload.
   */
  verifyWebhook(
    rawBody: string,
    headers: ProviderWebhookHeaders,
  ): Promise<VerifyWebhookResult>;
}
