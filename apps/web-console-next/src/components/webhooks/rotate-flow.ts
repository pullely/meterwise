/**
 * Pure helpers for the webhook signing-secret rotation flow.
 *
 * Kept dependency-free (no React, no `next/*`, no DOM) so the reveal-once
 * invariants can be unit-tested in isolation. The React component wiring
 * lives in `rotate-secret-dialog.tsx`; this file owns:
 *
 *   - the small state machine (`RotateState`, `nextRotateState`)
 *   - the grace-window formatter
 *
 * The reveal-once invariant is enforced at the state-machine level: the
 * `secret` field only ever exists on the `revealing` state, and the
 * `closeReveal` transition returns `idle` (no field at all) — so closing
 * the modal cannot leave the secret behind in the active state.
 */

export type RotateState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "rotating" }
  | {
      phase: "revealing";
      secret: string | null;
      previousSecretExpiresAt: string | null;
      gracePeriodSeconds: number;
    };

export type RotateEvent =
  | { type: "openConfirm" }
  | { type: "cancelConfirm" }
  | { type: "confirmRotate" }
  | { type: "rotateFailed" }
  | {
      type: "rotateSucceeded";
      secret: string | undefined;
      previousSecretExpiresAt: string | null;
      gracePeriodSeconds: number;
    }
  | { type: "closeReveal" };

/**
 * Drive the rotate flow forward.
 *
 * Invariants:
 *   - `confirmRotate` is only honored from `confirming` (no accidental rotate).
 *   - `closeReveal` ALWAYS resets to `idle`, dropping the secret. The caller
 *     must not retain the previous state object — pass the return value to
 *     `setState` and discard the prior one.
 *   - On `rotateSucceeded` with `secret === undefined` (legacy
 *     no-encryption-key path on the server), we still transition to
 *     `revealing` so the UI can render the "rotation completed; secret was
 *     not returned" affordance — but `secret` is `null`, never an empty
 *     string or placeholder.
 */
export function nextRotateState(state: RotateState, event: RotateEvent): RotateState {
  switch (state.phase) {
    case "idle":
      if (event.type === "openConfirm") return { phase: "confirming" };
      return state;
    case "confirming":
      if (event.type === "cancelConfirm") return { phase: "idle" };
      if (event.type === "confirmRotate") return { phase: "rotating" };
      return state;
    case "rotating":
      if (event.type === "rotateSucceeded") {
        return {
          phase: "revealing",
          secret: event.secret ?? null,
          previousSecretExpiresAt: event.previousSecretExpiresAt,
          gracePeriodSeconds: event.gracePeriodSeconds,
        };
      }
      if (event.type === "rotateFailed") return { phase: "idle" };
      return state;
    case "revealing":
      if (event.type === "closeReveal") return { phase: "idle" };
      return state;
  }
}

/**
 * Format `gracePeriodSeconds` as a short human duration. We don't pull in a
 * full duration library — the contract restricts this to a small set of
 * realistic values (server default is 86400, operator may override or set
 * 0). Keep the formatter tight and predictable.
 */
export function formatGraceDuration(gracePeriodSeconds: number): string {
  if (!Number.isFinite(gracePeriodSeconds) || gracePeriodSeconds <= 0) {
    return "no grace window";
  }
  const days = Math.floor(gracePeriodSeconds / 86400);
  const hours = Math.floor((gracePeriodSeconds % 86400) / 3600);
  const minutes = Math.floor((gracePeriodSeconds % 3600) / 60);
  if (days >= 1) {
    if (days === 1 && hours === 0) return "24 hours";
    if (hours === 0) return `${days} days`;
    return `${days}d ${hours}h`;
  }
  if (hours >= 1) {
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }
  if (minutes >= 1) return `${minutes}m`;
  return `${gracePeriodSeconds}s`;
}

/**
 * Long-form absolute timestamp + relative duration:
 *   "Jan 16, 2026, 10:00 AM UTC (in ~24 hours)"
 *
 * Falls back gracefully when `previousSecretExpiresAt` is null (no grace
 * window applied) — the calling component is expected to render different
 * copy in that case rather than relying on this formatter to invent one.
 */
export function formatGraceWindow(
  previousSecretExpiresAt: string | null,
  gracePeriodSeconds: number,
  now: Date = new Date(),
): { absolute: string; relative: string } | null {
  if (!previousSecretExpiresAt) return null;
  const target = new Date(previousSecretExpiresAt);
  if (Number.isNaN(target.getTime())) return null;
  const absolute = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(target);
  const deltaMs = target.getTime() - now.getTime();
  const relative =
    deltaMs <= 0
      ? "expired"
      : `in ~${formatGraceDuration(Math.round(deltaMs / 1000))}`;
  // gracePeriodSeconds is intentionally not embedded in the string — the
  // banner renders it separately so the operator can compare server policy
  // vs. wall-clock countdown.
  void gracePeriodSeconds;
  return { absolute, relative };
}
