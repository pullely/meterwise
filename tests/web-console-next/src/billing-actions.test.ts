import {
  selectUpgradePlans,
  selectDowngradePlans,
  formatPlanPrice,
  hasManageableSubscription,
  pollForPlanChange,
  orderedPlans,
  planChangeAction,
  planFeatureLines,
} from "@web-console-next/components/billing/plan-actions";
import type { PublicPlan } from "@saas/contracts/billing";

const noSleep = () => Promise.resolve();

function plan(over: Partial<PublicPlan>): PublicPlan {
  return {
    id: over.code ? `plan_${over.code}` : "plan_x",
    code: "x",
    name: "X",
    description: null,
    status: "active",
    billingInterval: "month",
    priceAmountCents: 0,
    priceCurrency: "usd",
    metadata: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const CATALOG: PublicPlan[] = [
  plan({ code: "free", name: "Free", priceAmountCents: 0 }),
  plan({ code: "business", name: "Business", priceAmountCents: 9900 }),
  plan({ code: "pro", name: "Pro", priceAmountCents: 2000 }),
  plan({ code: "enterprise", name: "Enterprise", billingInterval: "none", priceAmountCents: 0 }),
  plan({ code: "archived_pro", name: "Old", priceAmountCents: 1500, status: "archived" }),
];

describe("selectUpgradePlans", () => {
  it("returns only active, recurring, priced plans (excludes free/enterprise/archived), sorted by price", () => {
    const out = selectUpgradePlans(CATALOG, "free");
    expect(out.map((p) => p.code)).toEqual(["pro", "business"]);
  });

  it("excludes the current plan", () => {
    const out = selectUpgradePlans(CATALOG, "pro");
    expect(out.map((p) => p.code)).toEqual(["business"]);
  });

  it("returns nothing to upgrade to when on the top tier", () => {
    expect(selectUpgradePlans(CATALOG, "business").map((p) => p.code)).toEqual([]);
  });
});

describe("selectDowngradePlans", () => {
  it("returns lower paid tiers (excludes free/enterprise/archived/current), sorted by price desc", () => {
    expect(selectDowngradePlans(CATALOG, "business").map((p) => p.code)).toEqual(["pro"]);
  });

  it("returns nothing from the lowest paid tier", () => {
    expect(selectDowngradePlans(CATALOG, "pro")).toEqual([]);
  });

  it("returns nothing for a free/unpriced current plan (that's an upgrade, not a downgrade)", () => {
    expect(selectDowngradePlans(CATALOG, "free")).toEqual([]);
    expect(selectDowngradePlans(CATALOG, null)).toEqual([]);
  });
});

describe("orderedPlans", () => {
  it("orders Free → paid asc → contact-sales last, excluding archived", () => {
    expect(orderedPlans(CATALOG).map((p) => p.code)).toEqual(["free", "pro", "business", "enterprise"]);
  });
});

describe("planChangeAction", () => {
  const byCode = (c: string) => CATALOG.find((p) => p.code === c)!;
  it("same plan → current", () => {
    expect(planChangeAction({ target: byCode("pro"), currentCode: "pro", manageable: true })).toBe("current");
  });
  it("contact-sales plan → contact", () => {
    expect(planChangeAction({ target: byCode("enterprise"), currentCode: "pro", manageable: true })).toBe("contact");
  });
  it("→ free → cancel", () => {
    expect(planChangeAction({ target: byCode("free"), currentCode: "pro", manageable: true })).toBe("cancel");
  });
  it("paid target with a managed sub → change", () => {
    expect(planChangeAction({ target: byCode("business"), currentCode: "pro", manageable: true })).toBe("change");
  });
  it("paid target from free (no managed sub) → checkout", () => {
    expect(planChangeAction({ target: byCode("pro"), currentCode: "free", manageable: false })).toBe("checkout");
  });
  it("defaults current to free when null", () => {
    expect(planChangeAction({ target: byCode("pro"), currentCode: null, manageable: false })).toBe("checkout");
  });
});

describe("planFeatureLines", () => {
  it("returns bullets for known plans, empty for unknown", () => {
    expect(planFeatureLines("pro").length).toBeGreaterThan(0);
    expect(planFeatureLines("free").length).toBeGreaterThan(0);
    expect(planFeatureLines("nope")).toEqual([]);
  });
});

describe("formatPlanPrice", () => {
  it("formats whole-dollar monthly USD", () => {
    expect(formatPlanPrice(plan({ priceAmountCents: 2000 }))).toBe("$20/mo");
  });
  it("formats cents and yearly", () => {
    expect(formatPlanPrice(plan({ priceAmountCents: 9999, billingInterval: "year" }))).toBe("$99.99/yr");
  });
  it("prefixes non-usd currency codes", () => {
    expect(formatPlanPrice(plan({ priceAmountCents: 1000, priceCurrency: "eur" }))).toBe("EUR 10/mo");
  });
  it("is empty for an unpriced plan", () => {
    expect(formatPlanPrice(plan({ priceAmountCents: null }))).toBe("");
  });
});

describe("hasManageableSubscription", () => {
  it("is true for a paid plan, false for free/none", () => {
    expect(hasManageableSubscription("pro")).toBe(true);
    expect(hasManageableSubscription("business")).toBe(true);
    expect(hasManageableSubscription("free")).toBe(false);
    expect(hasManageableSubscription(null)).toBe(false);
  });
});

describe("pollForPlanChange", () => {
  it("resolves changed once the plan code differs from the starting plan", async () => {
    let calls = 0;
    const res = await pollForPlanChange({
      fromPlanCode: "free",
      attempts: 5,
      intervalMs: 1,
      sleep: noSleep,
      fetchPlanCode: async () => {
        calls += 1;
        return calls < 3 ? "free" : "pro"; // webhook lands on the 3rd poll
      },
    });
    expect(res).toEqual({ changed: true, planCode: "pro" });
    expect(calls).toBe(3);
  });

  it("gives up after the attempt budget when the plan never changes", async () => {
    let calls = 0;
    const res = await pollForPlanChange({
      fromPlanCode: "free",
      attempts: 4,
      intervalMs: 1,
      sleep: noSleep,
      fetchPlanCode: async () => {
        calls += 1;
        return "free";
      },
    });
    expect(res).toEqual({ changed: false, planCode: "free" });
    expect(calls).toBe(4);
  });

  it("swallows transient fetch errors and keeps polling", async () => {
    let calls = 0;
    const res = await pollForPlanChange({
      fromPlanCode: "free",
      attempts: 5,
      intervalMs: 1,
      sleep: noSleep,
      fetchPlanCode: async () => {
        calls += 1;
        if (calls === 1) throw new Error("network blip");
        return calls >= 3 ? "business" : "free";
      },
    });
    expect(res.changed).toBe(true);
    expect(res.planCode).toBe("business");
  });
});
