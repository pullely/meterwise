/**
 * Pure helpers for the account-scoped security-events panel.
 *
 * Kept dependency-free (no React, no `next/*`, no DOM) so the row view-model
 * shaping, "Load more" pagination accumulation, and outcome-badge logic can be
 * unit-tested in isolation. The React wiring lives in the account security page
 * (`app/(app)/account/security/page.tsx`); this file owns:
 *
 *   - outcome → badge-variant mapping (`securityOutcomeBadge`)
 *   - the row view-model shaper (`toSecurityRow`)
 *   - the "Load more" accumulation reducer (`appendSecurityPage`)
 *   - the timestamp shaper (`formatSecurityTimestamp`)
 *
 * Cursor handling mirrors the SDK contract: the continuation cursor is an
 * opaque base64 token surfaced by `SecurityEventsClient.listPage` as
 * `nextCursor` (sourced from `meta.cursor`, NOT a body field). Callers MUST
 * pass it back verbatim — never construct or parse it.
 *
 * The surface is account/actor-scoped (NOT org-scoped); the worker has already
 * stripped secrets/codes/credential material and applied redaction, so only
 * the safe `PublicSecurityEvent` fields are rendered.
 */

import type { PublicSecurityEvent } from "@saas/contracts/security-events";

/** Badge variants available in `components/ui/badge.tsx`. */
export type SecurityBadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "warning"
  | "success"
  | "outline";

/**
 * Map a security-event outcome to a badge variant + label.
 *
 *   - success → green success badge
 *   - failure → red destructive badge
 *
 * The `default` arm guards against a wire value that drifts ahead of the
 * contract and renders it as a neutral outline rather than throwing in the
 * render path.
 */
export function securityOutcomeBadge(outcome: string): {
  variant: SecurityBadgeVariant;
  label: string;
} {
  switch (outcome) {
    case "success":
      return { variant: "success", label: "Success" };
    case "failure":
      return { variant: "destructive", label: "Failure" };
    default:
      return { variant: "outline", label: String(outcome) };
  }
}

/** A flat view-model for a single security-event table row. */
export interface SecurityRow {
  id: string;
  eventType: string;
  outcome: string;
  badge: { variant: SecurityBadgeVariant; label: string };
  /** Absolute local timestamp of the event, or "—" when unparseable. */
  occurredAtLabel: string;
  /** Client IP, or "—" when the worker did not record one. */
  ip: string;
  /** User-agent string, or "—" when absent. */
  userAgent: string;
}

/**
 * Format an ISO timestamp to a short local date+time, tolerating null and
 * malformed values (returns the supplied fallback rather than "Invalid Date").
 */
export function formatSecurityTimestamp(
  value: string | null | undefined,
  fallback = "—",
): string {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString();
}

/** Shape a raw security event into a display row (safe fields only). */
export function toSecurityRow(ev: PublicSecurityEvent): SecurityRow {
  return {
    id: ev.id,
    eventType: ev.eventType,
    outcome: ev.outcome,
    badge: securityOutcomeBadge(ev.outcome),
    occurredAtLabel: formatSecurityTimestamp(ev.occurredAt),
    ip: ev.ip ?? "—",
    userAgent: ev.userAgent ?? "—",
  };
}

/** Accumulated state for the cursor-paginated security-events list. */
export interface SecurityEventsState {
  events: ReadonlyArray<PublicSecurityEvent>;
  /** Opaque continuation cursor; null when the last page has been reached. */
  cursor: string | null;
}

export const EMPTY_SECURITY_EVENTS: SecurityEventsState = {
  events: [],
  cursor: null,
};

/**
 * Fold a freshly-fetched page into the accumulated state.
 *
 * `reset` distinguishes the initial / refreshed load (replace the list) from a
 * "Load more" append (concatenate). De-duplication by event id guards against
 * a boundary event appearing on two adjacent pages — append is idempotent on
 * id.
 */
export function appendSecurityPage(
  prev: SecurityEventsState,
  page: {
    securityEvents: ReadonlyArray<PublicSecurityEvent>;
    nextCursor: string | null;
  },
  reset = false,
): SecurityEventsState {
  if (reset) {
    return { events: page.securityEvents.slice(), cursor: page.nextCursor };
  }
  const seen = new Set(prev.events.map((e) => e.id));
  const merged = prev.events.slice();
  for (const e of page.securityEvents) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      merged.push(e);
    }
  }
  return { events: merged, cursor: page.nextCursor };
}

/** Whether a "Load more" affordance should be shown. */
export function hasMoreSecurityEvents(state: SecurityEventsState): boolean {
  return state.cursor !== null;
}
