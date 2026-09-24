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

  if (!response.ok) {
    return { ok: false };
  }

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
