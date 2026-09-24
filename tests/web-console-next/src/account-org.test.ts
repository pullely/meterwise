import { pickAccountBillingOrg } from "@web-console-next/components/billing/account-org";

const o = (id: string, createdAt: string) => ({ id, slug: id, createdAt });

describe("pickAccountBillingOrg", () => {
  it("returns null for an empty account", () => {
    expect(pickAccountBillingOrg([])).toBeNull();
  });

  it("picks the earliest-created org (matches the MO2 gate's billing parent)", () => {
    const orgs = [
      o("b", "2026-03-01T00:00:00Z"),
      o("a", "2026-01-01T00:00:00Z"),
      o("c", "2026-02-01T00:00:00Z"),
    ];
    expect(pickAccountBillingOrg(orgs)?.id).toBe("a");
  });

  it("returns the only org when there is one", () => {
    expect(pickAccountBillingOrg([o("solo", "2026-05-01T00:00:00Z")])?.id).toBe("solo");
  });
});
