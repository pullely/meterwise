export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  ENVIRONMENT: string;

  // ── Billing provider (epic saas-multi-org-billing / billing-provider-abstraction)
  // Non-secret values come from wrangler `vars`; secrets are set per-env with
  // `wrangler secret put …` and are NEVER committed here, in the DB, or in logs.
  /** Active provider: "polar" (default) | "stripe". */
  BILLING_PROVIDER?: string;
  /** Polar API target: "sandbox" | "production". */
  POLAR_SERVER?: string;
  /** Secret — Polar organization access token. */
  POLAR_ACCESS_TOKEN?: string;
  /** Secret — Polar webhook signing secret (Standard Webhooks, base64). */
  POLAR_WEBHOOK_SECRET?: string;
  /** JSON map of plan code → opaque Polar product id, e.g. {"pro":"…","business":"…"}. */
  POLAR_PRODUCT_MAP?: string;
  /** Base URL the provider returns the buyer to after checkout. */
  POLAR_SUCCESS_URL?: string;
}
