import type { IngestLlmEventsResponse } from "@saas/contracts/ledger";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso } from "../context.js";
import { successResponse, validationError } from "../http.js";
import { actorRef } from "../ids.js";
import { PriceBook } from "../pricing.js";
import { reportTrackedSpend } from "../tracked-spend.js";
import { validateIngestBody } from "../validate.js";
import { invalidJson, readJson, withDb } from "./common.js";
import { claimOne } from "./ingest.js";

/** The only caller of the internal route, named in `x-internal-caller`. */
export const PROXY_CALLER = "proxy-worker";

/**
 * POST /v1/internal/organizations/{org}/proxy-events (MW3, design §7.3).
 *
 * proxy-worker reports one metered call here over its service binding:
 * `{ event, usageComplete }`, where `event` has the shape of one SDK event.
 * The actor is the Meterwise API key's service principal the proxy resolved,
 * and it is authorized exactly like SDK ingest (membership + `ledger.ingest`).
 * Unlike the SDK route the event is stored with `source = 'proxy'`, and a
 * stream that ended without its usage chunk is stored `usage_incomplete`.
 *
 * Unreachable from the internet: ledger-worker has no public hostname, and
 * api-edge's ledger facade forwards only the public routes (never
 * /v1/internal/…). The request carries no customer header of any kind.
 */
export async function handleProxyEvent(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  const body = parsed.body as { event?: unknown; usageComplete?: unknown } | null;
  if (!body || typeof body !== "object" || typeof body.usageComplete !== "boolean") {
    return validationError(requestId, { usageComplete: ["Required: a boolean"] });
  }
  const usageComplete = body.usageComplete;
  return withDb(env, requestId, actor, orgId, "ledger.ingest", async (db) => {
    const now = new Date(nowIso());
    const v = validateIngestBody({ events: [body.event] }, now);
    if (!v.valid) return validationError(requestId, v.fields);
    const receivedAt = now.toISOString();
    const out = await claimOne(db, await PriceBook.load(db.ledger), orgId, v.value[0]!, receivedAt, actorRef(actor.subjectId), "proxy", !usageComplete);
    if (out.tracked) await db.guard.addSpend(orgId, out.tracked.tenant, out.tracked.period, out.tracked.costNanoUsd, receivedAt);
    if (out.tracked) await reportTrackedSpend(db.executor, orgId, out.tracked.id, out.tracked.costNanoUsd, receivedAt);
    const res: IngestLlmEventsResponse = {
      results: [out.item],
      accepted: out.item.status === "accepted" ? 1 : 0,
      duplicates: out.item.status === "duplicate" ? 1 : 0,
      conflicts: out.item.status === "conflict" ? 1 : 0,
    };
    return successResponse(res, requestId);
  });
}
