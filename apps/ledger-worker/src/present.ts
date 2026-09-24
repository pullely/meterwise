import { formatPricePerMtok, formatUsd, type PublicLlmEvent, type PublicModelPrice, type PublicPriceVersion } from "@saas/contracts/ledger";
import type { LedgerEvent, ModelPrice, PriceVersion } from "@saas/db/ledger";
import { eventPublicId } from "./ids.js";

export function toPublicEvent(e: LedgerEvent): PublicLlmEvent {
  return {
    id: eventPublicId(e.id),
    eventId: e.eventKey,
    tenant: e.tenant,
    feature: e.feature,
    user: e.endUser,
    provider: e.provider,
    model: e.model,
    pricedModel: e.pricedModel,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    latencyMs: e.latencyMs,
    occurredAt: e.occurredAt,
    receivedAt: e.receivedAt,
    priceStatus: e.priceStatus,
    priceVersion: e.priceVersion,
    inputPriceMicrosPerMtok: e.inputPriceMicros,
    outputPriceMicrosPerMtok: e.outputPriceMicros,
    costNanoUsd: e.costNanoUsd,
    costUsd: e.costNanoUsd === null ? null : formatUsd(e.costNanoUsd),
    source: e.source,
  };
}

export function toPublicVersion(v: PriceVersion): PublicPriceVersion {
  return { version: v.version, effectiveFrom: v.effectiveFrom, publishedOn: v.publishedOn, description: v.description };
}

export function toPublicPrice(p: ModelPrice): PublicModelPrice {
  return {
    provider: p.provider,
    model: p.model,
    displayName: p.displayName,
    inputMicrosPerMtok: p.inputMicrosPerMtok,
    outputMicrosPerMtok: p.outputMicrosPerMtok,
    inputPerMtok: formatPricePerMtok(p.inputMicrosPerMtok),
    outputPerMtok: formatPricePerMtok(p.outputMicrosPerMtok),
    sourceUrl: p.sourceUrl,
    checkedOn: p.checkedOn,
  };
}
