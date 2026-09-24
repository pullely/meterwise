import type {
  EnqueueNotificationRequest,
  EnqueueNotificationResponse,
} from "@saas/contracts/notifications";

/**
 * Best-effort internal client for `notifications-worker`.
 *
 * Posts the V1 enqueue contract to the internal route
 * `POST https://notifications.internal/v1/notifications` over the
 * `NOTIFICATIONS_WORKER` service binding, mirroring the established
 * internal-binding pattern (see `apps/notifications-worker/src/events-client.ts`).
 *
 * Best-effort semantics:
 *
 *   - missing binding (`env.NOTIFICATIONS_WORKER` undefined) → no-op
 *   - non-2xx response → returns `{ ok: false, reason: "non_2xx" }`
 *   - network throw / malformed JSON → returns `{ ok: false, reason }`
 *
 * The function NEVER throws. Call sites treat the result as advisory and
 * MUST NOT propagate notifications failures to the user-facing response —
 * the notifications surface is downstream of, and decoupled from, the
 * caller's primary lifecycle (auth, invitations, etc.).
 *
 * No secret material (raw codes, raw invitation tokens, provider responses)
 * MUST be placed in `templateData`. Allowed values are a bounded
 * redaction-safe subset (presentation hints + the message payload itself
 * where the payload IS the message — e.g. magic-link login codes — but
 * never the authoritative secret of the originating state — token hashes
 * are persisted server-side, never the raw token).
 */

export interface NotificationsEnvBinding {
  NOTIFICATIONS_WORKER?: Fetcher;
}

export interface NotificationsClientContext {
  /**
   * Caller identifier — e.g. `"identity-worker"`, `"membership-worker"`.
   * Forwarded as `x-internal-actor` for tracing / audit.
   */
  internalActor: string;
  /** Actor subject type as known to the caller (e.g. `"system"`, `"user"`). */
  actorSubjectType: string;
  /** Actor subject id as known to the caller. */
  actorSubjectId: string;
  /** Request id to propagate for tracing. */
  requestId: string;
}

export type EnqueueNotificationResult =
  | { ok: true; notificationId: string }
  | { ok: false; reason: "no_binding" | "non_2xx" | "network_error" | "bad_response" };

const ENQUEUE_URL = "https://notifications.internal/v1/notifications";

/**
 * Build a deterministic, template-scoped idempotency key for the
 * notifications-worker enqueue path.
 *
 * The `(orgId, idempotencyKey)` uniqueness invariant on the notifications
 * row drives the worker's `idempotent_hit` outcome — a retry of the same
 * logical event collapses to one row + (eventually) one provider attempt.
 *
 * Shape: `<scope>:<part>[:<part>...]`. `scope` SHOULD match the caller's
 * `templateKey` (e.g. `"auth.magic_link"`, `"invitation.created"`,
 * `"invitation.accepted"`) so two logically-distinct events that share
 * an upstream id never collide.
 *
 * Constraints (enforced at runtime):
 *   - `scope` and every `part` must be a non-empty string.
 *   - No `part` may contain whitespace, `:`, or any control character —
 *     keys end up in DB rows and logs and must be cheaply roundtrippable.
 *
 * Inputs MUST be values that are stable across retries of the same
 * logical action (e.g. a row id materialised by a prior commit, a
 * challenge id that is itself the durable handle for the challenge).
 * Callers MUST NOT pass raw secret material (tokens, codes, password
 * equivalents) — keys are persisted server-side.
 */
export function buildIdempotencyKey(scope: string, ...parts: string[]): string {
  if (typeof scope !== "string" || scope.length === 0) {
    throw new TypeError("buildIdempotencyKey: scope must be a non-empty string");
  }
  if (parts.length === 0) {
    throw new TypeError("buildIdempotencyKey: at least one part is required");
  }
  const segments = [scope, ...parts];
  for (const seg of segments) {
    if (typeof seg !== "string" || seg.length === 0) {
      throw new TypeError("buildIdempotencyKey: all segments must be non-empty strings");
    }
    if (/[\s:\u0000-\u001f\u007f]/.test(seg)) {
      throw new TypeError(
        "buildIdempotencyKey: segments must not contain whitespace, ':' or control characters",
      );
    }
  }
  return segments.join(":");
}

export async function enqueueNotification(
  env: NotificationsEnvBinding,
  ctx: NotificationsClientContext,
  request: EnqueueNotificationRequest,
): Promise<EnqueueNotificationResult> {
  if (!env.NOTIFICATIONS_WORKER) {
    return { ok: false, reason: "no_binding" };
  }

  let response: Response;
  try {
    response = await env.NOTIFICATIONS_WORKER.fetch(ENQUEUE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": ctx.requestId,
        "x-internal-actor": ctx.internalActor,
        "x-actor-subject-type": ctx.actorSubjectType,
        "x-actor-subject-id": ctx.actorSubjectId,
      },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }

  if (!response.ok) {
    return { ok: false, reason: "non_2xx" };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "bad_response" };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { ok: false, reason: "bad_response" };
  }

  const data = (parsed as { data: unknown }).data;
  if (
    !data ||
    typeof data !== "object" ||
    !("notification" in data)
  ) {
    return { ok: false, reason: "bad_response" };
  }

  const notification = (data as { notification: unknown }).notification;
  if (
    !notification ||
    typeof notification !== "object" ||
    typeof (notification as { id?: unknown }).id !== "string"
  ) {
    return { ok: false, reason: "bad_response" };
  }

  const resp = data as EnqueueNotificationResponse;
  return { ok: true, notificationId: resp.notification.id };
}
