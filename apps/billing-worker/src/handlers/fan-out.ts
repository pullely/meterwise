import type { Env } from "../env.js";
import type { BillingRepository } from "@saas/db/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, generateUuid } from "../ids.js";

/**
 * Internal, service-binding-only entitlement fan-out (MO3). Copies a billing
 * parent's materialized plan entitlements onto a child org's `(org_id, key)`
 * rows, so a child created under a multi-org account immediately gates on the
 * parent's plan limits (per-org inherited limits, D3). Idempotent: upsert by
 * `(org, key)`. Provider-neutral — no subscription/provider state is touched on
 * the child (child billing reads resolve to the parent via effectiveBillingOrg).
 */

type RepoSlice = Pick<BillingRepository, "listEntitlements" | "upsertEntitlement">;

export interface FanOutDeps {
  repoFactory?: (env: Env) => RepoSlice;
  generateId?: () => string;
}

interface ParsedFanOut {
  parentOrgId: string;
  childOrgId: string;
  parentHex: string;
  childHex: string;
}

export function parseFanOutBody(body: unknown): ParsedFanOut | { error: string } {
  if (!body || typeof body !== "object") return { error: "request body must be a JSON object" };
  const o = body as Record<string, unknown>;
  const parent = o.parentOrgId;
  const child = o.childOrgId;
  if (typeof parent !== "string" || typeof child !== "string") {
    return { error: "parentOrgId and childOrgId are required" };
  }
  const parentHex = parseOrgPublicId(parent);
  const childHex = parseOrgPublicId(child);
  if (!parentHex || !childHex) return { error: "org ids are malformed" };
  if (parentHex === childHex) return { error: "child and parent must differ" };
  return { parentOrgId: parent, childOrgId: child, parentHex, childHex };
}

export async function handleFanOutPlan(
  request: Request,
  env: Env,
  requestId: string,
  deps: FanOutDeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  }
  if (!deps.repoFactory && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationError(requestId, "request body is not valid JSON");
  }
  const parsed = parseFanOutBody(payload);
  if ("error" in parsed) return validationError(requestId, parsed.error);

  const genId = deps.generateId ?? generateUuid;
  const executor = deps.repoFactory ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps.repoFactory ? deps.repoFactory(env) : createBillingRepository(executor!);

    const parentEnts = await repo.listEntitlements({ orgId: parsed.parentHex, source: "plan" });
    if (!parentEnts.ok) {
      return errorResponse("internal_error", "Failed to read parent entitlements", 503, requestId);
    }

    let copied = 0;
    for (const e of parentEnts.value) {
      const r = await repo.upsertEntitlement({
        id: genId(),
        orgId: parsed.childHex,
        entitlementKey: e.entitlementKey,
        valueType: e.valueType,
        enabled: e.enabled,
        limitValue: e.limitValue,
        source: "plan",
      });
      if (!r.ok) {
        return errorResponse("internal_error", "Failed to materialize child entitlements", 503, requestId);
      }
      copied++;
    }

    return successResponse(
      { parentOrgId: parsed.parentOrgId, childOrgId: parsed.childOrgId, entitlementsCopied: copied },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Failed to fan out plan", 503, requestId);
  } finally {
    if (executor && "dispose" in executor && typeof executor.dispose === "function") {
      await executor.dispose();
    }
  }
}
