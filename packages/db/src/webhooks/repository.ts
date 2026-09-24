import type { SqlExecutor } from "../d1/executor.js";
import type {
  WebhookRepository,
  WebhookResult,
  WebhookEndpoint,
  WebhookSubscription,
  WebhookDeliveryAttempt,
  CreateWebhookEndpointInput,
  UpdateWebhookEndpointInput,
  DisableWebhookEndpointInput,
  CreateWebhookSubscriptionInput,
  UpdateWebhookSubscriptionInput,
  CreateDeliveryAttemptInput,
  UpdateDeliveryAttemptInput,
  CursorPosition,
  PageQueryParams,
  PagedResult,
  EndpointForDelivery,
  MatchedSubscription,
  DispatchCursor,
  RotateEndpointSecretInput,
  RotateEndpointSecretResult,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";
import { parseBooleanColumn } from "../json.js";

// ── Row mappers ────────────────────────────────────────────

/** Safe columns for endpoint reads — excludes secret_ciphertext */
const ENDPOINT_SAFE_COLUMNS = `id, org_id, project_id, url, name, description, status, disabled_reason, disabled_at, secret_version, secret_last_rotated_at, created_at, updated_at`;

function mapEndpoint(row: Record<string, unknown>): WebhookEndpoint {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    url: row.url as string,
    name: (row.name as string) ?? null,
    description: (row.description as string) ?? null,
    status: row.status as WebhookEndpoint["status"],
    disabledReason: (row.disabled_reason as string) ?? null,
    disabledAt: row.disabled_at ? new Date(row.disabled_at as string) : null,
    secretVersion: row.secret_version as number,
    secretLastRotatedAt: row.secret_last_rotated_at ? new Date(row.secret_last_rotated_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapSubscription(row: Record<string, unknown>): WebhookSubscription {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    endpointId: row.endpoint_id as string,
    projectId: (row.project_id as string) ?? null,
    eventType: row.event_type as string,
    enabled: parseBooleanColumn(row.enabled),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapDeliveryAttempt(row: Record<string, unknown>): WebhookDeliveryAttempt {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    endpointId: row.endpoint_id as string,
    subscriptionId: row.subscription_id as string,
    eventId: row.event_id as string,
    eventType: row.event_type as string,
    status: row.status as WebhookDeliveryAttempt["status"],
    attemptNumber: row.attempt_number as number,
    httpStatusCode: (row.http_status_code as number) ?? null,
    failureReason: (row.failure_reason as string) ?? null,
    idempotencyKey: (row.idempotency_key as string) ?? null,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at as string) : null,
    completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// ── Helpers ────────────────────────────────────────────────

function safeError(message: string): WebhookResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}


// ── Paged list helper ──────────────────────────────────────

async function pagedList<T>(
  executor: SqlExecutor,
  table: string,
  whereClause: string,
  whereParams: unknown[],
  params: PageQueryParams,
  mapper: (row: Record<string, unknown>) => T,
  selectColumns = "*",
): Promise<WebhookResult<PagedResult<T>>> {
  try {
    const fetchLimit = params.limit + 1;
    const baseIdx = whereParams.length;
    let sql: string;
    let values: unknown[];
    if (params.cursor) {
      sql = `SELECT ${selectColumns} FROM ${table}
       WHERE ${whereClause}
         AND (created_at, id) < ($${baseIdx + 2}, $${baseIdx + 3})
       ORDER BY created_at DESC, id DESC
       LIMIT $${baseIdx + 1}`;
      values = [...whereParams, fetchLimit, params.cursor.createdAt, params.cursor.id];
    } else {
      sql = `SELECT ${selectColumns} FROM ${table}
       WHERE ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${baseIdx + 1}`;
      values = [...whereParams, fetchLimit];
    }
    const result = await executor.execute<Record<string, unknown>>(sql, values);
    const rows = result.rows.map(mapper);
    let nextCursor: CursorPosition | null = null;
    if (rows.length > params.limit) {
      rows.pop();
      const last = rows[rows.length - 1]!;
      nextCursor = {
        createdAt: (last as unknown as { createdAt: Date }).createdAt.toISOString(),
        id: (last as unknown as { id: string }).id,
      };
    }
    return { ok: true, value: { items: rows, nextCursor } };
  } catch {
    return safeError(`Failed to list from ${table}`);
  }
}

// ── Repository factory ─────────────────────────────────────

export function createWebhookRepository(executor: SqlExecutor): WebhookRepository {
  return {
    // ── Endpoints ──────────────────────────────────────────

    async createEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookResult<WebhookEndpoint>> {
      try {
        const hasCiphertext = input.secretCiphertext !== undefined;
        const sql = hasCiphertext
          ? `INSERT INTO webhooks_webhook_endpoints (id, org_id, project_id, url, name, description, secret_ciphertext, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             RETURNING ${ENDPOINT_SAFE_COLUMNS}`
          : `INSERT INTO webhooks_webhook_endpoints (id, org_id, project_id, url, name, description, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             RETURNING ${ENDPOINT_SAFE_COLUMNS}`;
        const values: unknown[] = [
          input.id,
          input.orgId,
          input.projectId ?? null,
          input.url,
          input.name ?? null,
          input.description ?? null,
        ];
        if (hasCiphertext) {
          values.push(input.secretCiphertext!);
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "webhook_endpoint" } };
        }
        return { ok: true, value: mapEndpoint(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "webhook_endpoint" } };
        }
        return safeError("Failed to create webhook endpoint");
      }
    },

    async getEndpoint(orgId: string, endpointId: string): Promise<WebhookResult<WebhookEndpoint>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${ENDPOINT_SAFE_COLUMNS} FROM webhooks_webhook_endpoints WHERE org_id = $1 AND id = $2`,
          [orgId, endpointId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapEndpoint(result.rows[0]!) };
      } catch {
        return safeError("Failed to get webhook endpoint");
      }
    },

    async listEndpoints(orgId: string, params: PageQueryParams, projectId?: string | null): Promise<WebhookResult<PagedResult<WebhookEndpoint>>> {
      if (projectId) {
        return pagedList(
          executor,
          "webhooks_webhook_endpoints",
          "org_id = $1 AND project_id = $2",
          [orgId, projectId],
          params,
          mapEndpoint,
          ENDPOINT_SAFE_COLUMNS,
        );
      }
      return pagedList(
        executor,
        "webhooks_webhook_endpoints",
        "org_id = $1",
        [orgId],
        params,
        mapEndpoint,
        ENDPOINT_SAFE_COLUMNS,
      );
    },

    async updateEndpoint(orgId: string, endpointId: string, input: UpdateWebhookEndpointInput): Promise<WebhookResult<WebhookEndpoint>> {
      try {
        const setClauses: string[] = ["updated_at = now()"];
        const values: unknown[] = [orgId, endpointId];
        let idx = 3;
        if (input.url !== undefined) {
          setClauses.push(`url = $${idx}`);
          values.push(input.url);
          idx++;
        }
        if (input.name !== undefined) {
          setClauses.push(`name = $${idx}`);
          values.push(input.name);
          idx++;
        }
        if (input.description !== undefined) {
          setClauses.push(`description = $${idx}`);
          values.push(input.description);
          idx++;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE webhooks_webhook_endpoints SET ${setClauses.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING ${ENDPOINT_SAFE_COLUMNS}`,
          values,
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapEndpoint(result.rows[0]!) };
      } catch {
        return safeError("Failed to update webhook endpoint");
      }
    },

    async disableEndpoint(orgId: string, endpointId: string, input: DisableWebhookEndpointInput): Promise<WebhookResult<WebhookEndpoint>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE webhooks_webhook_endpoints
           SET status = 'disabled', disabled_reason = $3, disabled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING ${ENDPOINT_SAFE_COLUMNS}`,
          [orgId, endpointId, input.reason ?? null],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapEndpoint(result.rows[0]!) };
      } catch {
        return safeError("Failed to disable webhook endpoint");
      }
    },

    async enableEndpoint(orgId: string, endpointId: string): Promise<WebhookResult<WebhookEndpoint>> {
      try {
        // Symmetric to disableEndpoint: WHERE guard ensures idempotent
        // semantics — re-running on an already-active endpoint returns
        // not_found (mirrors disable's "missing or already disabled" model).
        // `pending` endpoints are intentionally excluded.
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE webhooks_webhook_endpoints
           SET status = 'active', disabled_reason = NULL, disabled_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE org_id = $1 AND id = $2 AND status = 'disabled'
           RETURNING ${ENDPOINT_SAFE_COLUMNS}`,
          [orgId, endpointId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapEndpoint(result.rows[0]!) };
      } catch {
        return safeError("Failed to enable webhook endpoint");
      }
    },

    async deleteEndpoint(orgId: string, endpointId: string): Promise<WebhookResult<{ deleted: true }>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM webhooks_webhook_endpoints WHERE org_id = $1 AND id = $2`,
          [orgId, endpointId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: { deleted: true } };
      } catch {
        return safeError("Failed to delete webhook endpoint");
      }
    },

    async rotateEndpointSecret(
      orgId: string,
      endpointId: string,
      input?: RotateEndpointSecretInput,
    ): Promise<WebhookResult<RotateEndpointSecretResult>> {
      try {
        const secretCiphertext = input?.secretCiphertext;
        const gracePeriodSeconds = input?.gracePeriodSeconds;
        const hasCiphertext = secretCiphertext !== undefined;
        const useGrace = typeof gracePeriodSeconds === "number" && gracePeriodSeconds > 0 && hasCiphertext;

        // When useGrace: snapshot current secret_ciphertext + secret_version into the
        // previous_* columns and set previous_secret_expires_at = now() + N seconds.
        // When !useGrace: clear any stale grace window (previous_* = NULL).
        let setClause: string;
        const values: unknown[] = [orgId, endpointId];
        if (useGrace) {
          setClause = `secret_version = secret_version + 1,
                       secret_last_rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                       previous_secret_ciphertext = secret_ciphertext,
                       previous_secret_version = secret_version,
                       previous_secret_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+' || $4 || ' seconds'),
                       secret_ciphertext = $3,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
          values.push(secretCiphertext, gracePeriodSeconds);
        } else if (hasCiphertext) {
          setClause = `secret_version = secret_version + 1,
                       secret_last_rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                       previous_secret_ciphertext = NULL,
                       previous_secret_version = NULL,
                       previous_secret_expires_at = NULL,
                       secret_ciphertext = $3,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
          values.push(secretCiphertext);
        } else {
          setClause = `secret_version = secret_version + 1,
                       secret_last_rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                       previous_secret_ciphertext = NULL,
                       previous_secret_version = NULL,
                       previous_secret_expires_at = NULL,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
        }

        const sql = `UPDATE webhooks_webhook_endpoints
                     SET ${setClause}
                     WHERE org_id = $1 AND id = $2 AND status = 'active'
                     RETURNING ${ENDPOINT_SAFE_COLUMNS}, previous_secret_version, previous_secret_expires_at`;

        const result = await executor.execute<Record<string, unknown>>(sql, values);
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const row = result.rows[0]!;
        const previousSecretVersion = (row.previous_secret_version as number | null) ?? null;
        const rawExpires = row.previous_secret_expires_at;
        const previousSecretExpiresAt = rawExpires
          ? new Date(rawExpires as string).toISOString()
          : null;
        return {
          ok: true,
          value: {
            endpoint: mapEndpoint(row),
            previousSecretVersion,
            previousSecretExpiresAt,
          },
        };
      } catch {
        return safeError("Failed to rotate webhook endpoint secret");
      }
    },

    // ── Subscriptions ──────────────────────────────────────

    async createSubscription(input: CreateWebhookSubscriptionInput): Promise<WebhookResult<WebhookSubscription>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO webhooks_webhook_subscriptions (id, org_id, endpoint_id, project_id, event_type, enabled, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           RETURNING *`,
          [input.id, input.orgId, input.endpointId, input.projectId ?? null, input.eventType, input.enabled ?? true],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "webhook_subscription" } };
        }
        return { ok: true, value: mapSubscription(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "webhook_subscription" } };
        }
        return safeError("Failed to create webhook subscription");
      }
    },

    async getSubscription(orgId: string, subscriptionId: string): Promise<WebhookResult<WebhookSubscription>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM webhooks_webhook_subscriptions WHERE org_id = $1 AND id = $2`,
          [orgId, subscriptionId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSubscription(result.rows[0]!) };
      } catch {
        return safeError("Failed to get webhook subscription");
      }
    },

    async listSubscriptions(orgId: string, endpointId: string, params: PageQueryParams): Promise<WebhookResult<PagedResult<WebhookSubscription>>> {
      return pagedList(
        executor,
        "webhooks_webhook_subscriptions",
        "org_id = $1 AND endpoint_id = $2",
        [orgId, endpointId],
        params,
        mapSubscription,
      );
    },

    async updateSubscription(orgId: string, subscriptionId: string, input: UpdateWebhookSubscriptionInput): Promise<WebhookResult<WebhookSubscription>> {
      try {
        const setClauses: string[] = ["updated_at = now()"];
        const values: unknown[] = [orgId, subscriptionId];
        let idx = 3;
        if (input.enabled !== undefined) {
          setClauses.push(`enabled = $${idx}`);
          values.push(input.enabled);
          idx++;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE webhooks_webhook_subscriptions SET ${setClauses.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING *`,
          values,
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSubscription(result.rows[0]!) };
      } catch {
        return safeError("Failed to update webhook subscription");
      }
    },

    async deleteSubscription(orgId: string, subscriptionId: string): Promise<WebhookResult<{ deleted: true }>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM webhooks_webhook_subscriptions WHERE org_id = $1 AND id = $2`,
          [orgId, subscriptionId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: { deleted: true } };
      } catch {
        return safeError("Failed to delete webhook subscription");
      }
    },

    // ── Delivery attempts ──────────────────────────────────

    async createDeliveryAttempt(input: CreateDeliveryAttemptInput): Promise<WebhookResult<WebhookDeliveryAttempt>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO webhooks_webhook_delivery_attempts (id, org_id, endpoint_id, subscription_id, event_id, event_type, idempotency_key, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           RETURNING *`,
          [input.id, input.orgId, input.endpointId, input.subscriptionId, input.eventId, input.eventType, input.idempotencyKey ?? null],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "webhook_delivery_attempt" } };
        }
        return { ok: true, value: mapDeliveryAttempt(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "webhook_delivery_attempt" } };
        }
        return safeError("Failed to create delivery attempt");
      }
    },

    async updateDeliveryAttempt(orgId: string, attemptId: string, input: UpdateDeliveryAttemptInput): Promise<WebhookResult<WebhookDeliveryAttempt>> {
      try {
        const setClauses: string[] = ["updated_at = now()", "status = $3"];
        const values: unknown[] = [orgId, attemptId, input.status];
        let idx = 4;
        if (input.attemptNumber !== undefined) {
          setClauses.push(`attempt_number = $${idx}`);
          values.push(input.attemptNumber);
          idx++;
        }
        if (input.httpStatusCode !== undefined) {
          setClauses.push(`http_status_code = $${idx}`);
          values.push(input.httpStatusCode);
          idx++;
        }
        if (input.failureReason !== undefined) {
          setClauses.push(`failure_reason = $${idx}`);
          values.push(input.failureReason);
          idx++;
        }
        if (input.nextRetryAt !== undefined) {
          setClauses.push(`next_retry_at = $${idx}`);
          values.push(input.nextRetryAt?.toISOString() ?? null);
          idx++;
        }
        if (input.completedAt !== undefined) {
          setClauses.push(`completed_at = $${idx}`);
          values.push(input.completedAt?.toISOString() ?? null);
          idx++;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE webhooks_webhook_delivery_attempts SET ${setClauses.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING *`,
          values,
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapDeliveryAttempt(result.rows[0]!) };
      } catch {
        return safeError("Failed to update delivery attempt");
      }
    },

    async getDeliveryAttempt(orgId: string, attemptId: string): Promise<WebhookResult<WebhookDeliveryAttempt>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM webhooks_webhook_delivery_attempts WHERE org_id = $1 AND id = $2`,
          [orgId, attemptId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapDeliveryAttempt(result.rows[0]!) };
      } catch {
        return safeError("Failed to get delivery attempt");
      }
    },

    async listDeliveryAttempts(orgId: string, endpointId: string, params: PageQueryParams): Promise<WebhookResult<PagedResult<WebhookDeliveryAttempt>>> {
      return pagedList(
        executor,
        "webhooks_webhook_delivery_attempts",
        "org_id = $1 AND endpoint_id = $2",
        [orgId, endpointId],
        params,
        mapDeliveryAttempt,
      );
    },

    // ── Delivery runtime ────────────────────────────────────

    async getEndpointForDelivery(orgId: string, endpointId: string): Promise<WebhookResult<EndpointForDelivery>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, url, status, secret_ciphertext, secret_version,
                  previous_secret_ciphertext, previous_secret_version, previous_secret_expires_at
           FROM webhooks_webhook_endpoints WHERE org_id = $1 AND id = $2`,
          [orgId, endpointId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        const row = result.rows[0]!;
        const rawPrevExpires = row.previous_secret_expires_at;
        return {
          ok: true,
          value: {
            id: row.id as string,
            orgId: row.org_id as string,
            url: row.url as string,
            status: row.status as EndpointForDelivery["status"],
            secretCiphertext: (row.secret_ciphertext as string) ?? null,
            secretVersion: row.secret_version as number,
            previousSecretCiphertext: (row.previous_secret_ciphertext as string) ?? null,
            previousSecretVersion: (row.previous_secret_version as number | null) ?? null,
            previousSecretExpiresAt: rawPrevExpires
              ? new Date(rawPrevExpires as string).toISOString()
              : null,
          },
        };
      } catch {
        return safeError("Failed to get endpoint for delivery");
      }
    },

    async findMatchingSubscriptions(orgId: string, eventType: string): Promise<WebhookResult<MatchedSubscription[]>> {
      try {
        // Match exact event type OR wildcard subscriptions (e.g. "project.*" matches "project.created")
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT s.id, s.org_id, s.endpoint_id, s.project_id, s.event_type
           FROM webhooks_webhook_subscriptions s
           JOIN webhooks_webhook_endpoints e ON e.id = s.endpoint_id AND e.org_id = s.org_id
           WHERE s.org_id = $1 AND s.enabled = true AND e.status = 'active'
             AND (s.event_type = $2 OR s.event_type = '*'
                  OR ($2 LIKE s.event_type || '.%' AND s.event_type LIKE '%.*'))`,
          [orgId, eventType],
        );
        const subs: MatchedSubscription[] = result.rows.map((row) => ({
          id: row.id as string,
          orgId: row.org_id as string,
          endpointId: row.endpoint_id as string,
          projectId: (row.project_id as string) ?? null,
          eventType: row.event_type as string,
        }));
        return { ok: true, value: subs };
      } catch {
        return safeError("Failed to find matching subscriptions");
      }
    },

    async listRetryableDeliveries(limit: number): Promise<WebhookResult<WebhookDeliveryAttempt[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM webhooks_webhook_delivery_attempts
           WHERE status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
           ORDER BY next_retry_at ASC
           LIMIT $1`,
          [limit],
        );
        return { ok: true, value: result.rows.map(mapDeliveryAttempt) };
      } catch {
        return safeError("Failed to list retryable deliveries");
      }
    },

    // ── Dispatch cursor ─────────────────────────────────────

    async getDispatchCursor(orgId: string, lane = "webhooks"): Promise<WebhookResult<DispatchCursor>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT org_id, subscriber_lane, last_event_id, last_occurred_at, updated_at
           FROM webhooks_webhook_dispatch_cursor
           WHERE org_id = $1 AND subscriber_lane = $2`,
          [orgId, lane],
        );
        if (result.rowCount === 0) {
          // Return a "zero" cursor — org hasn't been dispatched yet
          return {
            ok: true,
            value: {
              orgId,
              subscriberLane: lane,
              lastEventId: null,
              lastOccurredAt: null,
              updatedAt: new Date(0),
            },
          };
        }
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            orgId: row.org_id as string,
            subscriberLane: row.subscriber_lane as string,
            lastEventId: (row.last_event_id as string) ?? null,
            lastOccurredAt: (row.last_occurred_at as string) ?? null,
            updatedAt: new Date(row.updated_at as string),
          },
        };
      } catch {
        return safeError("Failed to get dispatch cursor");
      }
    },

    async advanceDispatchCursor(orgId: string, lastEventId: string, lastOccurredAt: string, lane = "webhooks"): Promise<WebhookResult<DispatchCursor>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO webhooks_webhook_dispatch_cursor (org_id, subscriber_lane, last_event_id, last_occurred_at, updated_at)
           VALUES ($1, $2, $3, $4, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (org_id, subscriber_lane)
           DO UPDATE SET last_event_id = $3, last_occurred_at = $4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           RETURNING *`,
          [orgId, lane, lastEventId, lastOccurredAt],
        );
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            orgId: row.org_id as string,
            subscriberLane: row.subscriber_lane as string,
            lastEventId: (row.last_event_id as string) ?? null,
            lastOccurredAt: (row.last_occurred_at as string) ?? null,
            updatedAt: new Date(row.updated_at as string),
          },
        };
      } catch {
        return safeError("Failed to advance dispatch cursor");
      }
    },

    async countConsecutiveEndpointFailures(orgId: string, endpointId: string): Promise<WebhookResult<number>> {
      try {
        // Count consecutive terminal failures from the most recent completed attempts.
        // Finds the latest success (if any) and counts failures after it.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT COUNT(*) AS streak
           FROM webhooks_webhook_delivery_attempts
           WHERE org_id = $1 AND endpoint_id = $2 AND status = 'failed'
             AND completed_at > COALESCE(
               (SELECT MAX(completed_at) FROM webhooks_webhook_delivery_attempts
                WHERE org_id = $1 AND endpoint_id = $2 AND status = 'success'),
               '1970-01-01T00:00:00.000Z'
             )`,
          [orgId, endpointId],
        );
        const streak = parseInt(result.rows[0]?.streak as string ?? "0", 10);
        return { ok: true, value: streak };
      } catch {
        return safeError("Failed to count consecutive endpoint failures");
      }
    },

    async listActiveOrgIds(): Promise<WebhookResult<string[]>> {
      try {
        // Orgs that have at least one enabled subscription with an active endpoint
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT DISTINCT s.org_id
           FROM webhooks_webhook_subscriptions s
           JOIN webhooks_webhook_endpoints e ON e.id = s.endpoint_id AND e.org_id = s.org_id
           WHERE s.enabled = true AND e.status = 'active'`,
          [],
        );
        return { ok: true, value: result.rows.map((row) => row.org_id as string) };
      } catch {
        return safeError("Failed to list active org IDs");
      }
    },
  };
}
