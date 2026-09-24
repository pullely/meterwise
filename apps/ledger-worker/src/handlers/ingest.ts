import { formatUsd, type IngestLlmEventsResponse, type IngestResultItem } from "@saas/contracts/ledger";
import type { LedgerEvent } from "@saas/db/ledger";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso } from "../context.js";
import { successResponse, validationError } from "../http.js";
import { actorRef, eventPublicId } from "../ids.js";
import { PriceBook, fingerprint } from "../pricing.js";
import { validateIngestBody } from "../validate.js";
import { invalidJson, readJson, withDb } from "./common.js";

function item(eventId: string, status: IngestResultItem["status"], e: Pick<LedgerEvent, "id" | "priceStatus" | "priceVersion" | "costNanoUsd">): IngestResultItem {
  return {
    eventId,
    id: eventPublicId(e.id),
    status,
    priceStatus: e.priceStatus,
    priceVersion: e.priceVersion,
    costNanoUsd: e.costNanoUsd,
    costUsd: e.costNanoUsd === null ? null : formatUsd(e.costNanoUsd),
  };
}

/**
 * POST /v1/organizations/{org}/llm-events (design §3). The whole batch is
 * validated first; then each event is claimed with ONE
 * INSERT … ON CONFLICT (org_id, event_key) DO NOTHING RETURNING id. A returned
 * row is `accepted`; no row means the eventId is taken, and the stored row's
 * fingerprint says whether this is a retry (`duplicate`, nothing counted) or a
 * different call reusing the id (`conflict`, first write wins).
 *
 * Deliberately no audit event per ingest: this is telemetry, and the ledger
 * row (with recorded_by) is the record (design §5).
 */
export async function handleIngest(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "ledger.ingest", async (db) => {
    const now = new Date(nowIso());
    const v = validateIngestBody(parsed.body, now);
    if (!v.valid) return validationError(requestId, v.fields);

    const book = await PriceBook.load(db.ledger);
    const receivedAt = now.toISOString();
    const recordedBy = actorRef(actor.subjectId);
    const results: IngestResultItem[] = [];
    let accepted = 0;
    let duplicates = 0;
    let conflicts = 0;

    for (const e of v.value) {
      const fp = await fingerprint(e);
      const pricing = await book.price(e.provider, e.model, e.inputTokens, e.outputTokens, e.occurredAt);
      const row: LedgerEvent = {
        id: crypto.randomUUID(),
        orgId,
        eventKey: e.eventId,
        fingerprint: fp,
        tenant: e.tenant,
        feature: e.feature,
        endUser: e.user,
        provider: e.provider,
        model: e.model,
        pricedModel: pricing.pricedModel,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        latencyMs: e.latencyMs,
        occurredAt: e.occurredAt,
        receivedAt,
        priceStatus: pricing.priceStatus,
        priceVersion: pricing.priceVersion,
        inputPriceMicros: pricing.inputPriceMicros,
        outputPriceMicros: pricing.outputPriceMicros,
        costNanoUsd: pricing.costNanoUsd,
        source: "sdk",
        recordedBy,
      };
      const claimed = await db.ledger.claimEvent(row);
      if (claimed !== null) {
        accepted++;
        results.push(item(e.eventId, "accepted", { ...row, id: claimed }));
        continue;
      }
      const existing = await db.ledger.getEventByKey(orgId, e.eventId);
      if (!existing) throw new Error("claim lost but no row"); // → 503; the client retries safely
      if (existing.fingerprint === fp) {
        duplicates++;
        results.push(item(e.eventId, "duplicate", existing));
      } else {
        conflicts++;
        results.push(item(e.eventId, "conflict", existing));
      }
    }
    const body: IngestLlmEventsResponse = { results, accepted, duplicates, conflicts };
    return successResponse(body, requestId);
  });
}
