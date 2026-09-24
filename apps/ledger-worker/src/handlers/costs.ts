import { formatUsd, type CostRow, type GetLlmCostsResponse } from "@saas/contracts/ledger";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso } from "../context.js";
import { successResponse, validationError } from "../http.js";
import { validateCostQuery } from "../validate.js";
import { withDb } from "./common.js";

/**
 * GET /v1/organizations/{org}/llm-costs?by=…&from=…&to=…&tenant=… (design §4.1).
 * A GROUP BY over the org's events in [from, to] (inclusive UTC dates). Costs
 * are sums of the per-event costs stored at ingest, so a price change never
 * rewrites them; unpriced events are counted, never silently dropped.
 */
export async function handleCosts(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "ledger.read", async (db) => {
    const v = validateCostQuery(new URL(request.url).searchParams, new Date(nowIso()));
    if (!v.valid) return validationError(requestId, v.fields);
    const q = v.value;
    const agg = await db.ledger.aggregateCosts(orgId, q.by, q.fromIso, q.toIso, q.tenant);
    const versions = await db.ledger.priceVersionsUsed(orgId, q.fromIso, q.toIso, q.tenant);
    const rows: CostRow[] = agg.map((r) => ({
      key: q.by === "model" ? { provider: r.provider, model: r.key } : { [q.by]: r.key },
      events: r.events,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costNanoUsd: r.costNanoUsd,
      costUsd: formatUsd(r.costNanoUsd),
      unpricedEvents: r.unpricedEvents,
      avgLatencyMs: r.avgLatencyMs,
    }));
    const sum = (k: "events" | "inputTokens" | "outputTokens" | "costNanoUsd" | "unpricedEvents"): number =>
      rows.reduce((acc, r) => acc + r[k], 0);
    const body: GetLlmCostsResponse = {
      by: q.by,
      from: q.from,
      to: q.to,
      currency: "USD",
      rows,
      totals: {
        events: sum("events"),
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        costNanoUsd: sum("costNanoUsd"),
        costUsd: formatUsd(sum("costNanoUsd")),
        unpricedEvents: sum("unpricedEvents"),
      },
      priceVersions: versions,
    };
    return successResponse(body, requestId);
  });
}
