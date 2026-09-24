-- 170_membership_org_parent: optional parent-organization pointer.
--
-- Context: membership
-- Epic: saas-multi-org-billing (MO1) — the dormant seam for the Datadog-style
--       multi-organization model. A parent_org_id lets an organization roll its
--       billing up to a parent organization (the customer's default org). NULL
--       means the organization is standalone and bills for itself — which is
--       every existing organization, so this migration changes no behavior on
--       its own.
--
-- Design rules (see specs/epics/saas-multi-org-billing/design.md §3):
--   * Additive + idempotent: ADD COLUMN IF NOT EXISTS, no rewrite of applied state.
--   * Nullable self-pointer within membership_organizations only — no
--     cross-context reference and no foreign key, consistent with the schema's
--     opaque-id convention (organization_members.org_id is likewise unconstrained).
--   * The resolution rule (parent_org_id ?? id) lives in code
--     (effectiveBillingOrgId); this migration only persists the pointer.

ALTER TABLE membership_organizations ADD COLUMN parent_org_id TEXT;

-- column membership_organizations.parent_org_id: Optional billing parent: when set, this organization rolls its billing up to the referenced (default/parent) organization. NULL = standalone and bills for itself. Self-reference within membership_organizations; not a foreign key, consistent with the schema opaque-id convention.

-- Sparse index: only child organizations carry a value, so the partial index
-- stays tiny and standalone organizations add no index cost.
CREATE INDEX IF NOT EXISTS organizations_parent_org_id_idx
  ON membership_organizations (parent_org_id)
  WHERE parent_org_id IS NOT NULL;
