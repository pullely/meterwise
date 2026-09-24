import type { Uuid } from "../ids/index.js";

export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";

// ── Result type ─────────────────────────────────────────────

export type WebhookRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type WebhookResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WebhookRepositoryError };

// ── Cursor pagination (matches existing convention) ─────────

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

// ── Webhook endpoints ───────────────────────────────────────
// NOTE: No plaintext signing secret fields. Only safe metadata.

export type WebhookEndpointStatus = "active" | "disabled" | "pending";

export interface WebhookEndpoint {
  id: string;
  orgId: string;
  projectId: string | null;
  url: string;
  name: string | null;
  description: string | null;
  status: WebhookEndpointStatus;
  disabledReason: string | null;
  disabledAt: Date | null;
  secretVersion: number;
  secretLastRotatedAt: Date | null;
  // NOTE: secret_ciphertext is intentionally excluded from the type.
  // It is never exposed through the repository read surface.
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWebhookEndpointInput {
  id: string;
  orgId: Uuid;
  projectId?: Uuid | null;
  url: string;
  name?: string | null;
  description?: string | null;
  /** JSON-serialized ciphertext envelope for signing secret. Write-only — never returned. */
  secretCiphertext?: string;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  name?: string | null;
  description?: string | null;
}

export interface DisableWebhookEndpointInput {
  reason?: string;
}

/**
 * Input for rotateEndpointSecret. The repository copies the current secret
 * into the previous-secret slot, sets the previous-secret expiry to
 * `strftime('%Y-%m-%dT%H:%M:%fZ','now') + gracePeriodSeconds`, and writes the new secret atomically.
 */
export interface RotateEndpointSecretInput {
  /** New encrypted signing-secret envelope. Required for live rotations. */
  secretCiphertext?: string;
  /**
   * Grace-window duration in seconds. When omitted, the previous secret is
   * NOT preserved (legacy / first rotation). When provided, the rotation
   * persists the previous ciphertext + version + an expires_at = now() + N.
   */
  gracePeriodSeconds?: number;
}

/**
 * Result of rotateEndpointSecret. `endpoint` is the safe public-shape view;
 * `previousSecretExpiresAt` is the wall-clock the grace window closes at,
 * needed by the worker handler to populate its reveal-once response.
 */
export interface RotateEndpointSecretResult {
  endpoint: WebhookEndpoint;
  /** Snapshot of secret_version at the moment of rotate (the previous secret's version). Null when no grace window applied. */
  previousSecretVersion: number | null;
  /** ISO timestamp the grace window closes at. Null when no grace window applied. */
  previousSecretExpiresAt: string | null;
}

// ── Webhook subscriptions ───────────────────────────────────

export interface WebhookSubscription {
  id: string;
  orgId: string;
  endpointId: string;
  projectId: string | null;
  eventType: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWebhookSubscriptionInput {
  id: string;
  orgId: Uuid;
  endpointId: string;
  projectId?: Uuid | null;
  eventType: string;
  enabled?: boolean;
}

export interface UpdateWebhookSubscriptionInput {
  enabled?: boolean;
}

// ── Webhook delivery attempts ───────────────────────────────
// NOTE: No full event payloads or customer response bodies.

export type DeliveryAttemptStatus = "pending" | "success" | "failed" | "retrying";

export interface WebhookDeliveryAttempt {
  id: string;
  orgId: string;
  endpointId: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: DeliveryAttemptStatus;
  attemptNumber: number;
  httpStatusCode: number | null;
  failureReason: string | null;
  idempotencyKey: string | null;
  nextRetryAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDeliveryAttemptInput {
  id: string;
  orgId: string;
  endpointId: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  idempotencyKey?: string | null;
}

export interface UpdateDeliveryAttemptInput {
  status: DeliveryAttemptStatus;
  attemptNumber?: number;
  httpStatusCode?: number | null;
  failureReason?: string | null;
  nextRetryAt?: Date | null;
  completedAt?: Date | null;
}

// ── Delivery runtime types ───────────────────────────────────

/** Endpoint data needed for delivery — includes secret_ciphertext for signing */
export interface EndpointForDelivery {
  id: string;
  orgId: string;
  url: string;
  status: WebhookEndpointStatus;
  secretCiphertext: string | null;
  secretVersion: number;
  /** Encrypted previous-secret envelope, populated within the rotation grace window. */
  previousSecretCiphertext: string | null;
  /** Version number of the previous secret (snapshot of secret_version at the moment of rotate). */
  previousSecretVersion: number | null;
  /** ISO timestamp at which the previous-secret grace window closes; null when no previous secret. */
  previousSecretExpiresAt: string | null;
}

/** Subscription matched during fanout */
export interface MatchedSubscription {
  id: string;
  orgId: string;
  endpointId: string;
  projectId: string | null;
  eventType: string;
}

/** Dispatch cursor position */
export interface DispatchCursor {
  orgId: string;
  subscriberLane: string;
  lastEventId: string | null;
  lastOccurredAt: string | null;
  updatedAt: Date;
}

// ── Repository interface ────────────────────────────────────

export interface WebhookRepository {
  // Endpoints
  createEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookResult<WebhookEndpoint>>;
  getEndpoint(orgId: string, endpointId: string): Promise<WebhookResult<WebhookEndpoint>>;
  listEndpoints(orgId: string, params: PageQueryParams, projectId?: string | null): Promise<WebhookResult<PagedResult<WebhookEndpoint>>>;
  updateEndpoint(orgId: string, endpointId: string, input: UpdateWebhookEndpointInput): Promise<WebhookResult<WebhookEndpoint>>;
  disableEndpoint(orgId: string, endpointId: string, input: DisableWebhookEndpointInput): Promise<WebhookResult<WebhookEndpoint>>;
  /**
   * Re-enable a previously disabled endpoint. Sets `status = 'active'`,
   * clears `disabled_reason` and `disabled_at`. Guarded by `WHERE status =
   * 'disabled'` — a 0-row response (`not_found`) covers both "endpoint
   * missing" and "already active". `pending` endpoints are intentionally
   * not re-enabled here (would require a spec proposal).
   */
  enableEndpoint(orgId: string, endpointId: string): Promise<WebhookResult<WebhookEndpoint>>;
  deleteEndpoint(orgId: string, endpointId: string): Promise<WebhookResult<{ deleted: true }>>;
  rotateEndpointSecret(orgId: string, endpointId: string, input?: RotateEndpointSecretInput): Promise<WebhookResult<RotateEndpointSecretResult>>;

  // Subscriptions
  createSubscription(input: CreateWebhookSubscriptionInput): Promise<WebhookResult<WebhookSubscription>>;
  getSubscription(orgId: string, subscriptionId: string): Promise<WebhookResult<WebhookSubscription>>;
  listSubscriptions(orgId: string, endpointId: string, params: PageQueryParams): Promise<WebhookResult<PagedResult<WebhookSubscription>>>;
  updateSubscription(orgId: string, subscriptionId: string, input: UpdateWebhookSubscriptionInput): Promise<WebhookResult<WebhookSubscription>>;
  deleteSubscription(orgId: string, subscriptionId: string): Promise<WebhookResult<{ deleted: true }>>;

  // Delivery attempts
  createDeliveryAttempt(input: CreateDeliveryAttemptInput): Promise<WebhookResult<WebhookDeliveryAttempt>>;
  updateDeliveryAttempt(orgId: string, attemptId: string, input: UpdateDeliveryAttemptInput): Promise<WebhookResult<WebhookDeliveryAttempt>>;
  getDeliveryAttempt(orgId: string, attemptId: string): Promise<WebhookResult<WebhookDeliveryAttempt>>;
  listDeliveryAttempts(orgId: string, endpointId: string, params: PageQueryParams): Promise<WebhookResult<PagedResult<WebhookDeliveryAttempt>>>;

  // Delivery runtime
  getEndpointForDelivery(orgId: string, endpointId: string): Promise<WebhookResult<EndpointForDelivery>>;
  findMatchingSubscriptions(orgId: string, eventType: string): Promise<WebhookResult<MatchedSubscription[]>>;
  listRetryableDeliveries(limit: number): Promise<WebhookResult<WebhookDeliveryAttempt[]>>;

  // Dispatch cursor
  getDispatchCursor(orgId: string, lane?: string): Promise<WebhookResult<DispatchCursor>>;
  advanceDispatchCursor(orgId: string, lastEventId: string, lastOccurredAt: string, lane?: string): Promise<WebhookResult<DispatchCursor>>;
  listActiveOrgIds(): Promise<WebhookResult<string[]>>;

  // Delivery lifecycle
  /**
   * Count consecutive terminal delivery failures for an endpoint,
   * looking at the most recent completed attempts. A success resets the streak.
   */
  countConsecutiveEndpointFailures(orgId: string, endpointId: string): Promise<WebhookResult<number>>;
}
