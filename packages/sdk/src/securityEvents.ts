import type {
  PublicSecurityEvent,
  SecurityEventListResponse,
} from "@saas/contracts/security-events";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Cursor-pagination query for the security-events list. Both fields are
 * optional and map 1:1 to the only two query params the identity-worker reads
 * for this surface (`limit` and an opaque `cursor`).
 *
 * `cursor` is the server-issued continuation token surfaced on the previous
 * page's `meta.cursor` (an opaque base64 string — callers MUST NOT construct
 * or parse it). Pass it back verbatim to fetch the next page.
 */
export interface ListSecurityEventsQuery {
  /** Page size. The server clamps to its own bounds when omitted. */
  limit?: number;
  /** Opaque continuation cursor from the previous page's `meta.cursor`. */
  cursor?: string;
}

/**
 * Single page of security events plus the server-issued continuation cursor.
 * `nextCursor` is `null` when there are no further pages, mirroring the
 * api-edge `meta.cursor` field exactly (same shape as
 * `WebhooksClient.listDeliveryAttemptsPage` /
 * `EventsClient.listAuditEntriesPage`).
 */
export interface SecurityEventsPage {
  securityEvents: ReadonlyArray<PublicSecurityEvent>;
  nextCursor: string | null;
}

/**
 * Security Events resource client.
 *
 * The api-edge exposes this surface at `GET /v1/auth/security-events`
 * (note: actor-scoped, not org-scoped — backed by `apps/identity-worker`
 * via the `auth-facade`). Returns the public security-event projection
 * with secrets, codes, and credential material already stripped by the
 * worker.
 */
export class SecurityEventsClient {
  constructor(private readonly transport: Transport) {}

  /**
   * GET /v1/auth/security-events
   *
   * Threads optional `limit`/`cursor` query params through to the worker.
   * Returns the contract `data` payload only — the continuation cursor lives
   * on `meta.cursor`, NOT in this body, so use {@link listPage} when you need
   * to paginate.
   */
  list(
    query: ListSecurityEventsQuery = {},
    opts: RequestOptions = {},
  ): Promise<SecurityEventListResponse> {
    return this.transport.request<SecurityEventListResponse>(
      buildSecurityEventsRequest(query),
      opts,
    );
  }

  /**
   * Single-page security-events fetch that also exposes the server-issued
   * continuation cursor (`meta.cursor`). Use this to drive a paginated UI:
   * the returned `nextCursor` is `null` when there are no further pages, and
   * otherwise an opaque token to pass back as `query.cursor` for the next
   * call. Mirrors `WebhooksClient.listDeliveryAttemptsPage` /
   * `EventsClient.listAuditEntriesPage`.
   */
  async listPage(
    query: ListSecurityEventsQuery = {},
    opts: RequestOptions = {},
  ): Promise<SecurityEventsPage> {
    const { data, meta } =
      await this.transport.requestWithEnvelope<SecurityEventListResponse>(
        buildSecurityEventsRequest(query),
        opts,
      );
    return {
      securityEvents: data.securityEvents,
      nextCursor: meta.cursor ?? null,
    };
  }
}

/**
 * Build the GET request for the security-events list, threading the optional
 * `limit`/`cursor` query params (omitting `undefined` so the URL builder never
 * emits an empty `key=`). Shared by `list` and `listPage` so the wire shape
 * stays in lock-step.
 */
function buildSecurityEventsRequest(query: ListSecurityEventsQuery): {
  method: "GET";
  path: string;
  query: Record<string, string | number | undefined>;
} {
  const params: Record<string, string | number | undefined> = {};
  if (query.limit !== undefined) params.limit = query.limit;
  if (query.cursor !== undefined) params.cursor = query.cursor;
  return {
    method: "GET",
    path: "/v1/auth/security-events",
    query: params,
  };
}
