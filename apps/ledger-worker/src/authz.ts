import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import { fetchAuthorizationContext } from "./membership-client.js";
import { authorizeViaPolicy } from "./policy-client.js";

/**
 * The membership-context → policy-authorize pair every handler runs before it
 * touches a row. Deny-by-default: the caller turns `false` into `not_found`,
 * never `forbidden`, so a non-member cannot probe whether an item exists.
 */
export async function allowed(
  env: Env,
  actor: ActorContext,
  orgId: string,
  action: string,
  requestId: string,
  projectId?: string | null,
): Promise<boolean> {
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) return false;

  const context = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!context.ok) return false;

  const resource = projectId
    ? ({ kind: "project", orgId, projectId } as const)
    : ({ kind: "organization", orgId } as const);

  const decision = await authorizeViaPolicy(
    env.POLICY_WORKER,
    actor.subjectId,
    actor.subjectType,
    action,
    resource,
    context.memberships,
    requestId,
  );
  return decision.allow;
}
