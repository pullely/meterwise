export interface PriceVersion {
  version: string;
  effectiveFrom: string;
  publishedOn: string;
  description: string;
}

export interface ModelPrice {
  version: string;
  provider: string;
  model: string;
  displayName: string;
  inputMicrosPerMtok: number;
  outputMicrosPerMtok: number;
  sourceUrl: string;
  checkedOn: string;
}

export type LedgerPriceStatus = "priced" | "unknown_model" | "before_price_table";

export interface LedgerEvent {
  id: string;
  orgId: string;
  eventKey: string;
  fingerprint: string;
  tenant: string;
  feature: string | null;
  endUser: string | null;
  provider: string;
  model: string;
  pricedModel: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number | null;
  occurredAt: string;
  receivedAt: string;
  priceStatus: LedgerPriceStatus;
  priceVersion: string | null;
  inputPriceMicros: number | null;
  outputPriceMicros: number | null;
  costNanoUsd: number | null;
  source: "sdk" | "proxy";
  recordedBy: string | null;
}

/** Everything but the database defaults. */
export type NewLedgerEvent = LedgerEvent;

export type CostGroupBy = "tenant" | "feature" | "model" | "provider" | "user";

export interface CostAggregateRow {
  /** tenant/feature/end_user/provider value, or for "model" the model (provider in `provider`). */
  key: string | null;
  provider: string | null;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: number;
  unpricedEvents: number;
  avgLatencyMs: number | null;
}

export interface ListEventsFilter {
  tenant?: string;
  feature?: string;
  model?: string;
  /** Rows strictly after this (received_at, id) position in newest-first order (paging). */
  before?: { at: string; id: string };
  limit: number;
}

export interface LedgerRepository {
  listPriceVersions(): Promise<PriceVersion[]>;
  listModelPrices(version: string): Promise<ModelPrice[]>;
  /**
   * Claim (org_id, event_key) and store the event in ONE statement:
   * INSERT … ON CONFLICT DO NOTHING RETURNING id. Returns the new id, or null
   * when the key is already taken (a retry or a collision; the caller reads
   * the stored row to tell which). Never branches on rowCount (trap 22).
   */
  claimEvent(event: NewLedgerEvent): Promise<string | null>;
  getEventByKey(orgId: string, eventKey: string): Promise<LedgerEvent | null>;
  listEvents(orgId: string, filter: ListEventsFilter): Promise<LedgerEvent[]>;
  /** GROUP BY over [fromIso, toIso). Ordered by cost, then events, descending. */
  aggregateCosts(
    orgId: string,
    by: CostGroupBy,
    fromIso: string,
    toIso: string,
    tenant?: string,
  ): Promise<CostAggregateRow[]>;
  /** The distinct price versions that priced events in [fromIso, toIso). */
  priceVersionsUsed(orgId: string, fromIso: string, toIso: string, tenant?: string): Promise<string[]>;
}
