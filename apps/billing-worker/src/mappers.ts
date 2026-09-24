import type {
  PublicBillingCustomer,
  PublicEntitlement,
  PublicInvoice,
  PublicPlan,
  PublicSubscription,
} from "@saas/contracts/billing";
import type {
  BillingCustomer,
  Entitlement,
  Invoice,
  Plan,
  Subscription,
} from "@saas/db/billing";

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function mapPlanToPublic(p: Plan): PublicPlan {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    status: p.status,
    billingInterval: p.billingInterval,
    priceAmountCents: p.priceAmountCents,
    priceCurrency: p.priceCurrency,
    metadata: p.metadata,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function mapBillingCustomerToPublic(c: BillingCustomer): PublicBillingCustomer {
  return {
    id: c.id,
    orgId: c.orgId,
    displayName: c.displayName,
    email: c.email,
    status: c.status,
    provider: c.provider,
    providerCustomerId: c.providerCustomerId,
    metadata: c.metadata,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function mapSubscriptionToPublic(s: Subscription): PublicSubscription {
  return {
    id: s.id,
    orgId: s.orgId,
    billingCustomerId: s.billingCustomerId,
    planId: s.planId,
    status: s.status,
    currentPeriodStart: iso(s.currentPeriodStart),
    currentPeriodEnd: iso(s.currentPeriodEnd),
    trialEnd: iso(s.trialEnd),
    cancelAt: iso(s.cancelAt),
    canceledAt: iso(s.canceledAt),
    provider: s.provider,
    providerSubscriptionId: s.providerSubscriptionId,
    metadata: s.metadata,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function mapInvoiceToPublic(i: Invoice): PublicInvoice {
  return {
    id: i.id,
    orgId: i.orgId,
    billingCustomerId: i.billingCustomerId,
    subscriptionId: i.subscriptionId,
    number: i.number,
    status: i.status,
    amountDueCents: i.amountDueCents,
    amountPaidCents: i.amountPaidCents,
    currency: i.currency,
    issuedAt: iso(i.issuedAt),
    dueAt: iso(i.dueAt),
    paidAt: iso(i.paidAt),
    periodStart: iso(i.periodStart),
    periodEnd: iso(i.periodEnd),
    provider: i.provider,
    providerInvoiceId: i.providerInvoiceId,
    hostedUrl: i.hostedUrl,
    metadata: i.metadata,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

export function mapEntitlementToPublic(e: Entitlement): PublicEntitlement {
  return {
    id: e.id,
    orgId: e.orgId,
    subscriptionId: e.subscriptionId,
    entitlementKey: e.entitlementKey,
    valueType: e.valueType,
    enabled: e.enabled,
    limitValue: e.limitValue,
    source: e.source,
    metadata: e.metadata,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}
