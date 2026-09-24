import type { SqlExecutor } from "../d1/executor.js";
import type {
  CreateNotificationAttemptInput,
  CreateNotificationInput,
  CreateNotificationSuppressionInput,
  MarkNotificationStatusInput,
  NotificationsRepository,
  NotificationsResult,
  StoredNotification,
  StoredNotificationAttempt,
  StoredNotificationPreference,
  StoredNotificationSuppression,
  UpsertNotificationPreferenceInput,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function parseJsonColumn(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function parseCategoriesColumn(value: unknown): Record<string, boolean | null> {
  const parsed = parseJsonColumn(value);
  const out: Record<string, boolean | null> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || typeof v === "boolean") out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapNotification(row: Record<string, unknown>): StoredNotification {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    category: row.category as string,
    templateKey: row.template_key as string,
    templateData: parseJsonColumn(row.template_data),
    channel: row.channel as string,
    recipientAddress: row.recipient_address as string,
    recipientSubjectKind: (row.recipient_subject_kind as string) ?? null,
    recipientSubjectId: (row.recipient_subject_id as string) ?? null,
    status: row.status as string,
    providerMessageId: (row.provider_message_id as string) ?? null,
    lastError: (row.last_error as string) ?? null,
    idempotencyKey: (row.idempotency_key as string) ?? null,
    correlationId: (row.correlation_id as string) ?? null,
    queuedAt: new Date(row.queued_at as string),
    sentAt: row.sent_at ? new Date(row.sent_at as string) : null,
    failedAt: row.failed_at ? new Date(row.failed_at as string) : null,
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapAttempt(row: Record<string, unknown>): StoredNotificationAttempt {
  return {
    id: row.id as string,
    notificationId: row.notification_id as string,
    orgId: row.org_id as string,
    attemptNumber: row.attempt_number as number,
    status: row.status as string,
    providerMessageId: (row.provider_message_id as string) ?? null,
    errorReason: (row.error_reason as string) ?? null,
    attemptedAt: new Date(row.attempted_at as string),
  };
}

function mapPreference(row: Record<string, unknown>): StoredNotificationPreference {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    subjectKind: row.subject_kind as string,
    subjectId: row.subject_id as string,
    channel: row.channel as string,
    categories: parseCategoriesColumn(row.categories),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapSuppression(row: Record<string, unknown>): StoredNotificationSuppression {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    channel: row.channel as string,
    address: row.address as string,
    reason: row.reason as string,
    createdAt: new Date(row.created_at as string),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function safeError(message: string): NotificationsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNotificationsRepository(executor: SqlExecutor): NotificationsRepository {
  return {
    async createNotification(input: CreateNotificationInput) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO notifications_notifications (
            id, org_id, category, template_key, template_data,
            channel, recipient_address, recipient_subject_kind, recipient_subject_id,
            status, idempotency_key, correlation_id, queued_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12, $13, $13
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING *`,
          [
            input.id,
            input.orgId,
            input.category,
            input.templateKey,
            JSON.stringify(input.templateData),
            input.channel,
            input.recipientAddress.toLowerCase(),
            input.recipientSubjectKind ?? null,
            input.recipientSubjectId ?? null,
            input.status,
            input.idempotencyKey ?? null,
            input.correlationId ?? null,
            input.queuedAt.toISOString(),
          ],
        );
        if (result.rows.length === 0) {
          return { ok: false, error: { kind: "conflict", entity: "notification" } };
        }
        return { ok: true, value: mapNotification(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "notification" } };
        }
        return safeError("Failed to create notification");
      }
    },

    async getNotificationById(id: string) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM notifications_notifications WHERE id = $1`,
          [id],
        );
        if (result.rows.length === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapNotification(result.rows[0]!) };
      } catch {
        return safeError("Failed to get notification");
      }
    },

    async findNotificationByIdempotencyKey(orgId: string, idempotencyKey: string) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM notifications_notifications
           WHERE org_id = $1 AND idempotency_key = $2
           LIMIT 1`,
          [orgId, idempotencyKey],
        );
        if (result.rows.length === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapNotification(result.rows[0]!) };
      } catch {
        return safeError("Failed to look up notification by idempotency key");
      }
    },

    async markNotificationStatus(input: MarkNotificationStatusInput) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE notifications_notifications
           SET status = $3,
               provider_message_id = COALESCE($4, provider_message_id),
               last_error = $5,
               sent_at = COALESCE($6, sent_at),
               failed_at = COALESCE($7, failed_at),
               updated_at = $8
           WHERE id = $1 AND org_id = $2
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.status,
            input.providerMessageId ?? null,
            input.lastError ?? null,
            input.sentAt ? input.sentAt.toISOString() : null,
            input.failedAt ? input.failedAt.toISOString() : null,
            input.updatedAt.toISOString(),
          ],
        );
        if (result.rows.length === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapNotification(result.rows[0]!) };
      } catch {
        return safeError("Failed to mark notification status");
      }
    },

    async recordAttempt(input: CreateNotificationAttemptInput) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO notifications_notification_attempts (
            id, notification_id, org_id, attempt_number,
            status, provider_message_id, error_reason, attempted_at
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8
          )
          ON CONFLICT (notification_id, attempt_number) DO NOTHING
          RETURNING *`,
          [
            input.id,
            input.notificationId,
            input.orgId,
            input.attemptNumber,
            input.status,
            input.providerMessageId ?? null,
            input.errorReason ?? null,
            input.attemptedAt.toISOString(),
          ],
        );
        if (result.rows.length === 0) {
          return { ok: false, error: { kind: "conflict", entity: "attempt" } };
        }
        return { ok: true, value: mapAttempt(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "attempt" } };
        }
        return safeError("Failed to record notification attempt");
      }
    },

    async listAttempts(notificationId: string) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM notifications_notification_attempts
           WHERE notification_id = $1
           ORDER BY attempt_number ASC`,
          [notificationId],
        );
        return { ok: true, value: result.rows.map(mapAttempt) };
      } catch {
        return safeError("Failed to list notification attempts");
      }
    },

    async listPreferences(orgId, subjectKind, subjectId, channel) {
      try {
        let sql = `SELECT * FROM notifications_notification_preferences
                   WHERE org_id = $1 AND subject_kind = $2 AND subject_id = $3`;
        const params: unknown[] = [orgId, subjectKind, subjectId];
        if (channel) {
          sql += ` AND channel = $4`;
          params.push(channel);
        }
        sql += ` ORDER BY channel ASC`;
        const result = await executor.execute<Record<string, unknown>>(sql, params);
        return { ok: true, value: result.rows.map(mapPreference) };
      } catch {
        return safeError("Failed to list notification preferences");
      }
    },

    async upsertPreference(input: UpsertNotificationPreferenceInput) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO notifications_notification_preferences (
            id, org_id, subject_kind, subject_id, channel, categories, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $7
          )
          ON CONFLICT (org_id, subject_kind, subject_id, channel)
          DO UPDATE SET
            categories = EXCLUDED.categories,
            updated_at = EXCLUDED.updated_at
          RETURNING *`,
          [
            input.id,
            input.orgId,
            input.subjectKind,
            input.subjectId,
            input.channel,
            JSON.stringify(input.categories),
            input.updatedAt.toISOString(),
          ],
        );
        if (result.rows.length === 0) {
          return safeError("Failed to upsert preference");
        }
        return { ok: true, value: mapPreference(result.rows[0]!) };
      } catch {
        return safeError("Failed to upsert notification preference");
      }
    },

    async isSuppressed(orgId: string, channel: string, address: string) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT 1 FROM notifications_notification_suppressions
           WHERE org_id = $1 AND channel = $2 AND address = $3
           LIMIT 1`,
          [orgId, channel, address.toLowerCase()],
        );
        return { ok: true, value: result.rows.length > 0 };
      } catch {
        return safeError("Failed to check suppression");
      }
    },

    async createSuppression(input: CreateNotificationSuppressionInput) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO notifications_notification_suppressions (
            id, org_id, channel, address, reason, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6
          )
          ON CONFLICT (org_id, channel, address) DO UPDATE
          SET reason = EXCLUDED.reason
          RETURNING *`,
          [
            input.id,
            input.orgId,
            input.channel,
            input.address.toLowerCase(),
            input.reason,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rows.length === 0) {
          return safeError("Failed to create suppression");
        }
        return { ok: true, value: mapSuppression(result.rows[0]!) };
      } catch {
        return safeError("Failed to create suppression");
      }
    },
  };
}
