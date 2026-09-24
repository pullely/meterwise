import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { createEventsRepository } from "@saas/db/events";
import { successResponse, errorResponse } from "../http.js";
import { generateUuid } from "../ids.js";
import { DEFAULT_PLAN_CODE, getPlanDefinition } from "../plan-catalog.js";
import {
  assignPlanWithRepos,
  parseAssignPlanBody,
  type AssignPlanResult,
  type ProviderLink,
} from "./assign-plan.js";
import { buildBillingProviderRegistry } from "../billing-provider/polar.js";
import { syncAccountChildren } from "../membership-client.js";
import { parsePolarConfig, planCodeForProduct } from "../billing-provider/polar-mapping.js";
import type { BillingProviderRegistry } from "../billing-provider/registry.js";
import type { NormalizedEvent } from "../billing-provider/types.js";

/**
 * Inbound provider-webhook intake (BP2). The api-edge billing-webhook facade
 * forwards the raw, unparsed body + signature headers here over a service
 * binding; this handler resolves the configured provider, verifies the
 * signature (fails closed), and applies the normalized event to our billing
 * state:
 *
 *   - subscription.activated / .updated → assign the plan mapped from the
 *     provider product id (`POLAR_PRODUCT_MAP`) to the billing-parent org.
 *   - subscription.canceled            → downgrade the org to the free plan
 *     (D4: least-destructive; existing children are handled by MO3 fan-out).
 *   - invoice.* / ignored              → acknowledged with no state change
 *     (invoice persistence is a follow-up).
 *
 * Idempotent: plan assignment is a no-op when the same plan is already active,
 * so provider redeliveries are safe without a separate dedupe ledger.
 */

type BillingRepoSlice = Parameters<typeof assignPlanWithRepos>[0];
type EventsRepoSlice = Parameters<typeof assignPlanWithRepos>[1];

const WEBHOOK_ACTOR = { type: "system", id: "polar-webhook" } as const;

export interface WebhookIntakeDeps {
  registry?: BillingProviderRegistry;
  productMap?: Record<string, string>;
  repoFactory?: (env: Env) => BillingRepoSlice;
  eventsFactory?: (env: Env) => EventsRepoSlice;
  now?: () => Date;
  generateId?: () => string;
  /** Injectable child re-sync trigger (MO3) for tests; defaults to membership-worker. */
  syncChildren?: (parentOrgPublicId: string, mode: "refanout" | "freeze") => Promise<void>;
}

function headerRecord(request: Request): Record<string, string> {
  const h: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    h[key.toLowerCase()] = value;
  });
  return h;
}

export async function handleWebhookIntake(
  request: Request,
  env: Env,
  requestId: string,
  deps: WebhookIntakeDeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  }
  if (!deps.repoFactory && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  // Resolve the env-configured provider for signature verification.
  const registry = deps.registry ?? buildBillingProviderRegistry(env);
  const resolved = registry.resolve(env);
  if (!resolved.ok) {
    // Misconfigured / unknown provider → 503 so the provider retries later.
    return errorResponse("provider_unavailable", "Billing provider not configured", 503, requestId);
  }

  const rawBody = await request.text();
  const verified = await resolved.provider.verifyWebhook(rawBody, headerRecord(request));
  if (!verified.ok) {
    const status = verified.reason === "invalid_signature" ? 401 : 400;
    return errorResponse(verified.reason, `Webhook ${verified.reason.replace(/_/g, " ")}`, status, requestId);
  }

  const productMap = deps.productMap ?? parsePolarConfig(env)?.productMap ?? {};
  const handled = await applyEvent(env, verified.event, productMap, deps, requestId);
  if (handled === "repo_error") {
    return errorResponse("internal_error", "Failed to apply billing event", 503, requestId);
  }
  return successResponse({ received: true, handled }, requestId);
}

/** Apply a verified event; returns a short outcome tag or "repo_error". */
async function applyEvent(
  env: Env,
  event: NormalizedEvent,
  productMap: Record<string, string>,
  deps: WebhookIntakeDeps,
  requestId: string,
): Promise<string> {
  switch (event.type) {
    case "subscription.activated":
    case "subscription.updated": {
      if (!event.orgId) return "noop:no-org";
      const planCode = planCodeForProduct(productMap, event.productId);
      if (!planCode) return "noop:unknown-product";
      // Persist the provider linkage so the subscription is manageable
      // (change/cancel/payment) and the period shows in the console.
      const provider: ProviderLink = {
        id: event.provider,
        customerId: event.providerCustomerId,
        subscriptionId: event.providerSubscriptionId,
        currentPeriodStart: parseDate(event.currentPeriodStart),
        currentPeriodEnd: parseDate(event.currentPeriodEnd),
      };
      const result = await assignFor(env, event.orgId, planCode, deps, requestId, provider);
      // Plan changed on the (billing parent) org → propagate to its children.
      if (result !== "repo_error") await triggerChildSync(env, event.orgId, "refanout", deps, requestId);
      return result;
    }
    case "subscription.canceled": {
      if (!event.orgId) return "noop:no-org";
      const result = await assignFor(env, event.orgId, DEFAULT_PLAN_CODE, deps, requestId);
      // Downgraded below multi-org → freeze children (flag-only, per policy).
      if (result !== "repo_error") await triggerChildSync(env, event.orgId, "freeze", deps, requestId);
      return result;
    }
    default:
      // invoice.recorded / invoice.paid / payment.failed / ignored: ack only.
      return `noop:${event.type}`;
  }
}

/** Best-effort: ask membership-worker to re-sync the account's children. Never
 * fails intake — children reconcile on the next plan event. */
async function triggerChildSync(
  env: Env,
  parentOrgPublicId: string,
  mode: "refanout" | "freeze",
  deps: WebhookIntakeDeps,
  requestId: string,
): Promise<void> {
  try {
    if (deps.syncChildren) {
      await deps.syncChildren(parentOrgPublicId, mode);
      return;
    }
    if (env.MEMBERSHIP_WORKER) {
      await syncAccountChildren(env.MEMBERSHIP_WORKER as Fetcher, parentOrgPublicId, mode, requestId);
    }
  } catch {
    /* best-effort */
  }
}

/** Parse an ISO timestamp from a normalized event into a Date (or null). */
function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function assignFor(
  env: Env,
  publicOrgId: string,
  planCode: string,
  deps: WebhookIntakeDeps,
  requestId: string,
  provider?: ProviderLink,
): Promise<string> {
  const parsed = parseAssignPlanBody({ orgId: publicOrgId, planCode });
  if ("error" in parsed) return "noop:bad-org"; // malformed external id → ack, don't retry
  const def = getPlanDefinition(parsed.planCode)!; // validated in parse
  const now = deps.now ? deps.now() : new Date();
  const genId = deps.generateId ?? generateUuid;
  const opts = { now, genId, actor: WEBHOOK_ACTOR, requestId, ...(provider ? { provider } : {}) };

  let outcome: AssignPlanResult;
  if (deps.repoFactory) {
    const repo = deps.repoFactory(env);
    const events = deps.eventsFactory ? deps.eventsFactory(env) : null;
    outcome = await assignPlanWithRepos(repo, events, parsed, def, opts);
  } else {
    const executor = createSqlExecutor(env.PLATFORM_DB!);
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
  }
  return outcome.kind === "repo_error" ? "repo_error" : `assigned:${outcome.planCode}`;
}
