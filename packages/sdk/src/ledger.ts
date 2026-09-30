import type {
  GetLlmCostsResponse,
  GetLlmPricesResponse,
  IngestLlmEventsRequest,
  IngestLlmEventsResponse,
  ListAlertsResponse,
  ListBudgetsResponse,
  ListLlmEventsResponse,
  LlmCheckRequest,
  LlmCheckResponse,
  PublicBudget,
  PutBudgetRequest,
} from "@saas/contracts/ledger";

import type { RequestOptions, Transport } from "./transport.js";

const org = (orgId: string): string => `/v1/organizations/${encodeURIComponent(orgId)}`;

/**
 * Meterwise ledger client — report LLM calls, read cost per tenant, feature,
 * model, provider or end-user, and read the cited price table. Org-scoped;
 * maps to `apps/ledger-worker` through the api-edge ledger facade.
 *
 * `ingest` is the SDK's reporting call: authenticate the client with an org
 * API key (role `builder`), give every call a stable `eventId` generated
 * before the LLM call, and retry freely — a retried event comes back
 * `duplicate` and is never counted twice.
 */
export class LedgerClient {
  constructor(private readonly transport: Transport) {}

  ingest(orgId: string, body: IngestLlmEventsRequest, opts: RequestOptions = {}): Promise<IngestLlmEventsResponse> {
    return this.transport.request<IngestLlmEventsResponse>({ method: "POST", path: `${org(orgId)}/llm-events`, body }, opts);
  }

  events(
    orgId: string,
    query: { tenant?: string; feature?: string; model?: string; before?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ): Promise<ListLlmEventsResponse> {
    return this.transport.request<ListLlmEventsResponse>({ method: "GET", path: `${org(orgId)}/llm-events`, query }, opts);
  }

  costs(
    orgId: string,
    query: { by?: "tenant" | "feature" | "model" | "provider" | "user"; from?: string; to?: string; tenant?: string } = {},
    opts: RequestOptions = {},
  ): Promise<GetLlmCostsResponse> {
    return this.transport.request<GetLlmCostsResponse>({ method: "GET", path: `${org(orgId)}/llm-costs`, query }, opts);
  }

  prices(orgId: string, query: { version?: string } = {}, opts: RequestOptions = {}): Promise<GetLlmPricesResponse> {
    return this.transport.request<GetLlmPricesResponse>({ method: "GET", path: `${org(orgId)}/llm-prices`, query }, opts);
  }

  // ── MW2: budgets and guardrails ──────────────────────────────

  /**
   * The pre-flight check: call it before an LLM call and act on the answer —
   * `deny` (skip the call), `downgrade` (call `model` instead), `warn` or
   * `allow`. Advisory: it never calls a provider itself.
   */
  check(orgId: string, body: LlmCheckRequest, opts: RequestOptions = {}): Promise<LlmCheckResponse> {
    return this.transport.request<LlmCheckResponse>({ method: "POST", path: `${org(orgId)}/llm-check`, body }, opts);
  }

  budgets(orgId: string, opts: RequestOptions = {}): Promise<ListBudgetsResponse> {
    return this.transport.request<ListBudgetsResponse>({ method: "GET", path: `${org(orgId)}/budgets` }, opts);
  }

  /** Create or replace a tenant's monthly budget; tenant "*" is the org-wide default. */
  putBudget(orgId: string, tenant: string, body: PutBudgetRequest, opts: RequestOptions = {}): Promise<PublicBudget> {
    return this.transport.request<PublicBudget>(
      { method: "PUT", path: `${org(orgId)}/budgets/${encodeURIComponent(tenant)}`, body },
      opts,
    );
  }

  deleteBudget(orgId: string, tenant: string, opts: RequestOptions = {}): Promise<{ removed: PublicBudget }> {
    return this.transport.request<{ removed: PublicBudget }>(
      { method: "DELETE", path: `${org(orgId)}/budgets/${encodeURIComponent(tenant)}` },
      opts,
    );
  }

  alerts(orgId: string, opts: RequestOptions = {}): Promise<ListAlertsResponse> {
    return this.transport.request<ListAlertsResponse>({ method: "GET", path: `${org(orgId)}/alerts` }, opts);
  }
}
