import type { Env } from "../env.js";
import type {
  CheckBillingEntitlementRequest,
  CheckBillingEntitlementResponse,
} from "@saas/contracts/billing";
import type { BillingRepository, EntitlementDecisionRepository } from "@saas/db/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { createEntitlementDecisionRepository } from "@saas/db/billing";
import { errorResponse, successResponse, validationError } from "../http.js";
import { parseOrgPublicId } from "../ids.js";
import { generateUuid } from "../ids.js";

// Entitlement keys are stable machine identifiers like "feature.custom_domains"
// or "limit.projects". Constrain to a conservative character set so the route
// cannot be abused to smuggle arbitrary strings into downstream logs/queries.
const ENTITLEMENT_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const ENTITLEMENT_KEY_MAX = 128;

interface ParsedRequest {
  publicOrgId: string;
  orgId: string;
  entitlementKey: string;
}

/**
 * Implicit free-tier baseline ("default plan") entitlements.
 *
 * Per `specs/components/11-billing.md` ("Plans drive entitlement defaults") and
 * `specs/core/product-overview.md` (create-project is a REQUIRED bootstrap flow that
 * "must not be required for the basic SaaS bootstrap flows to work"), an org
 * with no explicit subscription/override must still be able to perform the
 * baseline bootstrap actions. Billing has no subscription-creation write path
 * yet, so without this baseline every brand-new org is permanently blocked from
 * creating its first project/environment/invite.
 *
 * These defaults apply ONLY when no explicit entitlement row exists for the
 * (org, key). An explicit row — including an `enabled:false` row or a
 * subscription/override limit — always takes precedence (it is returned by
 * `getEntitlement` before this map is consulted). Keys NOT listed here keep the
 * deny-by-default `not_configured` posture (e.g. paid `feature.*` flags).
 *
 * `limitValue: null` would mean unlimited; finite values give a sane free cap.
 *
 * Task 0128 (B11) makes the free tier a REAL plan: org bootstrap now assigns the
 * `free` plan and materializes these same keys into `billing_entitlements`
 * rows, so this map is normally never consulted. It is retained as a
 * **last-resort safety net** so a transient plan-assignment failure during
 * bootstrap can't hard-block the REQUIRED create-project/environment/invite
 * flows. The values are kept >= the free plan's so the net never grants more
 * than the plan. Remove this map only once bootstrap assignment is proven
 * reliable end-to-end (and a backfill covers any pre-0128 orgs).
 */
const DEFAULT_TIER_ENTITLEMENTS: Record<string, number> = {
  "limit.projects": 3,
  "limit.environments": 3,
  "limit.members": 5,
  // saas-integrations D4 default recommendation (activation-friendly,
  // Vercel-style): GitHub integration available on the default tier with one
  // repo link. Catalog rows override these the moment plans configure them.
  "feature.integrations.github": 1,
  "limit.repo_links": 1,
};


export function parseCheckEntitlementBody(
  body: unknown,
): ParsedRequest | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "request body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  const rawOrgId = obj.orgId;
  const rawKey = obj.entitlementKey;
  if (typeof rawOrgId !== "string" || rawOrgId.length === 0) {
    return { error: "orgId is required" };
  }
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    return { error: "entitlementKey is required" };
  }
  if (rawKey.length > ENTITLEMENT_KEY_MAX) {
    return { error: "entitlementKey is too long" };
  }
  if (!ENTITLEMENT_KEY_RE.test(rawKey)) {
    return { error: "entitlementKey is malformed" };
  }
  const orgId = parseOrgPublicId(rawOrgId);
  if (!orgId) {
    return { error: "orgId is malformed" };
  }
  return { publicOrgId: rawOrgId, orgId, entitlementKey: rawKey };
}

export type DecideEntitlementOutcome =
  | { kind: "decision"; body: CheckBillingEntitlementResponse }
  | { kind: "repo_error" };

/**
 * Pure decision logic over a billing repository. Exposed for unit-testing.
 *
 * - Found + enabled → allowed decision with safe entitlement details.
 * - Found + disabled → denied with reason 'disabled'.
 * - Missing (not_found) → denied with reason 'not_configured' (fail-closed,
 *   but as a domain-negative success, NOT an internal error).
 * - Any other repo error → repo_error sentinel for caller to surface as 5xx.
 */
export async function decideEntitlement(
  repo: Pick<BillingRepository, "getEntitlement">,
  parsed: ParsedRequest,
): Promise<DecideEntitlementOutcome> {
  const result = await repo.getEntitlement(parsed.orgId, parsed.entitlementKey);

  if (!result.ok) {
    if (result.error.kind === "not_found") {
      // No explicit entitlement row. Fall back to the implicit free-tier
      // baseline for bootstrap-critical limit keys so a brand-new org can
      // create its first project/environment/invite; all other keys keep the
      // deny-by-default `not_configured` posture.
      const defaultLimit = DEFAULT_TIER_ENTITLEMENTS[parsed.entitlementKey];
      if (defaultLimit !== undefined) {
        return {
          kind: "decision",
          body: {
            allowed: true,
            orgId: parsed.publicOrgId,
            entitlementKey: parsed.entitlementKey,
            valueType: "quantity",
            limitValue: defaultLimit,
            source: "plan",
            subscriptionId: null,
          },
        };
      }
      return {
        kind: "decision",
        body: {
          allowed: false,
          orgId: parsed.publicOrgId,
          entitlementKey: parsed.entitlementKey,
          reason: "not_configured",
        },
      };
    }
    return { kind: "repo_error" };
  }

  const entitlement = result.value;
  if (!entitlement.enabled) {
    return {
      kind: "decision",
      body: {
        allowed: false,
        orgId: parsed.publicOrgId,
        entitlementKey: parsed.entitlementKey,
        reason: "disabled",
      },
    };
  }

  return {
    kind: "decision",
    body: {
      allowed: true,
      orgId: parsed.publicOrgId,
      entitlementKey: parsed.entitlementKey,
      valueType: entitlement.valueType,
      limitValue: entitlement.limitValue,
      source: entitlement.source,
      subscriptionId: entitlement.subscriptionId,
    },
  };
}

export interface CheckEntitlementDeps {
  repoFactory?: (env: Env) => Pick<BillingRepository, "getEntitlement">;
  // Best-effort decision-observation recorder. Injected for unit-testing the
  // emission seam without a DB. When omitted, production uses the D1
  // executor + billing_entitlement_decision_observations.
  recorderFactory?: (
    env: Env,
  ) => Pick<EntitlementDecisionRepository, "recordDecisionObservation">;
  now?: () => Date;
  generateId?: () => string;
}


/**
 * Emit a counts-only observation for a produced entitlement decision.
 *
 * BEST-EFFORT + NON-BLOCKING by contract: any failure (recorder throws, DB
 * down, validation) is swallowed here so it can NEVER change the entitlement
 * response returned to the caller. Counts only — orgId + entitlementKey +
 * outcome (+ denial reason). Never limit values, subscription IDs, source, or
 * any provider/secret material.
 */
async function recordDecisionObservation(
  recorder: Pick<EntitlementDecisionRepository, "recordDecisionObservation">,
  parsed: ParsedRequest,
  decision: CheckBillingEntitlementResponse,
  occurredAt: Date,
  genId: () => string,
): Promise<void> {
  try {
    if (decision.allowed) {
      await recorder.recordDecisionObservation({
        id: genId(),
        orgId: parsed.orgId,
        entitlementKey: parsed.entitlementKey,
        outcome: "allowed",
        denialReason: null,
        occurredAt,
      });
    } else {
      await recorder.recordDecisionObservation({
        id: genId(),
        orgId: parsed.orgId,
        entitlementKey: parsed.entitlementKey,
        outcome: "denied",
        denialReason: decision.reason,
        occurredAt,
      });
    }
  } catch {
    // Swallow — the observation is a pure side-effect. The entitlement decision
    // has already been computed and is returned unchanged regardless.
  }
}

export async function handleCheckEntitlement(
  request: Request,
  env: Env,
  requestId: string,
  deps: CheckEntitlementDeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationError(requestId, "request body is not valid JSON");
  }

  const parsed = parseCheckEntitlementBody(payload);
  if ("error" in parsed) {
    return validationError(requestId, parsed.error);
  }

  // PERF3 (task 0132): when not injected, the repo and the decision-observation
  // recorder share ONE executor (connection) per request instead of opening two
  // separate D1 executors.
  let sharedExecutor: ReturnType<typeof createSqlExecutor> | null = null;
  const getSharedExecutor = () => {
    if (!sharedExecutor) sharedExecutor = createSqlExecutor(env.PLATFORM_DB!);
    return sharedExecutor;
  };

  const repo = deps.repoFactory
    ? deps.repoFactory(env)
    : createBillingRepository(getSharedExecutor());
  const outcome = await decideEntitlement(repo, parsed);

  if (outcome.kind === "repo_error") {
    return errorResponse("internal_error", "Failed to check entitlement", 503, requestId);
  }

  // Best-effort, non-blocking decision observation. A recording failure must
  // NOT change the response — recordDecisionObservation swallows all errors.
  const recorder = deps.recorderFactory
    ? deps.recorderFactory(env)
    : createEntitlementDecisionRepository(getSharedExecutor());
  const now = deps.now ? deps.now() : new Date();
  const genId = deps.generateId ?? generateUuid;
  await recordDecisionObservation(recorder, parsed, outcome.body, now, genId);

  return successResponse(outcome.body, requestId);
}

// Re-export the request type so the router/tests can reference the canonical
// contract shape without reaching across packages directly.
export type { CheckBillingEntitlementRequest };
