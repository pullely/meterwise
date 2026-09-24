import type {
  CheckQuotaRequest,
  CheckQuotaResponse,
  GetUsageSummaryRequest,
  GetUsageSummaryResponse,
  IngestUsageBatchRequest,
  IngestUsageBatchResponse,
  ListQuotaViolationsRequest,
  ListQuotaViolationsResponse,
  RecordUsageRequest,
  RecordUsageResponse,
} from "@saas/contracts/metering";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Metering resource client.
 *
 * Org-scoped surface served by `apps/metering-worker` via the api-edge
 * `metering-facade`. The `recordUsage` and `ingestBatch` writes already carry
 * their own per-record idempotency keys in the request body; the transport's
 * `Idempotency-Key` header is still honoured for replay protection at the
 * api-edge layer (caller-owned, Stripe parity).
 */
export class MeteringClient {
  constructor(private readonly transport: Transport) {}

  /**
   * POST /v1/organizations/:orgId/usage
   *
   * Record a single usage event. The body carries its own `idempotencyKey`
   * field that the worker uses for dedupe; you may also pass `idempotencyKey`
   * in `opts` for transport-layer replay safety.
   */
  recordUsage(
    orgId: string,
    body: RecordUsageRequest,
    opts: RequestOptions = {},
  ): Promise<RecordUsageResponse> {
    return this.transport.request<RecordUsageResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/usage`,
        body,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/usage/batch
   *
   * Ingest a batch of usage events; each record returns its own success or
   * error result in the response array.
   */
  ingestUsageBatch(
    orgId: string,
    body: IngestUsageBatchRequest,
    opts: RequestOptions = {},
  ): Promise<IngestUsageBatchResponse> {
    return this.transport.request<IngestUsageBatchResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/usage/batch`,
        body,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/usage/summary */
  getUsageSummary(
    orgId: string,
    query: GetUsageSummaryRequest,
    opts: RequestOptions = {},
  ): Promise<GetUsageSummaryResponse> {
    const params = buildQueryRecord({
      metric: query.metric,
      projectId: query.projectId ?? undefined,
      environmentId: query.environmentId ?? undefined,
      bucketType: query.bucketType,
      startTime: query.startTime,
      endTime: query.endTime,
    });
    return this.transport.request<GetUsageSummaryResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/usage/summary`,
        query: params,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/quotas/check */
  checkQuota(
    orgId: string,
    query: CheckQuotaRequest,
    opts: RequestOptions = {},
  ): Promise<CheckQuotaResponse> {
    const params = buildQueryRecord({
      metric: query.metric,
      projectId: query.projectId,
      environmentId: query.environmentId,
      resourceId: query.resourceId,
    });
    return this.transport.request<CheckQuotaResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/quotas/check`,
        query: params,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/quotas/violations */
  listQuotaViolations(
    orgId: string,
    query: ListQuotaViolationsRequest = {},
    opts: RequestOptions = {},
  ): Promise<ListQuotaViolationsResponse> {
    const params = buildQueryRecord({
      projectId: query.projectId,
      environmentId: query.environmentId,
      resourceId: query.resourceId,
      metric: query.metric,
      limit: query.limit,
      cursor: query.cursor ? JSON.stringify(query.cursor) : undefined,
    });
    return this.transport.request<ListQuotaViolationsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/quotas/violations`,
        query: params,
      },
      opts,
    );
  }
}

/**
 * Strip `undefined`/`null` entries from a query record so the URL builder
 * doesn't emit empty `key=` params.
 */
function buildQueryRecord(
  input: Record<string, string | number | null | undefined>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}
