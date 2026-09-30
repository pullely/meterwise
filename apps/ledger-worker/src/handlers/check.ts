import { budgetPeriod, decideCheck, type LlmCheckResponse } from "@saas/contracts/ledger";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso } from "../context.js";
import { successResponse, validationError } from "../http.js";
import { PriceBook } from "../pricing.js";
import { validateCheckBody } from "../validate.js";
import { invalidJson, readJson, withDb } from "./common.js";

/**
 * POST /v1/organizations/{org}/llm-check (design §4.2, §6): the pre-flight
 * check, answered from the month-to-date rollup (read from D1's primary, so
 * it sees every accepted ingest) plus the caller's estimate for this call,
 * priced at the model's input rate. It never calls a provider and never
 * blocks anything itself; the SDK or the proxy acts on the answer.
 */
export async function handleCheck(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "ledger.ingest", async (db) => {
    const v = validateCheckBody(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    const c = v.value;
    const now = nowIso();
    const period = budgetPeriod(now);
    const spent = (await db.guard.getSpend(orgId, c.tenant, period))?.costNanoUsd ?? 0;
    let estimated = 0;
    if (c.estimatedInputTokens > 0) {
      const priced = await (await PriceBook.load(db.ledger)).price(c.provider, c.model, c.estimatedInputTokens, 0, now);
      estimated = priced.costNanoUsd ?? 0;
    }
    const budget = await db.guard.getEffectiveBudget(orgId, c.tenant);
    const outcome = decideCheck(spent + estimated, budget, c.model);
    const body: LlmCheckResponse = {
      decision: outcome.decision,
      model: outcome.model,
      requestedModel: c.model,
      reason: outcome.reason,
      period,
      spentNanoUsd: spent,
      estimatedNanoUsd: estimated,
      softLimitNanoUsd: budget?.softLimitNanoUsd ?? null,
      hardLimitNanoUsd: budget?.hardLimitNanoUsd ?? null,
      budgetTenant: budget?.tenant ?? null,
    };
    return successResponse(body, requestId);
  });
}
