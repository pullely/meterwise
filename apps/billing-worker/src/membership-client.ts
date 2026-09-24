import type { AuthorizationContextResponse, MembershipFact } from "@saas/contracts/policy";

export type MembershipContextResult =
  | { ok: true; memberships: MembershipFact[] }
  | { ok: false };

export async function fetchAuthorizationContext(
  membershipWorker: Fetcher,
  subjectId: string,
  subjectType: string,
  orgId: string,
  requestId: string,
): Promise<MembershipContextResult> {
  let response: Response;
  try {
    response = await membershipWorker.fetch(
      "http://membership-worker/v1/internal/membership/authorization-context",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify({
          subject: { type: subjectType, id: subjectId },
          orgId,
        }),
      },
    );
  } catch {
    return { ok: false };
  }

  if (!response.ok) return { ok: false };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { ok: false };
  }

  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object" || !("memberships" in data)) {
    return { ok: false };
  }

  const typed = data as AuthorizationContextResponse;
  if (!Array.isArray(typed.memberships)) {
    return { ok: false };
  }

  return { ok: true, memberships: typed.memberships };
}

export type SyncChildrenMode = "refanout" | "freeze";

/**
 * Ask membership-worker to re-sync a billing parent's child orgs after the
 * parent's plan changed (MO3): "refanout" re-copies the parent's entitlements
 * onto each child and reactivates them; "freeze" suspends them. BEST-EFFORT —
 * a failure never fails webhook intake; children reconcile on the next event.
 */
export async function syncAccountChildren(
  membershipWorker: Fetcher,
  parentOrgPublicId: string,
  mode: SyncChildrenMode,
  requestId: string,
): Promise<{ ok: boolean }> {
  try {
    const response = await membershipWorker.fetch(
      "http://membership-worker/v1/internal/membership/account/children-sync",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ parentOrgId: parentOrgPublicId, mode }),
      },
    );
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve an org to the org whose subscription/customer covers it (MO4): its
 * billing parent for a child, otherwise itself. Returns the effective billing
 * org's public id, or `{ ok: false }` on any error so callers can fail safe.
 */
export async function resolveBillingParent(
  membershipWorker: Fetcher,
  orgPublicId: string,
  requestId: string,
): Promise<{ ok: true; billingOrgPublicId: string } | { ok: false }> {
  try {
    const response = await membershipWorker.fetch(
      "http://membership-worker/v1/internal/membership/organizations/billing-parent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ orgId: orgPublicId }),
      },
    );
    if (!response.ok) return { ok: false };
    const parsed = (await response.json()) as { data?: { billingOrgId?: unknown } };
    const billingOrgId = parsed?.data?.billingOrgId;
    if (typeof billingOrgId !== "string") return { ok: false };
    return { ok: true, billingOrgPublicId: billingOrgId };
  } catch {
    return { ok: false };
  }
}
