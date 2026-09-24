import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ReconcileResponse } from "@saas/contracts/billing";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { createEventsRepository } from "@saas/db/events";
import { errorResponse, successResponse } from "../http.js";
import { authorizeBillingManage } from "../policy.js";
import { orgPublicId, generateUuid } from "../ids.js";
import { resolveBillingOrgHex } from "../billing-scope.js";
import { getPlanDefinition } from "../plan-catalog.js";
import {
  assignPlanWithRepos,
  parseAssignPlanBody,
  type AssignPlanResult,
  type ProviderLink,
} from "./assign-plan.js";
import { buildBillingProviderRegistry } from "../billing-provider/polar.js";
import { parsePolarConfig, planCodeForProduct } from "../billing-provider/polar-mapping.js";
import type { BillingProviderRegistry } from "../billing-provider/registry.js";

/**
 * POST /v1/organizations/:orgId/billing/reconcile
 *
 * Self-heal our billing state from the provider when a webhook was missed or
 * dropped: look up the org's active provider subscription (by external customer
 * id) and back-fill `provider` / `provider_subscription_id` / period onto our
 * row (idempotent — same code path as a `subscription.updated` webhook). Lets a
 * paid plan whose subscription exists at the provider but isn't linked locally
 * become manageable without waiting for the provider to re-send.
 *
 * Returns `{ reconciled: false }` (200, not an error) when there is no provider
 * subscription / no mappable product — the console then shows the
 * admin-assigned note. `billing.manage`-gated; binds to the account billing org.
 */

type BillingRepoSlice = Parameters<typeof assignPlanWithRepos>[0];
type EventsRepoSlice = Pick<EventsRepository, "appendEventWithAudit">;

const RECONCILE_ACTOR = { type: "system", id: "reconcile" } as const;

export interface ReconcileDeps {
  registry?: BillingProviderRegistry;
  productMap?: Record<string, string>;
  authorize?: typeof authorizeBillingManage;
  repoFactory?: (env: Env) => BillingRepoSlice;
  eventsFactory?: (env: Env) => EventsRepoSlice;
  now?: () => Date;
  generateId?: () => string;
}

function toDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function handleReconcile(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps: ReconcileDeps = {},
): Promise<Response> {
  const authorize = deps.authorize ?? authorizeBillingManage;
  const auth = await authorize(env, actor, orgId, requestId);
  if (!auth.ok) return auth.response;

  const registry = deps.registry ?? buildBillingProviderRegistry(env);
  const resolved = registry.resolve(env);
  if (!resolved.ok) {
    const body: ReconcileResponse = { reconciled: false, reason: "provider_unavailable" };
    return successResponse(body, requestId);
  }

  const billingOrgHex = await resolveBillingOrgHex(env, orgId, requestId);
  const publicId = orgPublicId(billingOrgHex);

  let provSub;
  try {
    provSub = await resolved.provider.getActiveSubscription(publicId);
  } catch {
    provSub = null;
  }
  if (!provSub) {
    const body: ReconcileResponse = { reconciled: false, reason: "no_provider_subscription" };
    return successResponse(body, requestId);
  }

  const productMap = deps.productMap ?? parsePolarConfig(env)?.productMap ?? {};
  const planCode = planCodeForProduct(productMap, provSub.productId);
  if (!planCode) {
    const body: ReconcileResponse = { reconciled: false, reason: "unmapped_product" };
    return successResponse(body, requestId);
  }

  const parsed = parseAssignPlanBody({ orgId: publicId, planCode });
  if ("error" in parsed) {
    const body: ReconcileResponse = { reconciled: false, reason: "bad_org" };
    return successResponse(body, requestId);
  }
  const def = getPlanDefinition(planCode)!;
  const now = deps.now ? deps.now() : new Date();
  const genId = deps.generateId ?? generateUuid;
  const provider: ProviderLink = {
    id: "polar",
    customerId: provSub.providerCustomerId,
    subscriptionId: provSub.providerSubscriptionId,
    currentPeriodStart: toDate(provSub.currentPeriodStart),
    currentPeriodEnd: toDate(provSub.currentPeriodEnd),
  };
  const opts = { now, genId, actor: RECONCILE_ACTOR, requestId, provider };

  let outcome: AssignPlanResult;
  try {
    if (deps.repoFactory) {
      const repo = deps.repoFactory(env);
      const events = deps.eventsFactory ? deps.eventsFactory(env) : null;
      outcome = await assignPlanWithRepos(repo, events, parsed, def, opts);
    } else if (env.PLATFORM_DB) {
      const executor = createSqlExecutor(env.PLATFORM_DB);
      try {
        if ("transaction" in executor) {
          outcome = await executor.transaction(async (txExec) => {
            const repo = createBillingRepository(txExec);
            const events = createEventsRepository(txExec);
            return assignPlanWithRepos(repo, events, parsed, def, opts);
          });
        } else {
          const repo = createBillingRepository(executor);
          const events = createEventsRepository(executor);
          outcome = await assignPlanWithRepos(repo, events, parsed, def, opts);
        }
      } finally {
        if ("dispose" in executor && typeof executor.dispose === "function") {
          await executor.dispose();
        }
      }
    } else {
      return errorResponse("internal_error", "Service misconfigured", 503, requestId);
    }
  } catch {
    return errorResponse("provider_error", "Failed to reconcile subscription", 502, requestId);
  }

  if (outcome.kind === "repo_error") {
    return errorResponse("internal_error", "Failed to reconcile subscription", 503, requestId);
  }
  const body: ReconcileResponse = { reconciled: true, planCode: outcome.planCode };
  return successResponse(body, requestId);
}
