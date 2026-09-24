export interface Env {
  PLATFORM_DB?: D1Database;
  POLICY_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
  DEBUG_DELIVERY?: string;
  /** M0 / Solo profile switch — see ./solo-mode.ts. */
  SOLO_MODE?: string;
}
