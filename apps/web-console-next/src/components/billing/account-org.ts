/**
 * The account's billing-parent org: the earliest-created org the user belongs
 * to. This MUST match the membership-worker MO2 gate, which resolves the billing
 * parent the same way — so the "Upgrade plan" CTA on the org-creation paywall
 * targets the same org the gate checks `feature.multi_org` against.
 */
export interface AccountOrgLike {
  id: string;
  slug: string;
  createdAt: string;
}

export function pickAccountBillingOrg<T extends AccountOrgLike>(orgs: T[]): T | null {
  if (orgs.length === 0) return null;
  return orgs.reduce((a, b) =>
    new Date(a.createdAt).getTime() <= new Date(b.createdAt).getTime() ? a : b,
  );
}
