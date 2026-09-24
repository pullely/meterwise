import { effectiveBillingOrgId } from "@saas/db/membership";

describe("effectiveBillingOrgId", () => {
  it("returns the org's own id when standalone (parentOrgId null)", () => {
    expect(effectiveBillingOrgId({ id: "org_standalone", parentOrgId: null })).toBe(
      "org_standalone",
    );
  });

  it("returns the parent's id when the org is a child", () => {
    expect(
      effectiveBillingOrgId({ id: "org_child", parentOrgId: "org_parent" }),
    ).toBe("org_parent");
  });

  it("treats every standalone org as its own billing entity (back-compat)", () => {
    // The MO1 invariant: with no parent set (every existing org), resolution
    // collapses to the org id, so all current billing behavior is preserved.
    for (const id of ["org_a", "org_b", "org_c"]) {
      expect(effectiveBillingOrgId({ id, parentOrgId: null })).toBe(id);
    }
  });
});
