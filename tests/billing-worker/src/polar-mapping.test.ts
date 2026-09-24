import {
  parsePolarProductMap,
  planCodeForProduct,
  parsePolarConfig,
  mapPolarEventToNormalized,
} from "@billing-worker/billing-provider/polar-mapping";
import type { Env } from "@billing-worker/env";

const env = (over: Partial<Env>): Env => ({ ENVIRONMENT: "test", ...over } as Env);

describe("parsePolarProductMap", () => {
  it("parses a valid plan→product map", () => {
    expect(parsePolarProductMap('{"pro":"prod_p","business":"prod_b"}')).toEqual({
      pro: "prod_p",
      business: "prod_b",
    });
  });
  it("returns {} for undefined / invalid JSON / non-object / arrays", () => {
    expect(parsePolarProductMap(undefined)).toEqual({});
    expect(parsePolarProductMap("not json")).toEqual({});
    expect(parsePolarProductMap('"a string"')).toEqual({});
    expect(parsePolarProductMap("[1,2]")).toEqual({});
  });
  it("drops non-string / empty ids", () => {
    expect(parsePolarProductMap('{"pro":"prod_p","x":123,"y":"","z":null}')).toEqual({
      pro: "prod_p",
    });
  });
});

describe("planCodeForProduct", () => {
  const map = { pro: "prod_p", business: "prod_b" };
  it("resolves a product id back to its plan code", () => {
    expect(planCodeForProduct(map, "prod_b")).toBe("business");
  });
  it("returns null for unknown / null product ids", () => {
    expect(planCodeForProduct(map, "prod_unknown")).toBeNull();
    expect(planCodeForProduct(map, null)).toBeNull();
  });
});

describe("parsePolarConfig", () => {
  it("returns null when the access token or webhook secret is missing (fail closed)", () => {
    expect(parsePolarConfig(env({}))).toBeNull();
    expect(parsePolarConfig(env({ POLAR_ACCESS_TOKEN: "tok" }))).toBeNull();
    expect(parsePolarConfig(env({ POLAR_WEBHOOK_SECRET: "whsec" }))).toBeNull();
  });
  it("builds config when fully configured; server defaults to sandbox", () => {
    const cfg = parsePolarConfig(
      env({
        POLAR_ACCESS_TOKEN: "tok",
        POLAR_WEBHOOK_SECRET: "whsec",
        POLAR_PRODUCT_MAP: '{"pro":"prod_p"}',
        POLAR_SUCCESS_URL: "https://app.example/billing",
      }),
    );
    expect(cfg).toEqual({
      accessToken: "tok",
      webhookSecret: "whsec",
      server: "sandbox",
      productMap: { pro: "prod_p" },
      successUrl: "https://app.example/billing",
    });
  });
  it("honors POLAR_SERVER=production", () => {
    const cfg = parsePolarConfig(
      env({ POLAR_ACCESS_TOKEN: "tok", POLAR_WEBHOOK_SECRET: "whsec", POLAR_SERVER: "production" }),
    );
    expect(cfg?.server).toBe("production");
  });
});

describe("mapPolarEventToNormalized", () => {
  const sub = {
    id: "sub_1",
    customerId: "cus_1",
    productId: "prod_b",
    currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    customer: { id: "cus_1", externalId: "org_abc" },
  };

  it("maps subscription.active/created → subscription.activated with extracted fields", () => {
    for (const type of ["subscription.active", "subscription.created"]) {
      const ev = mapPolarEventToNormalized("evt_1", { type, data: sub });
      expect(ev).toEqual({
        providerEventId: "evt_1",
        provider: "polar",
        type: "subscription.activated",
        orgId: "org_abc",
        providerCustomerId: "cus_1",
        providerSubscriptionId: "sub_1",
        productId: "prod_b",
        currentPeriodStart: "2026-06-01T00:00:00.000Z",
        currentPeriodEnd: "2026-07-01T00:00:00.000Z",
      });
    }
  });

  it("maps updated/uncanceled/past_due → subscription.updated", () => {
    for (const type of ["subscription.updated", "subscription.uncanceled", "subscription.past_due"]) {
      const ev = mapPolarEventToNormalized("e", { type, data: sub });
      expect(ev.type).toBe("subscription.updated");
    }
  });

  it("maps canceled/revoked → subscription.canceled", () => {
    for (const type of ["subscription.canceled", "subscription.revoked"]) {
      const ev = mapPolarEventToNormalized("e", { type, data: sub });
      expect(ev.type).toBe("subscription.canceled");
    }
  });

  it("maps order.created → invoice.recorded (due set, paid 0)", () => {
    const ev = mapPolarEventToNormalized("evt_o", {
      type: "order.created",
      data: { id: "ord_1", customerId: "cus_1", subscriptionId: "sub_1", totalAmount: 9900, currency: "usd", customer: { externalId: "org_abc" } },
    });
    expect(ev).toEqual({
      providerEventId: "evt_o",
      provider: "polar",
      type: "invoice.recorded",
      orgId: "org_abc",
      providerCustomerId: "cus_1",
      providerInvoiceId: "ord_1",
      providerSubscriptionId: "sub_1",
      currency: "usd",
      hostedUrl: null,
      amountDueCents: 9900,
      amountPaidCents: 0,
    });
  });

  it("maps order.paid → invoice.paid (due and paid both set)", () => {
    const ev = mapPolarEventToNormalized("e", {
      type: "order.paid",
      data: { id: "ord_2", customerId: "cus_1", totalAmount: 2000, currency: "usd", customer: { externalId: "org_abc" } },
    });
    expect(ev.type).toBe("invoice.paid");
    if (ev.type === "invoice.paid") {
      expect(ev.amountDueCents).toBe(2000);
      expect(ev.amountPaidCents).toBe(2000);
    }
  });

  it("maps unrecognized events to ignored (still carries the raw type)", () => {
    const ev = mapPolarEventToNormalized("e", { type: "benefit.created", data: {} });
    expect(ev).toEqual({
      providerEventId: "e",
      provider: "polar",
      type: "ignored",
      providerType: "benefit.created",
    });
  });

  it("tolerates missing fields (null-safe extraction)", () => {
    const ev = mapPolarEventToNormalized("e", { type: "subscription.active", data: {} });
    expect(ev).toMatchObject({
      type: "subscription.activated",
      orgId: null,
      providerSubscriptionId: null,
      currentPeriodStart: null,
    });
  });
});
