import type { Env } from "../env.js";
import type { SupportActor } from "../support-auth.js";
import type {
  EntitlementDecisionRepository,
  DecisionAggregateBucket,
} from "@saas/db/billing";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createEntitlementDecisionRepository } from "@saas/db/billing";
import { authorizeSupportAction } from "../support-auth.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, orgPublicId, generateSupportActionUuid } from "../ids.js";
import { emitAccessDenied } from "./record-support-action.js";
import type { SupportRequestContext } from "./record-support-action.js";

// Bounded-window read configuration. The aggregation is ALWAYS over a bounded
// time window and a bounded number of distinct groups — no unbounded scan is
// ever reachable through the API.
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 168; // 7 days
const MAX_GROUPS = 200;

// Test seam. When provided, the handler runs against an injected repo (no DB).
export interface ListEntitlementDecisionsDeps {
  decisionRepo: Pick<EntitlementDecisionRepository, "aggregateDecisions">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
}

// Narrow projection: per (entitlementKey, outcome) count, with an optional
// denial-reason breakdown. NEVER exposes limit values, subscription IDs,
// sources, provider payloads, or any secret — the underlying observation rows
// physically cannot carry them (migration 150).
function publicBucket(b: DecisionAggregateBucket): Record<string, unknown> {
  const out: Record<string, unknown> = {
    entitlementKey: b.entitlementKey,
    outcome: b.outcome,
    count: b.count,
  };
  if (b.denialReason !== null) {
    out.denialReason = b.denialReason;
  }
  return out;
}

interface WindowParams {
  windowHours: number;
}

function parseWindowParams(url: URL | undefined): { ok: true; value: WindowParams } | { ok: false; field: string; reason: string } {
  if (!url) return { ok: true, value: { windowHours: DEFAULT_WINDOW_HOURS } };
  const raw = url.searchParams.get("windowHours");
  if (raw === null) return { ok: true, value: { windowHours: DEFAULT_WINDOW_HOURS } };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WINDOW_HOURS) {
    return { ok: false, field: "windowHours", reason: `Must be an integer between 1 and ${MAX_WINDOW_HOURS}` };
  }
  return { ok: true, value: { windowHours: parsed } };
}

export async function handleListEntitlementDecisions(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  targetOrgIdParam: string,
  url?: URL,
  deps?: ListEntitlementDecisionsDeps,
): Promise<Response> {
  const targetOrgUuid = parseOrgPublicId(targetOrgIdParam);
  if (!targetOrgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const genId = deps?.generateId ?? (() => generateSupportActionUuid());

  // Deny-by-default authorization. Reading entitlement-decision observability is
  // itself a support action and must fail closed + audit the denial.
  const decision = authorizeSupportAction({
    actor: ctx.actor,
    supportRoleClaim: ctx.supportRoleClaim,
    systemOverride: ctx.systemOverride,
  });

  if (!decision.allow) {
    const denialActor: SupportActor = ctx.actor ?? { subjectId: "anonymous", subjectType: "user" };
    const denialInput = {
      actor: denialActor,
      targetOrgId: targetOrgUuid,
      attemptedAction: "support.entitlement_decisions.list",
      reason: decision.reason,
      requestId,
      occurredAt: now,
      genId,
    };
    if (deps?.eventsRepo) {
      await emitAccessDenied(env, { ...denialInput, deps: { supportRepo: {} as never, eventsRepo: deps.eventsRepo } });
    } else {
      await emitAccessDenied(env, denialInput);
    }
    return errorResponse("forbidden", "Support action denied", 403, requestId, { reason: decision.reason });
  }

  const windowResult = parseWindowParams(url);
  if (!windowResult.ok) {
    return validationError(requestId, { [windowResult.field]: [windowResult.reason] });
  }
  const since = new Date(now.getTime() - windowResult.value.windowHours * 60 * 60 * 1000);

  const respond = (buckets: DecisionAggregateBucket[]): Response =>
    successResponse(
      {
        orgId: orgPublicId(targetOrgUuid),
        windowHours: windowResult.value.windowHours,
        decisions: buckets.map(publicBucket),
      },
      requestId,
      200,
    );

  // Injected-deps (unit test) path.
  if (deps) {
    const aggResult = await deps.decisionRepo.aggregateDecisions(targetOrgUuid, {
      since,
      until: now,
      maxGroups: MAX_GROUPS,
    });
    if (!aggResult.ok) {
      return errorResponse("internal_error", "Failed to aggregate entitlement decisions", 500, requestId);
    }
    return respond(aggResult.value);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createEntitlementDecisionRepository(executor);
    const aggResult = await repo.aggregateDecisions(targetOrgUuid, {
      since,
      until: now,
      maxGroups: MAX_GROUPS,
    });
    if (!aggResult.ok) {
      return errorResponse("internal_error", "Failed to aggregate entitlement decisions", 500, requestId);
    }
    return respond(aggResult.value);
  } catch {
    return errorResponse("internal_error", "Failed to aggregate entitlement decisions", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
