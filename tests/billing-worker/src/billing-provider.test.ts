import {
  resolveProviderId,
  createBillingProviderRegistry,
  DEFAULT_BILLING_PROVIDER,
} from "@billing-worker/billing-provider/registry";
import type {
  BillingProvider,
  CreateCheckoutResult,
  CreatePortalSessionResult,
  ProviderCustomerRef,
  VerifyWebhookResult,
} from "@billing-worker/billing-provider/types";

/** Minimal fake adapter for registry tests — no network, no provider SDK. */
function fakeProvider(id: BillingProvider["id"]): BillingProvider {
  return {
    id,
    async createCheckout(): Promise<CreateCheckoutResult> {
      return { checkoutUrl: "https://example.test/checkout" };
    },
    async createPortalSession(): Promise<CreatePortalSessionResult> {
      return { portalUrl: "https://example.test/portal" };
    },
    async getCustomerByExternalId(): Promise<ProviderCustomerRef | null> {
      return null;
    },
    async hasActiveSubscription(): Promise<boolean> {
      return false;
    },
    async cancelSubscription(): Promise<{ cancelAtPeriodEnd: boolean }> {
      return { cancelAtPeriodEnd: true };
    },
    async changeSubscriptionPlan(): Promise<{ changed: boolean }> {
      return { changed: true };
    },
    async getActiveSubscription() {
      return null;
    },
    async listPaymentMethods() {
      return [];
    },
    async verifyWebhook(): Promise<VerifyWebhookResult> {
      return { ok: false, reason: "invalid_signature" };
    },
  };
}

describe("resolveProviderId", () => {
  it("defaults to polar when unset", () => {
    expect(resolveProviderId({})).toBe(DEFAULT_BILLING_PROVIDER);
    expect(DEFAULT_BILLING_PROVIDER).toBe("polar");
  });

  it("defaults to polar when blank/whitespace", () => {
    expect(resolveProviderId({ BILLING_PROVIDER: "   " })).toBe("polar");
  });

  it("returns the configured known provider", () => {
    expect(resolveProviderId({ BILLING_PROVIDER: "stripe" })).toBe("stripe");
    expect(resolveProviderId({ BILLING_PROVIDER: "polar" })).toBe("polar");
  });

  it("returns null for an unknown provider id", () => {
    expect(resolveProviderId({ BILLING_PROVIDER: "paypal" })).toBeNull();
  });
});

describe("createBillingProviderRegistry", () => {
  it("get() returns the registered adapter or null", () => {
    const polar = fakeProvider("polar");
    const reg = createBillingProviderRegistry({ polar });
    expect(reg.get("polar")).toBe(polar);
    expect(reg.get("stripe")).toBeNull();
  });

  it("resolve() returns the env-selected adapter when registered", () => {
    const polar = fakeProvider("polar");
    const reg = createBillingProviderRegistry({ polar });
    const res = reg.resolve({});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.provider.id).toBe("polar");
  });

  it("resolve() fails closed with not_configured when no adapter is registered", () => {
    const reg = createBillingProviderRegistry({});
    const res = reg.resolve({ BILLING_PROVIDER: "polar" });
    expect(res).toEqual({ ok: false, reason: "not_configured" });
  });

  it("resolve() fails closed with unknown_provider for a bad id", () => {
    const reg = createBillingProviderRegistry({ polar: fakeProvider("polar") });
    const res = reg.resolve({ BILLING_PROVIDER: "paypal" });
    expect(res).toEqual({ ok: false, reason: "unknown_provider" });
  });
});
