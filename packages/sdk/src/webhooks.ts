import type {
  CreateWebhookEndpointRequest,
  CreateWebhookEndpointResponse,
  CreateWebhookSubscriptionRequest,
  CreateWebhookSubscriptionResponse,
  DeleteWebhookEndpointResponse,
  DeleteWebhookSubscriptionResponse,
  DisableWebhookEndpointRequest,
  DisableWebhookEndpointResponse,
  EnableWebhookEndpointRequest,
  EnableWebhookEndpointResponse,
  GetWebhookDeliveryAttemptResponse,
  GetWebhookEndpointResponse,
  GetWebhookSubscriptionResponse,
  ListWebhookDeliveryAttemptsResponse,
  ListWebhookEndpointsResponse,
  ListWebhookSubscriptionsResponse,
  PublicWebhookDeliveryAttempt,
  ReplayWebhookDeliveryResponse,
  RotateWebhookSecretResponse,
  UpdateWebhookEndpointRequest,
  UpdateWebhookEndpointResponse,
  UpdateWebhookSubscriptionRequest,
  UpdateWebhookSubscriptionResponse,
} from "@saas/contracts/webhooks";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Cursor-pagination query for the delivery-attempts list. Both fields are
 * optional and map 1:1 to the only two query params the webhooks-worker
 * `parsePageParams` reads (`limit` 1–100 default 50, opaque `cursor`).
 *
 * `cursor` is the server-issued continuation token surfaced on the previous
 * page's `meta.cursor` (an opaque base64 string — callers MUST NOT construct
 * or parse it). Pass it back verbatim to fetch the next page.
 */
export interface ListDeliveryAttemptsQuery {
  /** Page size, 1–100. Server defaults to 50 when omitted. */
  limit?: number;
  /** Opaque continuation cursor from the previous page's `meta.cursor`. */
  cursor?: string;
}

/**
 * Single page of delivery attempts plus the server-issued continuation
 * cursor. `nextCursor` is `null` when there are no further pages, mirroring
 * the api-edge `meta.cursor` field exactly (same shape as
 * `EventsClient.listAuditEntriesPage`).
 */
export interface DeliveryAttemptsPage {
  deliveryAttempts: ReadonlyArray<PublicWebhookDeliveryAttempt>;
  nextCursor: string | null;
}

/**
 * Webhooks resource client.
 *
 * Backed by `apps/webhooks-worker` via the api-edge `webhooks-facade`. The
 * facade exposes both an org-scoped surface and a project-scoped surface for
 * endpoint listing/creation; subscriptions and delivery attempts are
 * org-scoped only.
 */
export class WebhooksClient {
  constructor(private readonly transport: Transport) {}

  // -------------------------------------------------------------------------
  // Endpoints — org scope
  // -------------------------------------------------------------------------

  /** GET /v1/organizations/:orgId/webhooks/endpoints */
  listEndpoints(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<ListWebhookEndpointsResponse> {
    return this.transport.request<ListWebhookEndpointsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/endpoints`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/projects/:projectId/webhooks/endpoints */
  listProjectEndpoints(
    orgId: string,
    projectId: string,
    opts: RequestOptions = {},
  ): Promise<ListWebhookEndpointsResponse> {
    return this.transport.request<ListWebhookEndpointsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/webhooks/endpoints`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/webhooks/endpoints/:endpointId */
  getEndpoint(
    orgId: string,
    endpointId: string,
    opts: RequestOptions = {},
  ): Promise<GetWebhookEndpointResponse> {
    return this.transport.request<GetWebhookEndpointResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/endpoints/${encodeURIComponent(endpointId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/webhooks/endpoints
   *
   * Pass `idempotencyKey` in `opts` for safe retry semantics.
   */
  createEndpoint(
    orgId: string,
    body: CreateWebhookEndpointRequest,
    opts: RequestOptions = {},
  ): Promise<CreateWebhookEndpointResponse> {
    return this.transport.request<CreateWebhookEndpointResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/endpoints`,
        body,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/projects/:projectId/webhooks/endpoints
   *
   * Project-scoped endpoint creation. Pass `idempotencyKey` for retry safety.
   */
  createProjectEndpoint(
    orgId: string,
    projectId: string,
    body: CreateWebhookEndpointRequest,
    opts: RequestOptions = {},
  ): Promise<CreateWebhookEndpointResponse> {
    return this.transport.request<CreateWebhookEndpointResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/webhooks/endpoints`,
        body,
      },
      opts,
    );
  }

  /** PATCH /v1/organizations/:orgId/webhooks/endpoints/:endpointId */
  updateEndpoint(
    orgId: string,
    endpointId: string,
    body: UpdateWebhookEndpointRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateWebhookEndpointResponse> {
    return this.transport.request<UpdateWebhookEndpointResponse>(
      {
        method: "PATCH",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/endpoints/${encodeURIComponent(endpointId)}`,
        body,
      },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/webhooks/endpoints/:endpointId/disable */
  disableEndpoint(
    orgId: string,
    endpointId: string,
    body: DisableWebhookEndpointRequest = {},
    opts: RequestOptions = {},
  ): Promise<DisableWebhookEndpointResponse> {
    return this.transport.request<DisableWebhookEndpointResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/endpoints/${encodeURIComponent(endpointId)}/disable`,
        body,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/webhooks/endpoints/:endpointId/enable
   *
   * Re-enable a disabled webhook endpoint. Body is empty (the contract
   * carries no fields). Pass `idempotencyKey` in `opts` for retry safety.
   * The worker returns the public endpoint envelope on success and a
   * standard `not_found` envelope when the endpoint is already active or
   * missing.
   */
  enableEndpoint(
    orgId: string,
    endpointId: string,
    body: EnableWebhookEndpointRequest = {},
    opts: RequestOptions = {},
  ): Promise<EnableWebhookEndpointResponse> {
    return this.transport.request<EnableWebhookEndpointResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/endpoints/${encodeURIComponent(endpointId)}/enable`,
        body,
      },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/webhooks/endpoints/:endpointId */
  deleteEndpoint(
    orgId: string,
    endpointId: string,
    opts: RequestOptions = {},
  ): Promise<DeleteWebhookEndpointResponse> {
    return this.transport.request<DeleteWebhookEndpointResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/endpoints/${encodeURIComponent(endpointId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/webhooks/endpoints/:endpointId/rotate-secret
   *
   * Bumps the endpoint's `secretVersion`. The new secret material is delivered
   * out-of-band via the worker — the response carries only metadata.
   */
  rotateSecret(
    orgId: string,
    endpointId: string,
    opts: RequestOptions = {},
  ): Promise<RotateWebhookSecretResponse> {
    return this.transport.request<RotateWebhookSecretResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/endpoints/${encodeURIComponent(endpointId)}/rotate-secret`,
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Subscriptions — org scope
  // -------------------------------------------------------------------------

  /** GET /v1/organizations/:orgId/webhooks/subscriptions */
  listSubscriptions(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<ListWebhookSubscriptionsResponse> {
    return this.transport.request<ListWebhookSubscriptionsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/subscriptions`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/webhooks/subscriptions/:subscriptionId */
  getSubscription(
    orgId: string,
    subscriptionId: string,
    opts: RequestOptions = {},
  ): Promise<GetWebhookSubscriptionResponse> {
    return this.transport.request<GetWebhookSubscriptionResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/webhooks/subscriptions
   *
   * Pass `idempotencyKey` in `opts` for safe retry semantics.
   */
  createSubscription(
    orgId: string,
    body: CreateWebhookSubscriptionRequest,
    opts: RequestOptions = {},
  ): Promise<CreateWebhookSubscriptionResponse> {
    return this.transport.request<CreateWebhookSubscriptionResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/subscriptions`,
        body,
      },
      opts,
    );
  }

  /** PATCH /v1/organizations/:orgId/webhooks/subscriptions/:subscriptionId */
  updateSubscription(
    orgId: string,
    subscriptionId: string,
    body: UpdateWebhookSubscriptionRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateWebhookSubscriptionResponse> {
    return this.transport.request<UpdateWebhookSubscriptionResponse>(
      {
        method: "PATCH",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
        body,
      },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/webhooks/subscriptions/:subscriptionId */
  deleteSubscription(
    orgId: string,
    subscriptionId: string,
    opts: RequestOptions = {},
  ): Promise<DeleteWebhookSubscriptionResponse> {
    return this.transport.request<DeleteWebhookSubscriptionResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Delivery attempts
  // -------------------------------------------------------------------------

  /**
   * GET /v1/organizations/:orgId/webhooks/endpoints/:endpointId/delivery-attempts
   *
   * Threads optional `limit`/`cursor` query params through to the worker
   * (`parsePageParams` reads ONLY these two). Returns the contract `data`
   * payload. The continuation cursor lives on `meta.cursor`, NOT in this
   * body — use {@link listDeliveryAttemptsPage} when you need to paginate.
   */
  listDeliveryAttempts(
    orgId: string,
    endpointId: string,
    query: ListDeliveryAttemptsQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListWebhookDeliveryAttemptsResponse> {
    return this.transport.request<ListWebhookDeliveryAttemptsResponse>(
      buildDeliveryAttemptsRequest(orgId, endpointId, query),
      opts,
    );
  }

  /**
   * Single-page delivery-attempts fetch that also exposes the server-issued
   * continuation cursor (`meta.cursor`). Use this to drive a paginated UI:
   * the returned `nextCursor` is `null` when there are no further pages, and
   * otherwise an opaque token to pass back as `query.cursor` for the next
   * call. Mirrors `EventsClient.listAuditEntriesPage`.
   */
  async listDeliveryAttemptsPage(
    orgId: string,
    endpointId: string,
    query: ListDeliveryAttemptsQuery = {},
    opts: RequestOptions = {},
  ): Promise<DeliveryAttemptsPage> {
    const { data, meta } =
      await this.transport.requestWithEnvelope<ListWebhookDeliveryAttemptsResponse>(
        buildDeliveryAttemptsRequest(orgId, endpointId, query),
        opts,
      );
    return {
      deliveryAttempts: data.deliveryAttempts,
      nextCursor: meta.cursor ?? null,
    };
  }

  /** GET /v1/organizations/:orgId/webhooks/delivery-attempts/:attemptId */
  getDeliveryAttempt(
    orgId: string,
    attemptId: string,
    opts: RequestOptions = {},
  ): Promise<GetWebhookDeliveryAttemptResponse> {
    return this.transport.request<GetWebhookDeliveryAttemptResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/delivery-attempts/${encodeURIComponent(attemptId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/webhooks/delivery-attempts/:attemptId/replay
   *
   * Manually replay a past delivery attempt — re-send the same event to the
   * same endpoint through the existing signing/delivery seam. Creates and
   * returns a NEW delivery attempt (fresh id, `attemptNumber` 1) carrying its
   * post-delivery status; the original attempt is unchanged. Empty body. 404
   * if the attempt is missing or belongs to another org.
   */
  replayDelivery(
    orgId: string,
    attemptId: string,
    opts: RequestOptions = {},
  ): Promise<ReplayWebhookDeliveryResponse> {
    return this.transport.request<ReplayWebhookDeliveryResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/delivery-attempts/${encodeURIComponent(attemptId)}/replay`,
        body: {},
      },
      opts,
    );
  }
}

/**
 * Build the GET request for the delivery-attempts list, threading the
 * optional `limit`/`cursor` query params (omitting `undefined` so the URL
 * builder never emits an empty `key=`). Shared by `listDeliveryAttempts`
 * and `listDeliveryAttemptsPage` so the wire shape stays in lock-step.
 */
function buildDeliveryAttemptsRequest(
  orgId: string,
  endpointId: string,
  query: ListDeliveryAttemptsQuery,
): {
  method: "GET";
  path: string;
  query: Record<string, string | number | undefined>;
} {
  const params: Record<string, string | number | undefined> = {};
  if (query.limit !== undefined) params.limit = query.limit;
  if (query.cursor !== undefined) params.cursor = query.cursor;
  return {
    method: "GET",
    path: `/v1/organizations/${encodeURIComponent(orgId)}/webhooks/endpoints/${encodeURIComponent(endpointId)}/delivery-attempts`,
    query: params,
  };
}
