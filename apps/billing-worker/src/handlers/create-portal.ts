import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { CreatePortalSessionResponse } from "@saas/contracts/billing";
import { errorResponse, successResponse } from "../http.js";
import { authorizeBillingManage } from "../policy.js";
import { orgPublicId } from "../ids.js";
import { buildBillingProviderRegistry } from "../billing-provider/polar.js";
import type { BillingProviderRegistry } from "../billing-provider/registry.js";

/**
 * POST /v1/organizations/:orgId/billing/portal (BP2).
 *
 * Authorize `billing.manage` and return a hosted customer-portal URL for the
 * org (resolved by its public id as the provider external customer id) so the
 * buyer can manage their subscription / payment method. No body.
 */

export interface CreatePortalDeps {
  registry?: BillingProviderRegistry;
  authorize?: typeof authorizeBillingManage;
}

export async function handleCreatePortal(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps: CreatePortalDeps = {},
): Promise<Response> {
  const authorize = deps.authorize ?? authorizeBillingManage;
  const auth = await authorize(env, actor, orgId, requestId);
  if (!auth.ok) return auth.response;

  const registry = deps.registry ?? buildBillingProviderRegistry(env);
  const resolved = registry.resolve(env);
  if (!resolved.ok) {
    return errorResponse("provider_unavailable", "Billing provider not configured", 503, requestId);
  }

  try {
    const result = await resolved.provider.createPortalSession({ orgId: orgPublicId(orgId) });
    const body: CreatePortalSessionResponse = { portalUrl: result.portalUrl };
    return successResponse(body, requestId);
  } catch {
    return errorResponse("provider_error", "Failed to create portal session", 502, requestId);
  }
}
