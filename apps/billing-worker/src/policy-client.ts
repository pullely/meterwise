import type {
  AuthorizationRequest,
  AuthorizationResponse,
  MembershipFact,
  PolicyResource,
  PolicySubject,
} from "@saas/contracts/policy";

export interface AuthorizeResult {
  allow: boolean;
}

export async function authorizeViaPolicy(
  policyWorker: Fetcher,
  subjectId: string,
  subjectType: string,
  action: string,
  resource: PolicyResource,
  memberships: MembershipFact[],
  requestId: string,
): Promise<AuthorizeResult> {
  const subject: PolicySubject = {
    type: subjectType as PolicySubject["type"],
    id: subjectId,
  };

  const body: AuthorizationRequest = {
    subject,
    action,
    resource,
    context: { memberships },
  };

  let response: Response;
  try {
    response = await policyWorker.fetch(
      "http://policy-worker/v1/internal/policy/authorize",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    return { allow: false };
  }

  if (!response.ok) return { allow: false };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { allow: false };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { allow: false };
  }

  const data = (parsed as { data: unknown }).data;
  if (
    !data ||
    typeof data !== "object" ||
    !("allow" in data) ||
    typeof (data as AuthorizationResponse).allow !== "boolean"
  ) {
    return { allow: false };
  }

  return { allow: (data as AuthorizationResponse).allow };
}
