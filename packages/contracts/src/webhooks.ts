/**
 * Webhook contract types.
 *
 * These types define the public API request/response shapes for webhook
 * endpoint administration, subscriptions, and delivery attempt inspection.
 * No plaintext signing secrets, raw secret material, secret hashes, provider
 * credentials, or full event payload blobs are included.
 */

// ---------------------------------------------------------------------------
// Public Webhook Endpoint
// ---------------------------------------------------------------------------

export interface PublicWebhookEndpoint {
  id: string;
  orgId: string;
  projectId: string | null;
  url: string;
  name: string | null;
  description: string | null;
  status: "active" | "disabled" | "pending";
  disabledReason: string | null;
  disabledAt: string | null;
  /** Signing secret version (monotonic counter). No secret material exposed. */
  secretVersion: number;
  secretLastRotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListWebhookEndpointsResponse {
  endpoints: PublicWebhookEndpoint[];
  nextCursor: { createdAt: string; id: string } | null;
}

export interface GetWebhookEndpointResponse {
  endpoint: PublicWebhookEndpoint;
}

// ---------------------------------------------------------------------------
// Webhook Endpoint Mutation Requests
// ---------------------------------------------------------------------------

export interface CreateWebhookEndpointRequest {
  url: string;
  name?: string | null;
  description?: string | null;
  projectId?: string | null;
}

export interface CreateWebhookEndpointResponse {
  endpoint: PublicWebhookEndpoint;
}

export interface UpdateWebhookEndpointRequest {
  url?: string;
  name?: string | null;
  description?: string | null;
}

export interface UpdateWebhookEndpointResponse {
  endpoint: PublicWebhookEndpoint;
}

export interface DisableWebhookEndpointRequest {
  reason?: string;
}

export interface DisableWebhookEndpointResponse {
  endpoint: PublicWebhookEndpoint;
}

/**
 * Re-enable a previously disabled webhook endpoint. Body is intentionally
 * empty — re-enable is additive and carries no operator-supplied metadata.
 * Idempotency: a 404 is returned if the endpoint is already active or
 * missing (the worker maps the repository `not_found` envelope through
 * unchanged).
 */
export interface EnableWebhookEndpointRequest {
  // No fields. Reserved for future expansion (e.g. opt-in re-arm of
  // delivery retries) under a fresh spec proposal.
}

export interface EnableWebhookEndpointResponse {
  endpoint: PublicWebhookEndpoint;
}

export interface DeleteWebhookEndpointResponse {
  deleted: true;
}

// ---------------------------------------------------------------------------
// Secret Rotation
// ---------------------------------------------------------------------------

/**
 * Response for POST /webhook-endpoints/{id}/rotate-secret.
 *
 * `secret` is a **reveal-once** plaintext signing secret in the form
 * `whsec_<32 hex chars>`. It is generated server-side, encrypted at rest,
 * and returned to the caller exactly once on rotation — never persisted in
 * any log, event payload, audit row, or subsequent read surface. Optional
 * because legacy callers without an active `SECRET_ENCRYPTION_KEY` cannot
 * receive plaintext.
 *
 * `previousSecretExpiresAt` (when present) tells the operator until when the
 * previous signing secret will continue to produce a valid
 * `X-Webhook-Signature-Previous` header on outbound delivery attempts —
 * giving subscribers a grace window to roll over without dropping events.
 *
 * `gracePeriodSeconds` echoes the dual-signature window length applied to
 * this rotation (server default is 86400; operator may override or set 0
 * to disable).
 */
export interface RotateWebhookSecretResponse {
  endpoint: PublicWebhookEndpoint;
  /** Reveal-once plaintext secret. `whsec_<32 hex>`. Never persisted. */
  secret?: string;
  /** ISO timestamp the dual-signature grace window closes at. Null when no grace window was applied. */
  previousSecretExpiresAt: string | null;
  /** Echo of the grace-period window applied to this rotation, in seconds. */
  gracePeriodSeconds: number;
}

// ---------------------------------------------------------------------------
// Public Webhook Subscription
// ---------------------------------------------------------------------------

export interface PublicWebhookSubscription {
  id: string;
  orgId: string;
  endpointId: string;
  projectId: string | null;
  eventType: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListWebhookSubscriptionsResponse {
  subscriptions: PublicWebhookSubscription[];
  nextCursor: { createdAt: string; id: string } | null;
}

export interface GetWebhookSubscriptionResponse {
  subscription: PublicWebhookSubscription;
}

// ---------------------------------------------------------------------------
// Webhook Subscription Mutation Requests
// ---------------------------------------------------------------------------

export interface CreateWebhookSubscriptionRequest {
  endpointId: string;
  eventType: string;
  projectId?: string | null;
  enabled?: boolean;
}

export interface CreateWebhookSubscriptionResponse {
  subscription: PublicWebhookSubscription;
}

export interface UpdateWebhookSubscriptionRequest {
  enabled?: boolean;
}

export interface UpdateWebhookSubscriptionResponse {
  subscription: PublicWebhookSubscription;
}

export interface DeleteWebhookSubscriptionResponse {
  deleted: true;
}

// ---------------------------------------------------------------------------
// Public Webhook Delivery Attempt
// ---------------------------------------------------------------------------

export interface PublicWebhookDeliveryAttempt {
  id: string;
  orgId: string;
  endpointId: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "success" | "failed" | "retrying";
  attemptNumber: number;
  httpStatusCode: number | null;
  /** Safe failure summary — no raw response body or full event payload. */
  failureReason: string | null;
  idempotencyKey: string | null;
  nextRetryAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListWebhookDeliveryAttemptsResponse {
  deliveryAttempts: PublicWebhookDeliveryAttempt[];
  nextCursor: { createdAt: string; id: string } | null;
}

export interface GetWebhookDeliveryAttemptResponse {
  deliveryAttempt: PublicWebhookDeliveryAttempt;
}

/**
 * Manual delivery replay (B5). Re-send the same event to the same endpoint
 * through the existing signing/delivery seam, recording a fresh attempt in
 * history.
 *
 * Request body is intentionally empty — replay carries no operator-supplied
 * metadata; the target attempt is fully identified by the path
 * `:id`. Reserved for future expansion (e.g. a one-shot override URL) under a
 * fresh spec proposal.
 */
export interface ReplayWebhookDeliveryRequest {
  // No fields.
}

/**
 * Response for POST /webhooks/delivery-attempts/{id}/replay.
 *
 * `deliveryAttempt` is the NEWLY-created attempt (fresh id, `attemptNumber` 1),
 * carrying its post-delivery status. The original attempt is unchanged. No
 * secret material or raw event payload is ever included — only the safe public
 * delivery-attempt projection.
 */
export interface ReplayWebhookDeliveryResponse {
  deliveryAttempt: PublicWebhookDeliveryAttempt;
}
