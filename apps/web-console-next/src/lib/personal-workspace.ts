/**
 * M0 / Solo profile — naming for the one invisible personal workspace.
 *
 * Provisioning normally happens in the identity-worker's login path
 * (`apps/identity-worker/src/solo-mode.ts` → `ensurePersonalOrg`), which is
 * best-effort by design: it no-ops if the membership call doesn't land, so an
 * account can reach the console with zero organizations. The console's
 * onboarding surface is the documented fallback for exactly that case, and under
 * Solo it self-heals silently instead of asking a single-user product to "create
 * an organization".
 *
 * These rules MIRROR the identity worker's byte for byte. That is the point: the
 * slug is derived deterministically from the user id, so a console self-heal and
 * a later identity-side retry converge on the SAME organization — the loser of
 * the race gets a 409 (already exists) instead of creating a duplicate.
 *
 * Dependency-free (no React, no SDK) so both rules are unit-testable in
 * isolation, like the console's other pure models.
 */

const NAME_MAX = 100;
const SLUG_MAX = 63;

export interface WorkspaceUser {
  id: string;
  email: string;
  displayName?: string | null;
}

/**
 * Human name for the personal workspace: display name, else the email
 * local-part, else a stable fallback. Never shown as "an org" under Solo, but
 * kept meaningful for the audit trail and for a baseline restore.
 */
export function personalWorkspaceName(user: WorkspaceUser): string {
  const display = user.displayName?.trim();
  if (display) return display.slice(0, NAME_MAX);
  const local = user.email.split("@")[0]?.trim();
  if (local) return local.slice(0, NAME_MAX);
  return "Personal";
}

/**
 * Deterministic, globally-unique slug derived from the user id. Shaped to
 * satisfy membership's slug rule (`^[a-z0-9][a-z0-9-]*[a-z0-9]$`).
 */
export function personalWorkspaceSlug(userId: string): string {
  const body = userId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `personal-${body}`.slice(0, SLUG_MAX).replace(/-+$/g, "");
}
