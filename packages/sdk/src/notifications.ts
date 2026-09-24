import type {
  EnqueueNotificationRequest,
  EnqueueNotificationResponse,
  GetNotificationResponse,
  GetNotificationPreferencesQuery,
  GetNotificationPreferencesResponse,
  SuppressRecipientRequest,
  SuppressRecipientResponse,
  UpdateNotificationPreferencesRequest,
  UpdateNotificationPreferencesResponse,
} from "@saas/contracts/notifications";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Notifications resource client.
 *
 * Backed by `apps/notifications-worker`. NOTE: per spec 14 the V1 surface is
 * service-binding-internal — there is intentionally no public `api-edge`
 * facade. The worker enforces this by requiring the `x-internal-actor`,
 * `x-actor-subject-id`, and `x-actor-subject-type` headers on every request.
 *
 * This SDK exposes the typed shape so internal callers (other workers, the
 * Meterwise backplane gateway, the CLI's privileged internal mode) can hit
 * the worker over a service binding with the correct headers passed via
 * `opts.headers`. External consumers MUST NOT receive this client wired to a
 * public base URL.
 */
export class NotificationsClient {
  constructor(private readonly transport: Transport) {}

  /**
   * POST /v1/notifications
   *
   * Enqueue a transactional notification. Pass `idempotencyKey` in `opts` for
   * safe retry semantics; the request body also carries an optional
   * `idempotencyKey` field that the worker uses for content-level dedupe.
   */
  enqueue(
    body: EnqueueNotificationRequest,
    opts: RequestOptions = {},
  ): Promise<EnqueueNotificationResponse> {
    return this.transport.request<EnqueueNotificationResponse>(
      { method: "POST", path: "/v1/notifications", body },
      opts,
    );
  }

  /** GET /v1/notifications/:notificationId */
  get(
    notificationId: string,
    opts: RequestOptions = {},
  ): Promise<GetNotificationResponse> {
    return this.transport.request<GetNotificationResponse>(
      {
        method: "GET",
        path: `/v1/notifications/${encodeURIComponent(notificationId)}`,
      },
      opts,
    );
  }

  /**
   * GET /v1/notifications/preferences
   *
   * Reads per-subject preferences. The worker scopes by the
   * `x-actor-subject-id` / `x-actor-subject-type` headers; the `query`
   * argument is reserved for forward compatibility (channel filter etc.) and
   * is sent as query-string parameters.
   */
  getPreferences(
    query: Partial<GetNotificationPreferencesQuery> = {},
    opts: RequestOptions = {},
  ): Promise<GetNotificationPreferencesResponse> {
    const params: Record<string, string> = {};
    if (query.orgId) params.orgId = query.orgId;
    if (query.subjectKind) params.subjectKind = query.subjectKind;
    if (query.subjectId) params.subjectId = query.subjectId;
    if (query.channel) params.channel = query.channel;
    return this.transport.request<GetNotificationPreferencesResponse>(
      { method: "GET", path: "/v1/notifications/preferences", query: params },
      opts,
    );
  }

  /** PUT /v1/notifications/preferences */
  updatePreferences(
    body: UpdateNotificationPreferencesRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateNotificationPreferencesResponse> {
    return this.transport.request<UpdateNotificationPreferencesResponse>(
      { method: "PUT", path: "/v1/notifications/preferences", body },
      opts,
    );
  }

  /**
   * POST /v1/notifications/recipients/:address/suppress
   *
   * Suppress further delivery to a recipient address. The body carries the
   * org id, channel, and reason; the URL slot carries the address verbatim
   * (already URL-encoded by the SDK).
   */
  suppressRecipient(
    address: string,
    body: SuppressRecipientRequest,
    opts: RequestOptions = {},
  ): Promise<SuppressRecipientResponse> {
    return this.transport.request<SuppressRecipientResponse>(
      {
        method: "POST",
        path: `/v1/notifications/recipients/${encodeURIComponent(address)}/suppress`,
        body,
      },
      opts,
    );
  }
}
