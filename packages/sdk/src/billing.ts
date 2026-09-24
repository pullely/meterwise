import type {
  CancelSubscriptionResponse,
  ChangePlanRequest,
  ChangePlanResponse,
  CheckBillingEntitlementRequest,
  CheckBillingEntitlementResponse,
  CreateCheckoutRequest,
  CreateCheckoutResponse,
  CreatePortalSessionResponse,
  GetBillingCustomerResponse,
  GetBillingSummaryResponse,
  GetEntitlementsRequest,
  GetEntitlementsResponse,
  ListInvoicesRequest,
  ListInvoicesResponse,
  ListPaymentMethodsResponse,
  ListPlansRequest,
  ListPlansResponse,
  ReconcileResponse,
} from "@saas/contracts/billing";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Billing resource client.
 *
 * Org-scoped surface served by `apps/billing-worker` via the api-edge
 * `billing-facade`. Reads (plans/customer/summary/invoices/entitlements) plus
 * two provider hand-off writes: `createCheckout` and `createPortalSession`
 * return hosted, safe-to-display URLs — the actual plan change is applied by
 * the verified provider webhook, never by the client.
 *
 * `checkEntitlement` targets the entitlement decision seam (POST against the
 * org-scoped entitlements path), letting callers gate product behaviour on a
 * stable entitlement key without reading billing tables directly.
 */
export class BillingClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/billing/plans */
  listPlans(
    orgId: string,
    query: ListPlansRequest = {},
    opts: RequestOptions = {},
  ): Promise<ListPlansResponse> {
    const params = buildQueryRecord({ status: query.status });
    return this.transport.request<ListPlansResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/plans`,
        query: params,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/billing/customer */
  getCustomer(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<GetBillingCustomerResponse> {
    return this.transport.request<GetBillingCustomerResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/customer`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/billing/summary */
  getSummary(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<GetBillingSummaryResponse> {
    return this.transport.request<GetBillingSummaryResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/summary`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/billing/invoices */
  listInvoices(
    orgId: string,
    query: ListInvoicesRequest = {},
    opts: RequestOptions = {},
  ): Promise<ListInvoicesResponse> {
    const params = buildQueryRecord({
      subscriptionId: query.subscriptionId,
      status: query.status,
      limit: query.limit,
      cursor: query.cursor ? JSON.stringify(query.cursor) : undefined,
    });
    return this.transport.request<ListInvoicesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/invoices`,
        query: params,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/billing/entitlements */
  getEntitlements(
    orgId: string,
    query: GetEntitlementsRequest = {},
    opts: RequestOptions = {},
  ): Promise<GetEntitlementsResponse> {
    const params = buildQueryRecord({
      subscriptionId: query.subscriptionId,
      source: query.source,
    });
    return this.transport.request<GetEntitlementsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/entitlements`,
        query: params,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/billing/entitlements/check
   *
   * Entitlement decision seam. The `orgId` argument is the URL scope; the
   * `entitlementKey` travels in the body. Missing entitlements surface as a
   * `denied` decision (not a 5xx) so callers can fail closed deterministically.
   */
  checkEntitlement(
    orgId: string,
    body: Pick<CheckBillingEntitlementRequest, "entitlementKey">,
    opts: RequestOptions = {},
  ): Promise<CheckBillingEntitlementResponse> {
    return this.transport.request<CheckBillingEntitlementResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/entitlements/check`,
        body,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/billing/checkout
   *
   * Start a hosted checkout to purchase/upgrade a plan. Returns a checkout URL
   * to redirect the buyer to; the plan is applied by the provider webhook after
   * payment, not by this call.
   */
  createCheckout(
    orgId: string,
    body: CreateCheckoutRequest,
    opts: RequestOptions = {},
  ): Promise<CreateCheckoutResponse> {
    return this.transport.request<CreateCheckoutResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/checkout`,
        body,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/billing/portal
   *
   * Create a hosted customer-portal session for managing the subscription /
   * payment method. Returns a portal URL to redirect to.
   */
  createPortalSession(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<CreatePortalSessionResponse> {
    return this.transport.request<CreatePortalSessionResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/portal`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/billing/subscription/cancel
   *
   * Cancel the account's paid subscription natively (no hosted-portal redirect).
   * The downgrade is applied by the provider webhook after this returns.
   */
  cancelSubscription(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<CancelSubscriptionResponse> {
    return this.transport.request<CancelSubscriptionResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/subscription/cancel`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/billing/reconcile
   *
   * Self-heal billing state from the provider (backfill a missed webhook).
   * `{ reconciled: false }` is a normal outcome (e.g. no provider subscription).
   */
  reconcile(orgId: string, opts: RequestOptions = {}): Promise<ReconcileResponse> {
    return this.transport.request<ReconcileResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/reconcile`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/billing/payment-methods */
  listPaymentMethods(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<ListPaymentMethodsResponse> {
    return this.transport.request<ListPaymentMethodsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/payment-methods`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/billing/subscription/change
   *
   * Change an existing paid subscription to another plan natively (no redirect).
   * First purchases go through `createCheckout`, not this method.
   */
  changePlan(
    orgId: string,
    body: ChangePlanRequest,
    opts: RequestOptions = {},
  ): Promise<ChangePlanResponse> {
    return this.transport.request<ChangePlanResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/billing/subscription/change`,
        body,
      },
      opts,
    );
  }
}

function buildQueryRecord(
  input: Record<string, string | number | null | undefined>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}
