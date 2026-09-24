/**
 * Pure helpers for the webhook delivery-history panel.
 *
 * Kept dependency-free (no React, no `next/*`, no DOM) so the pagination
 * accumulation + status-badge + timestamp logic can be unit-tested in
 * isolation. The React wiring lives in the endpoint detail page
 * (`app/(app)/orgs/[orgSlug]/webhooks/[endpointId]/page.tsx`); this file owns:
 *
 *   - status → badge-variant mapping (`deliveryStatusBadge`)
 *   - the row view-model shaper (`toDeliveryRow`)
 *   - the "Load more" accumulation reducer (`appendDeliveryPage`)
 *
 * Cursor handling mirrors the SDK contract: the continuation cursor is an
 * opaque base64 token surfaced by `WebhooksClient.listDeliveryAttemptsPage`
 * as `nextCursor` (sourced from `meta.cursor`, NOT the vestigial body field).
 * Callers MUST pass it back verbatim — never construct or parse it.
 */

import type { PublicWebhookDeliveryAttempt } from "@saas/contracts";

/** Badge variants available in `components/ui/badge.tsx`. */
export type DeliveryBadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "warning"
  | "success"
  | "outline";

export type DeliveryStatus = PublicWebhookDeliveryAttempt["status"];

/**
 * Map a delivery-attempt status to a badge variant + label.
 *
 *   - success  → green success badge
 *   - failed   → red destructive badge
 *   - retrying → amber warning badge (transient; will be retried)
 *   - pending  → neutral secondary badge (not yet attempted)
 *
 * The status set is closed by the contract union, so the switch is
 * exhaustive; the `default` arm only guards against a wire value that
 * drifts ahead of the contract and renders it as a neutral outline rather
 * than throwing in the render path.
 */
export function deliveryStatusBadge(status: DeliveryStatus | string): {
  variant: DeliveryBadgeVariant;
  label: string;
} {
  switch (status) {
    case "success":
      return { variant: "success", label: "Success" };
    case "failed":
      return { variant: "destructive", label: "Failed" };
    case "retrying":
      return { variant: "warning", label: "Retrying" };
    case "pending":
      return { variant: "secondary", label: "Pending" };
    default:
      return { variant: "outline", label: String(status) };
  }
}

/** A flat view-model for a single delivery-attempt table row. */
export interface DeliveryRow {
  id: string;
  eventType: string;
  status: DeliveryStatus | string;
  badge: { variant: DeliveryBadgeVariant; label: string };
  attemptNumber: number;
  /** HTTP status code as text, or an em-dash when the attempt never reached the wire. */
  httpStatus: string;
  /** Safe failure summary, or null when the attempt did not fail. */
  failureReason: string | null;
  /** Absolute local timestamp of completion, or "—" when not yet completed. */
  completedAtLabel: string;
  /** Absolute local timestamp of next scheduled retry, or null. */
  nextRetryAtLabel: string | null;
  createdAtLabel: string;
}

/**
 * Format an ISO timestamp to a short local date+time, tolerating null and
 * malformed values (returns the supplied fallback rather than "Invalid Date").
 */
export function formatDeliveryTimestamp(
  value: string | null | undefined,
  fallback = "—",
): string {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString();
}

/** Shape a raw delivery attempt into a display row. */
export function toDeliveryRow(attempt: PublicWebhookDeliveryAttempt): DeliveryRow {
  return {
    id: attempt.id,
    eventType: attempt.eventType,
    status: attempt.status,
    badge: deliveryStatusBadge(attempt.status),
    attemptNumber: attempt.attemptNumber,
    httpStatus:
      attempt.httpStatusCode === null ? "—" : String(attempt.httpStatusCode),
    failureReason: attempt.failureReason,
    completedAtLabel: formatDeliveryTimestamp(attempt.completedAt),
    nextRetryAtLabel:
      attempt.nextRetryAt === null
        ? null
        : formatDeliveryTimestamp(attempt.nextRetryAt),
    createdAtLabel: formatDeliveryTimestamp(attempt.createdAt, "unknown"),
  };
}

/** Accumulated state for the cursor-paginated delivery-history list. */
export interface DeliveryHistoryState {
  attempts: ReadonlyArray<PublicWebhookDeliveryAttempt>;
  /** Opaque continuation cursor; null when the last page has been reached. */
  cursor: string | null;
}

export const EMPTY_DELIVERY_HISTORY: DeliveryHistoryState = {
  attempts: [],
  cursor: null,
};

/**
 * Fold a freshly-fetched page into the accumulated state.
 *
 * `reset` distinguishes the initial / refreshed load (replace the list) from a
 * "Load more" append (concatenate). De-duplication by attempt id guards against
 * a boundary attempt appearing on two adjacent pages if rows were inserted
 * between fetches — append is idempotent on id.
 */
export function appendDeliveryPage(
  prev: DeliveryHistoryState,
  page: {
    deliveryAttempts: ReadonlyArray<PublicWebhookDeliveryAttempt>;
    nextCursor: string | null;
  },
  reset = false,
): DeliveryHistoryState {
  if (reset) {
    return { attempts: page.deliveryAttempts.slice(), cursor: page.nextCursor };
  }
  const seen = new Set(prev.attempts.map((a) => a.id));
  const merged = prev.attempts.slice();
  for (const a of page.deliveryAttempts) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      merged.push(a);
    }
  }
  return { attempts: merged, cursor: page.nextCursor };
}

/** Whether a "Load more" affordance should be shown. */
export function hasMoreDeliveries(state: DeliveryHistoryState): boolean {
  return state.cursor !== null;
}

/**
 * Whether a delivery attempt is eligible for manual replay.
 *
 * Replay re-sends the same event to the same endpoint, so it only makes sense
 * for TERMINAL attempts — `success` (re-deliver a delivered event) or `failed`
 * (retry after the endpoint was fixed). In-flight attempts (`pending`,
 * `retrying`) are still owned by the automatic dispatch/retry path; offering
 * replay on them would race the cron and create a confusing duplicate, so the
 * Redeliver affordance is hidden/disabled for those states.
 */
export function canReplayAttempt(status: DeliveryStatus | string): boolean {
  return status === "success" || status === "failed";
}
