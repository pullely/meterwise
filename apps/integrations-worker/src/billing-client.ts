import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";

/**
 * Internal caller identity presented to billing-worker on the
 * service-binding-only entitlement-check route. This is a non-secret
 * provenance contract: only Workers explicitly bound to billing-worker
 * over a Cloudflare service binding can present this header, so it
 * cannot be reached from public traffic.
 *
 * Keep this value stable and in sync with billing-worker's allow-list
 * (apps/billing-worker/src/router.ts: ALLOWED_INTERNAL_CALLERS).
 */
export const INTERNAL_CALLER = "integrations-worker";

const INTERNAL_CALLER_HEADER = "x-internal-caller";

export type BillingEntitlementResult =
  | { kind: "decision"; decision: CheckBillingEntitlementResponse }
  | { kind: "service_error" };

/**
 * Calls billing-worker's private entitlement-check seam over a service
 * binding. Fails closed: any network exception, non-OK HTTP status, or
 * malformed JSON envelope surfaces as `service_error`. Successful HTTP
 * 200 responses with a valid envelope are returned verbatim as a
 * `decision` (which may itself be allowed or denied).
 *
 * The caller decides how to interpret a denial (e.g. quantity vs. boolean)
 * — this client deliberately does not bake in policy.
 */
export async function checkBillingEntitlement(
  billingWorker: Fetcher,
  orgPublicId: string,
  entitlementKey: string,
  requestId: string,
): Promise<BillingEntitlementResult> {
  let response: Response;
  try {
    response = await billingWorker.fetch(
      "http://billing-worker/v1/internal/billing/entitlements/check",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER,
        },
        body: JSON.stringify({ orgId: orgPublicId, entitlementKey }),
      },
    );
  } catch {
    return { kind: "service_error" };
  }

  if (!response.ok) {
    return { kind: "service_error" };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: "service_error" };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { kind: "service_error" };
  }

  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object") {
    return { kind: "service_error" };
  }

  const obj = data as Record<string, unknown>;
  if (typeof obj.allowed !== "boolean") {
    return { kind: "service_error" };
  }
  if (typeof obj.orgId !== "string" || typeof obj.entitlementKey !== "string") {
    return { kind: "service_error" };
  }

  return {
    kind: "decision",
    decision: data as CheckBillingEntitlementResponse,
  };
}

export type AssignPlanResult = { kind: "ok" } | { kind: "service_error" };

/**
 * Assign a plan to an org via billing-worker's internal plan-assignment seam
 * (Task 0128 / B11). Used at org bootstrap to grant the free plan so the org
 * gets real entitlement rows. BEST-EFFORT by contract: any failure surfaces as
 * `service_error` and the caller proceeds without failing the bootstrap — the
 * billing-worker `check-entitlement` free-tier safety net keeps the REQUIRED
 * create flows working until a later assignment succeeds.
 *
 * Forwards the bootstrapping actor (x-actor-*) so the subscription/entitlement
 * events attribute to the user who created the org.
 */
export async function assignPlan(
  billingWorker: Fetcher,
  orgPublicId: string,
  planCode: string,
  requestId: string,
  actor?: { id: string; type: string },
): Promise<AssignPlanResult> {
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": requestId,
      [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER,
    };
    if (actor) {
      headers["x-actor-subject-id"] = actor.id;
      headers["x-actor-subject-type"] = actor.type;
    }
    const response = await billingWorker.fetch(
      "http://billing-worker/v1/internal/billing/plan/assign",
      { method: "POST", headers, body: JSON.stringify({ orgId: orgPublicId, planCode }) },
    );
    return response.ok ? { kind: "ok" } : { kind: "service_error" };
  } catch {
    return { kind: "service_error" };
  }
}

export type FanOutResult = { kind: "ok" } | { kind: "service_error" };

/**
 * Fan out a billing parent's plan entitlements onto a freshly-created child org
 * via billing-worker's internal seam (MO3). BEST-EFFORT by contract: any failure
 * surfaces as `service_error` and the caller proceeds — the child still exists,
 * and a later re-fan-out (on the next parent plan event) reconciles it.
 */
export async function fanOutPlan(
  billingWorker: Fetcher,
  parentOrgPublicId: string,
  childOrgPublicId: string,
  requestId: string,
  actor?: { id: string; type: string },
): Promise<FanOutResult> {
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": requestId,
      [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER,
    };
    if (actor) {
      headers["x-actor-subject-id"] = actor.id;
      headers["x-actor-subject-type"] = actor.type;
    }
    const response = await billingWorker.fetch(
      "http://billing-worker/v1/internal/billing/plan/fan-out",
      { method: "POST", headers, body: JSON.stringify({ parentOrgId: parentOrgPublicId, childOrgId: childOrgPublicId }) },
    );
    return response.ok ? { kind: "ok" } : { kind: "service_error" };
  } catch {
    return { kind: "service_error" };
  }
}

export type MembersEntitlementGate =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; message: string }
  | { kind: "service_error" };

/**
 * Pure decision logic that interprets a billing entitlement response for
 * the `limit.members` quantity gate against the current billable-member
 * count (active members + pending invitations). Exposed for unit-testing.
 *
 * Semantics (per Task 0080 / specs/components/11-billing.md):
 * - allowed:false  → deny (reason = billing's reason: disabled | not_configured)
 * - allowed:true + valueType !== "quantity" → deny (malformed_limit)
 * - allowed:true + valueType "quantity" + limitValue null → allow (unlimited)
 * - allowed:true + valueType "quantity" + numeric limitValue:
 *     - billableCount  < limitValue → allow
 *     - billableCount >= limitValue → deny (limit_reached)
 *
 * The function fails closed on any unexpected shape.
 */
export function decideMembersLimit(
  decision: CheckBillingEntitlementResponse,
  billableCount: number,
): MembersEntitlementGate {
  if (!decision.allowed) {
    return {
      kind: "deny",
      reason: decision.reason,
      message:
        decision.reason === "disabled"
          ? "Inviting members is disabled by your current plan"
          : "Inviting members is not available for this organization",
    };
  }
  if (decision.valueType !== "quantity") {
    return {
      kind: "deny",
      reason: "malformed_limit",
      message: "Inviting members is not permitted by your current plan",
    };
  }
  if (decision.limitValue === null) {
    return { kind: "allow" };
  }
  if (
    typeof decision.limitValue !== "number" ||
    !Number.isFinite(decision.limitValue) ||
    decision.limitValue < 0
  ) {
    return {
      kind: "deny",
      reason: "malformed_limit",
      message: "Inviting members is not permitted by your current plan",
    };
  }
  if (!Number.isFinite(billableCount) || billableCount < 0) {
    return { kind: "service_error" };
  }
  if (billableCount < decision.limitValue) {
    return { kind: "allow" };
  }
  return {
    kind: "deny",
    reason: "limit_reached",
    message: "Your plan's member limit has been reached",
  };
}

export type OrgCreationGate =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; message: string }
  | { kind: "service_error" };

/**
 * Pure decision logic for the additional-organization gate (MO2). Combines the
 * account billing-parent's `feature.multi_org` (must be enabled) with its
 * `limit.organizations` quantity vs. the number of orgs the account already
 * owns. Exposed for unit-testing; fails closed on any unexpected shape.
 *
 * Semantics:
 * - feature.multi_org allowed:false → deny (disabled | not_configured) — the
 *   account isn't on a multi-org plan; CTA → upgrade.
 * - multi_org enabled, then limit.organizations:
 *     - allowed:false → deny (its reason)
 *     - valueType !== "quantity" → deny (malformed_limit)
 *     - limitValue null → allow (unlimited)
 *     - currentOrgCount  < limitValue → allow
 *     - currentOrgCount >= limitValue → deny (limit_reached)
 */
export function decideOrgCreationGate(
  multiOrg: CheckBillingEntitlementResponse,
  orgsLimit: CheckBillingEntitlementResponse,
  currentOrgCount: number,
): OrgCreationGate {
  if (!multiOrg.allowed) {
    return {
      kind: "deny",
      reason: multiOrg.reason,
      message:
        multiOrg.reason === "disabled"
          ? "Multiple organizations are not included in your current plan"
          : "Creating additional organizations requires a plan that supports multi-organization",
    };
  }
  if (!orgsLimit.allowed) {
    return {
      kind: "deny",
      reason: orgsLimit.reason,
      message: "Creating additional organizations is not available for this account",
    };
  }
  if (orgsLimit.valueType !== "quantity") {
    return { kind: "deny", reason: "malformed_limit", message: "Creating additional organizations is not permitted by your current plan" };
  }
  if (orgsLimit.limitValue === null) {
    return { kind: "allow" };
  }
  if (
    typeof orgsLimit.limitValue !== "number" ||
    !Number.isFinite(orgsLimit.limitValue) ||
    orgsLimit.limitValue < 0
  ) {
    return { kind: "deny", reason: "malformed_limit", message: "Creating additional organizations is not permitted by your current plan" };
  }
  if (!Number.isFinite(currentOrgCount) || currentOrgCount < 0) {
    return { kind: "service_error" };
  }
  if (currentOrgCount < orgsLimit.limitValue) {
    return { kind: "allow" };
  }
  return {
    kind: "deny",
    reason: "limit_reached",
    message: "You've reached the maximum number of organizations for your plan",
  };
}
