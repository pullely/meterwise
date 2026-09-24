import type { Env } from "../env.js";
import type { BillingProviderId, NormalizedEvent } from "./types.js";

/**
 * Pure (SDK-free) Polar helpers: configuration, plan↔product mapping, and the
 * Polar-event → `NormalizedEvent` mapping. Kept free of `@polar-sh/sdk` so this
 * logic is unit-testable in isolation and never pulls the SDK into a test that
 * doesn't need it. The SDK-touching adapter lives in `polar.ts`.
 */

const PROVIDER: BillingProviderId = "polar";

export interface PolarConfig {
  /** Secret — Polar organization access token. */
  accessToken: string;
  /** Polar API target. */
  server: "sandbox" | "production";
  /** Secret — Standard-Webhooks signing secret (base64). */
  webhookSecret: string;
  /** plan code → opaque Polar product id. */
  productMap: Record<string, string>;
  /** Post-checkout return URL base, or null. */
  successUrl: string | null;
}

/** Parse the `POLAR_PRODUCT_MAP` JSON (plan code → product id); tolerant of junk. */
export function parsePolarProductMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [code, id] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof id === "string" && id.length > 0) out[code] = id;
  }
  return out;
}

/** Resolve our plan code from a Polar product id via the configured map. */
export function planCodeForProduct(
  productMap: Record<string, string>,
  productId: string | null,
): string | null {
  if (!productId) return null;
  for (const [code, id] of Object.entries(productMap)) {
    if (id === productId) return code;
  }
  return null;
}

/**
 * Read Polar config from env; `null` when not fully configured (no access token
 * or no webhook secret) so the registry fails closed rather than half-wiring a
 * provider that can't verify webhooks.
 */
export function parsePolarConfig(env: Env): PolarConfig | null {
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim();
  const webhookSecret = env.POLAR_WEBHOOK_SECRET?.trim();
  if (!accessToken || !webhookSecret) return null;
  return {
    accessToken,
    webhookSecret,
    server: env.POLAR_SERVER?.trim() === "production" ? "production" : "sandbox",
    productMap: parsePolarProductMap(env.POLAR_PRODUCT_MAP),
    successUrl: env.POLAR_SUCCESS_URL?.trim() || null,
  };
}

// ── Event mapping ────────────────────────────────────────────

type Data = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}
function cents(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function externalId(data: Data): string | null {
  const customer = (data.customer ?? {}) as Data;
  // `customer.externalId` is the org public id we set as the checkout's
  // externalCustomerId; fall back to `externalCustomerId` if present on data.
  return str(customer.externalId) ?? str(data.externalCustomerId);
}

/**
 * Map a verified, parsed Polar webhook event to the provider-neutral
 * `NormalizedEvent`. `eventId` is the Standard-Webhooks `webhook-id` (the unique
 * delivery id) — the payload body itself carries no event id, so the caller
 * supplies it for idempotent intake. Events we don't act on become `ignored`
 * (still verified) so intake can ack them without special-casing.
 */
export function mapPolarEventToNormalized(
  eventId: string,
  event: { type: string; data: Data },
): NormalizedEvent {
  const data = event.data ?? {};
  const base = { providerEventId: eventId, provider: PROVIDER };

  switch (event.type) {
    case "subscription.created":
    case "subscription.active":
      return { ...base, type: "subscription.activated", ...subscriptionFields(data) };
    case "subscription.updated":
    case "subscription.uncanceled":
    case "subscription.past_due":
      return { ...base, type: "subscription.updated", ...subscriptionFields(data) };
    case "subscription.canceled":
    case "subscription.revoked":
      return { ...base, type: "subscription.canceled", ...subscriptionFields(data) };
    case "order.created":
      return {
        ...base,
        type: "invoice.recorded",
        ...orderFields(data),
        amountDueCents: cents(data.totalAmount),
        amountPaidCents: 0,
      };
    case "order.paid":
      return {
        ...base,
        type: "invoice.paid",
        ...orderFields(data),
        amountDueCents: cents(data.totalAmount),
        amountPaidCents: cents(data.totalAmount),
      };
    default:
      return { ...base, type: "ignored", providerType: event.type };
  }
}

function subscriptionFields(data: Data) {
  return {
    orgId: externalId(data),
    providerCustomerId: str(data.customerId),
    providerSubscriptionId: str(data.id),
    productId: str(data.productId),
    currentPeriodStart: iso(data.currentPeriodStart),
    currentPeriodEnd: iso(data.currentPeriodEnd),
  };
}

function orderFields(data: Data) {
  return {
    orgId: externalId(data),
    providerCustomerId: str(data.customerId),
    providerInvoiceId: str(data.id),
    providerSubscriptionId: str(data.subscriptionId),
    currency: str(data.currency) ?? "usd",
    hostedUrl: null,
  };
}
