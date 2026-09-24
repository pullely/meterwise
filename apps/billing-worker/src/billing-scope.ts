import type { Env } from "./env.js";
import { orgPublicId, parseOrgPublicId } from "./ids.js";
import { resolveBillingParent } from "./membership-client.js";

/**
 * Resolve a queried org (hex) to the hex of the org whose billing covers it
 * (MO4): its parent for a child, otherwise itself.
 *
 * FAIL-SAFE: any membership error (or missing binding) falls back to the queried
 * org so billing reads never hard-fail on resolution — a standalone org always
 * reads its own billing, and a child momentarily reads its own (empty) billing
 * rather than erroring.
 */
export async function resolveBillingOrgHex(
  env: Env,
  orgHex: string,
  requestId: string,
): Promise<string> {
  if (!env.MEMBERSHIP_WORKER) return orgHex;
  const res = await resolveBillingParent(env.MEMBERSHIP_WORKER as Fetcher, orgPublicId(orgHex), requestId);
  if (!res.ok) return orgHex;
  return parseOrgPublicId(res.billingOrgPublicId) ?? orgHex;
}
