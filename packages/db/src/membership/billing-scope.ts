import type { Organization } from "./types.js";

/**
 * The organization whose billing customer/subscription/entitlements cover `org`:
 * its parent when it is a child organization, otherwise itself.
 *
 * This is the single resolution rule for the Datadog-style multi-organization
 * model (epic `saas-multi-org-billing`). Billing *reads* (summary, invoices,
 * customer, checkout/portal) resolve through here; entitlement *decisions* keep
 * reading the org's own per-org rows, which fan-out keeps in sync — so this
 * helper never touches the `check-entitlement` hot path.
 *
 * For every existing (standalone) organization `parentOrgId` is NULL, so this
 * collapses to `org.id` and all current behavior is preserved.
 */
export function effectiveBillingOrgId(
  org: Pick<Organization, "id" | "parentOrgId">,
): string {
  return org.parentOrgId ?? org.id;
}
