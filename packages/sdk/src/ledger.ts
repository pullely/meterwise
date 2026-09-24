import type {
  GetLlmCostsResponse,
  GetLlmPricesResponse,
  IngestLlmEventsRequest,
  IngestLlmEventsResponse,
  ListLlmEventsResponse,
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
}
