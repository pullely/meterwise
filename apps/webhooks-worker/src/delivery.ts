/**
 * Webhook delivery dispatcher — event fanout, subscription matching,
 * HMAC-SHA256 signing, HTTP delivery with exponential backoff retry.
 *
 * Entry points:
 *   - dispatchNewEvents(): poll event_log per org, fan out to matching subscriptions
 *   - retryFailedDeliveries(): pick up retryable attempts and redeliver
 */

import type { CiphertextEnvelope, EncryptionAdapter } from "./encryption.js";
import type { WebhookRepository, WebhookDeliveryAttempt, EndpointForDelivery } from "@saas/db/webhooks";
import type { EventsRepository, StoredEvent } from "@saas/db/events";
import { WEBHOOK_USER_AGENT } from "./app-config";

// ── Constants ────────────────────────────────────────────────

const MAX_EVENTS_PER_ORG = 50;
const MAX_RETRIES = 5;
const RETRY_BASE_SECONDS = 30;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RETRY_BATCH = 100;

/**
 * V1 threshold: after this many consecutive terminal delivery failures
 * for the same endpoint, the endpoint is automatically disabled.
 */
export const AUTO_DISABLE_FAILURE_THRESHOLD = 5;

/**
 * Event types that are suppressed from webhook delivery fanout to prevent
 * recursive loops. Delivering these events could produce new delivery attempts
 * which in turn emit new lifecycle events, creating unbounded recursion.
 */
export const WEBHOOK_LIFECYCLE_EVENT_TYPES = new Set([
  "webhook.delivery_succeeded",
  "webhook.delivery_failed",
  "webhook.disabled",
]);

// ── Signing ──────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 * Returns hex-encoded signature with `sha256=` prefix (GitHub-style).
 */
async function computeSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = encoder.encode(`${timestamp}.${body}`);
  const sig = await crypto.subtle.sign("HMAC", key, message);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

// ── Retry schedule ───────────────────────────────────────────

function nextRetryAt(attemptNumber: number): Date | null {
  if (attemptNumber >= MAX_RETRIES) return null;
  // Exponential backoff: 30s, 120s, 480s, 1920s, ...
  const delaySeconds = RETRY_BASE_SECONDS * Math.pow(4, attemptNumber - 1);
  return new Date(Date.now() + delaySeconds * 1000);
}

// ── Lifecycle event helpers ──────────────────────────────────

/**
 * Check whether an event type is a webhook lifecycle event that must be
 * excluded from delivery fanout to prevent recursion.
 */
export function isWebhookLifecycleEvent(eventType: string): boolean {
  return WEBHOOK_LIFECYCLE_EVENT_TYPES.has(eventType);
}

/**
 * Build a safe metadata payload for a delivery lifecycle event.
 * Excludes secrets, raw responses, stack traces, and customer data.
 */
export function buildDeliveryLifecyclePayload(attempt: WebhookDeliveryAttempt): Record<string, unknown> {
  return {
    delivery_attempt_id: attempt.id,
    endpoint_id: attempt.endpointId,
    subscription_id: attempt.subscriptionId,
    source_event_id: attempt.eventId,
    source_event_type: attempt.eventType,
    http_status_code: attempt.httpStatusCode ?? null,
    failure_reason: attempt.failureReason ?? null,
    attempt_number: attempt.attemptNumber,
    completed_at: attempt.completedAt?.toISOString() ?? null,
  };
}

/**
 * Emit a delivery lifecycle event (success or failure).
 * Failures in event emission are swallowed — they must never cause
 * an additional customer HTTP call or duplicate delivery attempt.
 */
async function emitDeliveryLifecycleEvent(
  ctx: DeliveryContext,
  attempt: WebhookDeliveryAttempt,
  type: "webhook.delivery_succeeded" | "webhook.delivery_failed",
): Promise<void> {
  try {
    const now = new Date();
    await ctx.eventsRepo.appendEvent({
      id: crypto.randomUUID(),
      type,
      version: 1,
      source: "webhooks-worker",
      occurredAt: now,
      actorType: "system",
      actorId: "webhooks-worker",
      orgId: attempt.orgId,
      subjectKind: "webhook_delivery_attempt",
      subjectId: attempt.id,
      requestId: crypto.randomUUID(),
      causationId: attempt.eventId,
      idempotencyKey: `${type}:${attempt.id}`,
      payload: buildDeliveryLifecyclePayload(attempt),
    });
  } catch {
    // Lifecycle event append failure must not affect delivery.
    // Swallow error — the delivery attempt status is already recorded.
  }
}

/**
 * Check whether an endpoint should be auto-disabled based on consecutive
 * terminal failures, and if so, disable it and emit an auditable event.
 * Idempotent: if the endpoint is already disabled, this is a no-op.
 */
async function maybeAutoDisableEndpoint(
  ctx: DeliveryContext,
  orgId: string,
  endpointId: string,
): Promise<void> {
  try {
    const streakResult = await ctx.webhookRepo.countConsecutiveEndpointFailures(orgId, endpointId);
    if (!streakResult.ok || streakResult.value < AUTO_DISABLE_FAILURE_THRESHOLD) return;

    // Disable endpoint — disableEndpoint already guards status = 'active',
    // so concurrent/repeated calls for an already-disabled endpoint are no-ops (returns not_found).
    const disableResult = await ctx.webhookRepo.disableEndpoint(orgId, endpointId, {
      reason: "repeated_delivery_failures",
    });
    if (!disableResult.ok) return; // Already disabled or not found — idempotent

    // Emit auditable webhook.disabled event
    const now = new Date();
    const eventId = crypto.randomUUID();
    await ctx.eventsRepo.appendEventWithAudit({
      event: {
        id: eventId,
        type: "webhook.disabled",
        version: 1,
        source: "webhooks-worker",
        occurredAt: now,
        actorType: "system",
        actorId: "webhooks-worker",
        orgId,
        subjectKind: "webhook_endpoint",
        subjectId: endpointId,
        requestId: crypto.randomUUID(),
        idempotencyKey: `webhook.disabled:auto:${endpointId}`,
        payload: {
          endpoint_id: endpointId,
          reason: "repeated_delivery_failures",
          failure_threshold: AUTO_DISABLE_FAILURE_THRESHOLD,
        },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "webhooks",
        description: `Webhook endpoint auto-disabled after ${AUTO_DISABLE_FAILURE_THRESHOLD} consecutive delivery failures`,
      },
    });
  } catch {
    // Auto-disable failure must not affect delivery processing.
  }
}

// ── Delivery ─────────────────────────────────────────────────

export interface DeliveryContext {
  webhookRepo: WebhookRepository;
  eventsRepo: EventsRepository;
  encryption: EncryptionAdapter | null;
}

async function deliverAttempt(
  ctx: DeliveryContext,
  attempt: WebhookDeliveryAttempt,
  event: StoredEvent | null,
  endpoint: EndpointForDelivery | null,
): Promise<void> {
  // Resolve endpoint if not pre-fetched
  if (!endpoint) {
    const epResult = await ctx.webhookRepo.getEndpointForDelivery(attempt.orgId, attempt.endpointId);
    if (!epResult.ok) {
      await ctx.webhookRepo.updateDeliveryAttempt(attempt.orgId, attempt.id, {
        status: "failed",
        failureReason: "endpoint_not_found",
        completedAt: new Date(),
      });
      return;
    }
    endpoint = epResult.value;
  }

  if (endpoint.status !== "active") {
    await ctx.webhookRepo.updateDeliveryAttempt(attempt.orgId, attempt.id, {
      status: "failed",
      failureReason: "endpoint_disabled",
      completedAt: new Date(),
    });
    return;
  }

  // Build payload
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({
    id: attempt.eventId,
    type: attempt.eventType,
    occurred_at: event?.occurredAt.toISOString() ?? timestamp,
    data: event?.payload ?? {},
  });

  // Sign if secret available
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": WEBHOOK_USER_AGENT,
    "X-Webhook-ID": attempt.id,
    "X-Webhook-Timestamp": timestamp,
  };

  if (endpoint.secretCiphertext && ctx.encryption) {
    try {
      const envelope = JSON.parse(endpoint.secretCiphertext) as CiphertextEnvelope;
      const secret = await ctx.encryption.decrypt(envelope);
      const signature = await computeSignature(secret, timestamp, payload);
      headers["X-Webhook-Signature"] = signature;
    } catch {
      // If decryption fails, still deliver unsigned but log it
      headers["X-Webhook-Signature-Error"] = "decryption_failed";
    }

    // Dual-signature grace window (B5): if the endpoint was rotated recently
    // and the previous secret has not yet expired, attach a parallel
    // X-Webhook-Signature-Previous header so subscribers can keep verifying
    // with the old key while they roll over. Failures here are best-effort —
    // they MUST NOT block delivery and MUST NOT leak secret material.
    if (
      endpoint.previousSecretCiphertext &&
      endpoint.previousSecretExpiresAt &&
      Date.parse(endpoint.previousSecretExpiresAt) > Date.now()
    ) {
      try {
        const prevEnvelope = JSON.parse(endpoint.previousSecretCiphertext) as CiphertextEnvelope;
        const prevSecret = await ctx.encryption.decrypt(prevEnvelope);
        const prevSignature = await computeSignature(prevSecret, timestamp, payload);
        headers["X-Webhook-Signature-Previous"] = prevSignature;
      } catch {
        // Previous-secret decryption failure is silent: the primary signature
        // is still attached, and we never expose the raw failure to the wire.
      }
    }
  }

  // Deliver
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const response = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status >= 200 && response.status < 300) {
      const updatedResult = await ctx.webhookRepo.updateDeliveryAttempt(attempt.orgId, attempt.id, {
        status: "success",
        httpStatusCode: response.status,
        attemptNumber: attempt.attemptNumber,
        completedAt: new Date(),
        nextRetryAt: null,
      });
      // Emit success lifecycle event
      if (updatedResult.ok) {
        await emitDeliveryLifecycleEvent(ctx, updatedResult.value, "webhook.delivery_succeeded");
      }
    } else {
      // Non-2xx — schedule retry or fail permanently
      const retry = nextRetryAt(attempt.attemptNumber);
      const updatedResult = await ctx.webhookRepo.updateDeliveryAttempt(attempt.orgId, attempt.id, {
        status: retry ? "retrying" : "failed",
        httpStatusCode: response.status,
        failureReason: `HTTP ${response.status}`,
        attemptNumber: attempt.attemptNumber + 1,
        nextRetryAt: retry,
        completedAt: retry ? null : new Date(),
      });
      // If terminal failure, emit failure lifecycle event and check auto-disable
      if (!retry && updatedResult.ok) {
        await emitDeliveryLifecycleEvent(ctx, updatedResult.value, "webhook.delivery_failed");
        await maybeAutoDisableEndpoint(ctx, attempt.orgId, attempt.endpointId);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown_error";
    const isTimeout = reason.includes("abort");
    const retry = nextRetryAt(attempt.attemptNumber);
    const updatedResult = await ctx.webhookRepo.updateDeliveryAttempt(attempt.orgId, attempt.id, {
      status: retry ? "retrying" : "failed",
      failureReason: isTimeout ? "timeout" : reason,
      attemptNumber: attempt.attemptNumber + 1,
      nextRetryAt: retry,
      completedAt: retry ? null : new Date(),
    });
    // If terminal failure, emit failure lifecycle event and check auto-disable
    if (!retry && updatedResult.ok) {
      await emitDeliveryLifecycleEvent(ctx, updatedResult.value, "webhook.delivery_failed");
      await maybeAutoDisableEndpoint(ctx, attempt.orgId, attempt.endpointId);
    }
  }
}

// ── Fanout ────────────────────────────────────────────────────

export async function dispatchNewEvents(ctx: DeliveryContext): Promise<{ dispatched: number; errors: number }> {
  let dispatched = 0;
  let errors = 0;

  // 1. Find orgs with active subscriptions
  const orgsResult = await ctx.webhookRepo.listActiveOrgIds();
  if (!orgsResult.ok) return { dispatched: 0, errors: 1 };

  for (const orgId of orgsResult.value) {
    // 2. Get dispatch cursor for this org
    const cursorResult = await ctx.webhookRepo.getDispatchCursor(orgId);
    if (!cursorResult.ok) { errors++; continue; }
    const cursor = cursorResult.value;

    // 3. Query new events since cursor
    const eventsResult = await ctx.eventsRepo.queryEventsByOrg(
      orgId,
      cursor.lastOccurredAt,
      cursor.lastEventId,
      MAX_EVENTS_PER_ORG,
    );
    if (!eventsResult.ok) { errors++; continue; }
    if (eventsResult.value.length === 0) continue;

    let lastEvent: StoredEvent | null = null;

    for (const event of eventsResult.value) {
      // ── Recursion guard: skip webhook lifecycle events to prevent unbounded loops ──
      // Delivering webhook.delivery_succeeded, webhook.delivery_failed, or webhook.disabled
      // would create new delivery attempts → new lifecycle events → infinite recursion.
      if (isWebhookLifecycleEvent(event.type)) {
        lastEvent = event; // still advance cursor past lifecycle events
        continue;
      }

      // 4. Find matching subscriptions
      const subsResult = await ctx.webhookRepo.findMatchingSubscriptions(orgId, event.type);
      if (!subsResult.ok) { errors++; continue; }

      for (const sub of subsResult.value) {
        // 5. Create delivery attempt
        const attemptId = crypto.randomUUID();
        const idempotencyKey = `${sub.id}:${event.id}:1`;
        const createResult = await ctx.webhookRepo.createDeliveryAttempt({
          id: attemptId,
          orgId,
          endpointId: sub.endpointId,
          subscriptionId: sub.id,
          eventId: event.id,
          eventType: event.type,
          idempotencyKey,
        });

        if (!createResult.ok) {
          // Likely idempotency conflict — skip
          continue;
        }

        // 6. Resolve endpoint and deliver
        const epResult = await ctx.webhookRepo.getEndpointForDelivery(orgId, sub.endpointId);
        if (!epResult.ok) { errors++; continue; }

        await deliverAttempt(ctx, createResult.value, event, epResult.value);
        dispatched++;
      }

      lastEvent = event;
    }

    // 7. Advance cursor
    if (lastEvent) {
      await ctx.webhookRepo.advanceDispatchCursor(
        orgId,
        lastEvent.id,
        lastEvent.occurredAt.toISOString(),
      );
    }
  }

  return { dispatched, errors };
}

// ── Retry ────────────────────────────────────────────────────

export async function retryFailedDeliveries(ctx: DeliveryContext): Promise<{ retried: number; errors: number }> {
  let retried = 0;
  let errors = 0;

  const result = await ctx.webhookRepo.listRetryableDeliveries(MAX_RETRY_BATCH);
  if (!result.ok) return { retried: 0, errors: 1 };

  for (const attempt of result.value) {
    try {
      await deliverAttempt(ctx, attempt, null, null);
      retried++;
    } catch {
      errors++;
    }
  }

  return { retried, errors };
}

// ── Manual replay ─────────────────────────────────────────────

/**
 * Manually replay a past delivery attempt: create a FRESH delivery attempt for
 * the same `(endpointId, subscriptionId, eventId, eventType)` and deliver it
 * through the single `deliverAttempt` chokepoint.
 *
 * Unlike the automatic `retryFailedDeliveries()` path (which passes
 * `event=null` → `data:{}`), a buyer-credible manual replay resends the FULL
 * original payload, so the caller rehydrates the `StoredEvent` by id and passes
 * it through here. When `event` is null (original event no longer present), the
 * delivery still proceeds with `data:{}` — same degradation as the auto-retry
 * path — rather than failing the replay.
 *
 * The new attempt:
 *   - gets a fresh uuid and starts at `attemptNumber = 1` (the
 *     `createDeliveryAttempt` column default — symmetric to a first dispatch).
 *   - uses a replay-distinct idempotency key
 *     `${subscriptionId}:${eventId}:replay:${newAttemptId}` that can NEVER
 *     collide with the dispatch key `${subscriptionId}:${eventId}:1` or another
 *     replay (the new uuid is unique).
 *   - flows through `deliverAttempt`, inheriting ALL existing semantics
 *     unchanged: endpoint resolution, the `status!=='active'` →
 *     `endpoint_disabled` terminal gate, HMAC signing + dual-signature grace
 *     window, retry/backoff scheduling, success/failure lifecycle events, and
 *     the consecutive-failure auto-disable check.
 *
 * Returns the new attempt's post-delivery row (re-read to capture the terminal
 * status). `create_failed` is returned only when the initial insert fails.
 */
export async function replayDeliveryAttempt(
  ctx: DeliveryContext,
  original: WebhookDeliveryAttempt,
  event: StoredEvent | null,
): Promise<
  | { ok: true; value: WebhookDeliveryAttempt }
  | { ok: false; error: "create_failed" }
> {
  const newAttemptId = crypto.randomUUID();
  const idempotencyKey = `${original.subscriptionId}:${original.eventId}:replay:${newAttemptId}`;

  const createResult = await ctx.webhookRepo.createDeliveryAttempt({
    id: newAttemptId,
    orgId: original.orgId,
    endpointId: original.endpointId,
    subscriptionId: original.subscriptionId,
    eventId: original.eventId,
    eventType: original.eventType,
    idempotencyKey,
  });
  if (!createResult.ok) {
    return { ok: false, error: "create_failed" };
  }

  // Single delivery chokepoint — do NOT fork a second delivery path.
  await deliverAttempt(ctx, createResult.value, event, null);

  // Re-read to surface the post-delivery terminal status to the caller. If the
  // read-back fails (infra), the delivery still happened; fall back to the
  // freshly-created (pending) row rather than reporting a replay failure.
  const finalResult = await ctx.webhookRepo.getDeliveryAttempt(original.orgId, newAttemptId);
  if (!finalResult.ok) {
    return { ok: true, value: createResult.value };
  }
  return { ok: true, value: finalResult.value };
}
