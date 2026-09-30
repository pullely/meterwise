import { budgetPeriod, formatUsd, type IngestLlmEventsResponse, type IngestResultItem } from "@saas/contracts/ledger";
import type { LedgerEvent } from "@saas/db/ledger";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { nowIso, type Db } from "../context.js";
import { successResponse, validationError } from "../http.js";
import { actorRef, eventPublicId } from "../ids.js";
import { PriceBook, fingerprint, type Pricing } from "../pricing.js";
import { validateIngestBody, type CleanEvent } from "../validate.js";
import { invalidJson, readJson, withDb } from "./common.js";
import { reportTrackedSpend } from "../tracked-spend.js";

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
    let trackedSpend = 0;
    let firstTracked: string | null = null;

    for (const e of v.value) {
      const out = await claimOne(db, book, orgId, e, receivedAt, recordedBy, "sdk", false);
      results.push(out.item);
      if (out.item.status === "accepted") accepted++;
      else if (out.item.status === "duplicate") duplicates++;
      else conflicts++;
      if (out.tracked !== null) {
        trackedSpend += out.tracked.costNanoUsd;
        firstTracked ??= out.tracked.id;
      }
    }
    if (firstTracked !== null) await reportTrackedSpend(db.executor, orgId, firstTracked, trackedSpend, receivedAt);
    const body: IngestLlmEventsResponse = { results, accepted, duplicates, conflicts };
    return successResponse(body, requestId);
  });
}

export interface ClaimOutcome {
  item: IngestResultItem;
  /** The accepted event's id and cost when it was priced (it joined the rollup). */
  tracked: { id: string; costNanoUsd: number } | null;
}

/**
 * Price, claim and roll up ONE validated event (design §3, §1.4). Shared by the
 * SDK's batch ingest and MW3's internal proxy route. `usageIncomplete` (proxy
 * only) records the tokens known so far as `usage_incomplete`, unpriced.
 */
export async function claimOne(
  db: Db,
  book: PriceBook,
  orgId: string,
  e: CleanEvent,
  receivedAt: string,
  recordedBy: string,
  source: LedgerEvent["source"],
  usageIncomplete: boolean,
): Promise<ClaimOutcome> {
  const fp = await fingerprint(e);
  const pricing: Pricing = usageIncomplete
    ? { priceStatus: "usage_incomplete", priceVersion: null, pricedModel: null, inputPriceMicros: null, outputPriceMicros: null, costNanoUsd: null }
    : await book.price(e.provider, e.model, e.inputTokens, e.outputTokens, e.occurredAt);
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
    source,
    recordedBy,
  };
  const claimed = await db.ledger.claimEvent(row);
  if (claimed !== null) {
    // MW2: the month-to-date rollup, one atomic upsert per ACCEPTED priced
    // event — never for a duplicate or a conflict (design §1.4). If this
    // statement is lost after the claim committed, the cron's reconciliation
    // restores the rollup from ledger_events.
    let tracked: ClaimOutcome["tracked"] = null;
    if (row.costNanoUsd !== null) {
      await db.guard.addSpend(orgId, row.tenant, budgetPeriod(row.occurredAt), row.costNanoUsd, receivedAt);
      tracked = { id: claimed, costNanoUsd: row.costNanoUsd };
    }
    return { item: item(e.eventId, "accepted", { ...row, id: claimed }), tracked };
  }
  const existing = await db.ledger.getEventByKey(orgId, e.eventId);
  if (!existing) throw new Error("claim lost but no row"); // → 503; the client retries safely
  return { item: item(e.eventId, existing.fingerprint === fp ? "duplicate" : "conflict", existing), tracked: null };
}
