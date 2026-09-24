import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ListPaymentMethodsResponse } from "@saas/contracts/billing";
import { successResponse } from "../http.js";
import { authorizeBillingRead } from "../policy.js";
import { orgPublicId } from "../ids.js";
import { resolveBillingOrgHex } from "../billing-scope.js";
import { buildBillingProviderRegistry } from "../billing-provider/polar.js";
import type { BillingProviderRegistry } from "../billing-provider/registry.js";

/**
 * GET /v1/organizations/:orgId/billing/payment-methods
 *
 * Lists the account's saved cards (safe display fields only: brand, last4,
 * expiry) so the console can show the card on file next to the PCI-gated
 * "Update payment method" deep-link. Read-authorized; resolves the account
 * billing org (child → parent, MO4). Sourced from the provider with the org
 * token server-side — no provider session/token ever reaches the console.
 * Provider unavailability degrades to an empty list rather than erroring the
 * billing page.
 */

export interface ListPaymentMethodsDeps {
  registry?: BillingProviderRegistry;
  authorize?: typeof authorizeBillingRead;
}

export async function handleListPaymentMethods(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps: ListPaymentMethodsDeps = {},
): Promise<Response> {
  const authorize = deps.authorize ?? authorizeBillingRead;
  const auth = await authorize(env, actor, orgId, requestId);
  if (!auth.ok) return auth.response;

  const registry = deps.registry ?? buildBillingProviderRegistry(env);
  const resolved = registry.resolve(env);
  if (!resolved.ok) {
    // Provider not configured → no cards to show (page still renders).
    const empty: ListPaymentMethodsResponse = { paymentMethods: [] };
    return successResponse(empty, requestId);
  }

  const billingOrgHex = await resolveBillingOrgHex(env, orgId, requestId);
  try {
    const methods = await resolved.provider.listPaymentMethods(orgPublicId(billingOrgHex));
    const body: ListPaymentMethodsResponse = {
      paymentMethods: methods.map((m) => ({
        id: m.id,
        brand: m.brand,
        last4: m.last4,
        expMonth: m.expMonth,
        expYear: m.expYear,
      })),
    };
    return successResponse(body, requestId);
  } catch {
    // Best-effort display — never block the billing page on a provider blip.
    const empty: ListPaymentMethodsResponse = { paymentMethods: [] };
    return successResponse(empty, requestId);
  }
}
