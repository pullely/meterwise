export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** MW2: budget and anomaly alert emails (ledger-worker is on the internal-actor allow-list). */
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
}
