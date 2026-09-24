// Support authorization seam — deny-by-default.
//
// Per spec-16 + tenancy-and-rbac deny-by-default: a support action is permitted
// ONLY when the caller presents either:
//   1. a recognized support role claim, or
//   2. an explicit system override (a `system`-type actor representing an
//      out-of-band, separately-audited break-glass path).
//
// Anything else — no support role, no override, an unrecognized role — is
// DENIED. There is no implicit grant and no privileged shortcut. The exact
// source of truth for the support-role claim is intentionally narrow for V1
// (an `x-support-role` header carrying a recognized value, mirroring how peer
// workers resolve actor claims from headers); it can be tightened to a signed
// claim later without changing this contract.

export interface SupportActor {
  subjectId: string;
  subjectType: string;
}

// Recognized V1 support roles. Narrow allowlist — fail closed for anything else.
const RECOGNIZED_SUPPORT_ROLES = new Set(["support_agent", "support_admin"]);

export interface SupportAuthInput {
  actor: SupportActor | null;
  // Raw support-role claim presented by the caller (may be null/unknown).
  supportRoleClaim: string | null;
  // Explicit system override flag (break-glass; separately audited upstream).
  systemOverride: boolean;
}

export type SupportAuthDecision =
  | { allow: true; grant: "support_role" | "system_override"; matchedRole: string | null }
  | { allow: false; reason: string };

export function authorizeSupportAction(input: SupportAuthInput): SupportAuthDecision {
  // Fail closed if there is no authenticated actor at all.
  if (!input.actor) {
    return { allow: false, reason: "missing_actor" };
  }

  // Path 1: explicit system override. Only a `system`-type actor may exercise it.
  if (input.systemOverride) {
    if (input.actor.subjectType === "system") {
      return { allow: true, grant: "system_override", matchedRole: null };
    }
    return { allow: false, reason: "override_requires_system_actor" };
  }

  // Path 2: recognized support role claim.
  if (input.supportRoleClaim && RECOGNIZED_SUPPORT_ROLES.has(input.supportRoleClaim)) {
    return { allow: true, grant: "support_role", matchedRole: input.supportRoleClaim };
  }

  // Deny-by-default.
  return { allow: false, reason: "no_support_role_or_override" };
}

export function isRecognizedSupportRole(role: string): boolean {
  return RECOGNIZED_SUPPORT_ROLES.has(role);
}
