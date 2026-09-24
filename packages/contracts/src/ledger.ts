/**
 * Meterwise ledger contract (MW1): the wire types of LLM-event ingest, cost
 * reads and the price table, and the pricing arithmetic itself as pure
 * functions, so ledger-worker, the SDK and the console compute a cost the same
 * way (design §2).
 *
 * Money is integers, never floats: prices are micro-USD per million tokens,
 * costs are nano-USD. No provider credential, API key or secret appears in
 * any of these shapes.
 */

// ---------------------------------------------------------------------------
// Limits (design §3)
// ---------------------------------------------------------------------------

export const LEDGER_MAX_BATCH = 100;
export const LEDGER_MAX_TOKENS = 10_000_000;
export const LEDGER_MAX_LATENCY_MS = 3_600_000;
/** How far in the future an occurredAt may be (clock skew). */
export const LEDGER_MAX_FUTURE_MS = 5 * 60 * 1000;
/** How old an occurredAt may be: late retries yes, closed months no. */
export const LEDGER_MAX_AGE_DAYS = 35;
export const LEDGER_MAX_WINDOW_DAYS = 366;

export const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const PROVIDER_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

export const COST_DIMENSIONS = ["tenant", "feature", "model", "provider", "user"] as const;
export type CostDimension = (typeof COST_DIMENSIONS)[number];

export const PRICE_STATUSES = ["priced", "unknown_model", "before_price_table"] as const;
export type PriceStatus = (typeof PRICE_STATUSES)[number];

export const INGEST_STATUSES = ["accepted", "duplicate", "conflict"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

// ---------------------------------------------------------------------------
// Pricing arithmetic (design §2.2)
// ---------------------------------------------------------------------------

/**
 * Cost of one call in nano-USD:
 *   round_half_up((inputTokens × inputMicrosPerMtok + outputTokens × outputMicrosPerMtok) / 1000)
 * One token at P micro-USD per million tokens costs P/1000 nano-USD. The
 * product is BigInt, so no input within the limits can overflow, and the one
 * rounding happens once per event.
 */
export function costNanoUsd(
  inputTokens: number,
  outputTokens: number,
  inputMicrosPerMtok: number,
  outputMicrosPerMtok: number,
): number {
  for (const v of [inputTokens, outputTokens, inputMicrosPerMtok, outputMicrosPerMtok]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError("costNanoUsd takes non-negative integers");
  }
  const numerator =
    BigInt(inputTokens) * BigInt(inputMicrosPerMtok) + BigInt(outputTokens) * BigInt(outputMicrosPerMtok);
  const rounded = (numerator * 2n + 1000n) / 2000n; // round half up of numerator / 1000
  return Number(rounded);
}

/** nano-USD → an exact USD decimal string with nine places ("0.003100000"). */
export function formatUsd(nanoUsd: number): string {
  if (!Number.isSafeInteger(nanoUsd)) throw new RangeError("formatUsd takes a safe integer");
  const negative = nanoUsd < 0;
  const digits = String(Math.abs(nanoUsd)).padStart(10, "0");
  const whole = digits.slice(0, -9);
  const frac = digits.slice(-9);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** micro-USD per MTok → "$2.50" style dollars per MTok (at least two decimals). */
export function formatPricePerMtok(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  let frac = String(micros % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `$${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// Model matching (design §2.4)
// ---------------------------------------------------------------------------

const SNAPSHOT_SUFFIX_RE = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/;

export function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * The candidate price-table models for a reported model, in the order to try
 * them: the exact (lower-cased) name, then the name with ONE trailing
 * snapshot suffix (-YYYY-MM-DD or -YYYYMMDD) removed. Never a prefix match:
 * "gpt-4o-audio-preview" must not be priced as "gpt-4o".
 */
export function modelCandidates(model: string): string[] {
  const exact = normalizeModel(model);
  const stripped = exact.replace(SNAPSHOT_SUFFIX_RE, "");
  return stripped !== exact && stripped.length > 0 ? [exact, stripped] : [exact];
}

// ---------------------------------------------------------------------------
// Wire: ingest
// ---------------------------------------------------------------------------

/** One LLM call, reported by the customer's SDK after it returned. */
export interface LlmEventInput {
  /** Client-chosen idempotency key, unique per organization. */
  eventId: string;
  /** The customer's own customer: an opaque string. */
  tenant: string;
  feature?: string | null;
  /** The customer's end-user: an opaque string. */
  user?: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number | null;
  /** ISO-8601; defaults to the time Meterwise receives it. */
  occurredAt?: string | null;
}

export interface IngestLlmEventsRequest {
  events: LlmEventInput[];
}

export interface IngestResultItem {
  eventId: string;
  /** mwe_… — for a conflict, the id of the event that already holds this eventId. */
  id: string;
  status: IngestStatus;
  priceStatus: PriceStatus;
  priceVersion: string | null;
  costNanoUsd: number | null;
  costUsd: string | null;
}

export interface IngestLlmEventsResponse {
  results: IngestResultItem[];
  accepted: number;
  duplicates: number;
  conflicts: number;
}

// ---------------------------------------------------------------------------
// Wire: reads
// ---------------------------------------------------------------------------

export interface PublicLlmEvent {
  id: string;
  eventId: string;
  tenant: string;
  feature: string | null;
  user: string | null;
  provider: string;
  model: string;
  pricedModel: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number | null;
  occurredAt: string;
  receivedAt: string;
  priceStatus: PriceStatus;
  priceVersion: string | null;
  inputPriceMicrosPerMtok: number | null;
  outputPriceMicrosPerMtok: number | null;
  costNanoUsd: number | null;
  costUsd: string | null;
  source: "sdk" | "proxy";
}

export interface ListLlmEventsResponse {
  events: PublicLlmEvent[];
  /** Pass as `before` for the next (older) page; null when there is none. */
  nextBefore: string | null;
}

export interface CostRow {
  /** For by=model: { provider, model }; otherwise { [by]: value } (null = not reported). */
  key: Record<string, string | null>;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: number;
  costUsd: string;
  unpricedEvents: number;
  avgLatencyMs: number | null;
}

export interface CostTotals {
  events: number;
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: number;
  costUsd: string;
  unpricedEvents: number;
}

export interface GetLlmCostsResponse {
  by: CostDimension;
  /** Inclusive UTC dates. */
  from: string;
  to: string;
  currency: "USD";
  rows: CostRow[];
  totals: CostTotals;
  /** The price-table versions that priced the events in the window. */
  priceVersions: string[];
}

export interface PublicPriceVersion {
  version: string;
  effectiveFrom: string;
  publishedOn: string;
  description: string;
}

export interface PublicModelPrice {
  provider: string;
  model: string;
  displayName: string;
  inputMicrosPerMtok: number;
  outputMicrosPerMtok: number;
  /** "$2.50" per million tokens. */
  inputPerMtok: string;
  outputPerMtok: string;
  sourceUrl: string;
  checkedOn: string;
}

export interface GetLlmPricesResponse {
  versions: PublicPriceVersion[];
  version: string | null;
  prices: PublicModelPrice[];
}
