export interface Env {
  ENVIRONMENT: string;
  /** Resolves the Meterwise API key (x-meterwise-key) — and nothing else. */
  IDENTITY_WORKER?: Fetcher;
  /** The budget check and the proxy's internal ingest route. */
  LEDGER_WORKER?: Fetcher;
  /**
   * STAGE ONLY (and tests): a service binding that stands in for the provider.
   * Absent in prod, where the upstream is the constant in upstream.ts.
   */
  UPSTREAM_OVERRIDE?: Fetcher;
}
