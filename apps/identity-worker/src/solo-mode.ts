// M0 / Solo profile — auto-provisioning of the invisible personal workspace.
//
// In the Solo profile the user IS the tenant: on first session each user gets
// exactly ONE personal organization (with the `owner` role) that they never see
// as an org. This is the auth/session-path hook for that guarantee. It runs
// after a session is issued (magic-link complete + OAuth callback), is gated on
// the single SOLO_MODE switch, and is idempotent — a returning user (or a
// concurrent login that lost the create race) is a no-op.
//
// It is strictly best-effort: provisioning must NEVER fail a login. If the
// membership service is unreachable it simply no-ops; the next login retries,
// and the console's onboarding flow remains as the baseline fallback.
//
// Reuses the existing membership contract unchanged (no new endpoints, no schema
// change): GET /v1/organizations to check, POST /v1/organizations to bootstrap,
// both with the standard actor headers the api-edge would set. Flip SOLO_MODE
// off and this is inert — the baseline never auto-creates an org.

import type { Env } from "./env.js";

/** Is this instance running the M0/Solo profile? (deploy-time wrangler var) */
export function isSoloMode(env: Env): boolean {
  return env.SOLO_MODE === "true";
}

export interface PersonalOrgUser {
  /** Public user id — the same value the actor resolution returns, so the
   *  membership record this creates matches every later request's actor. */
  id: string;
  email: string;
  displayName?: string | null;
}

const NAME_MAX = 100;
const SLUG_MAX = 63;

/** Human name for the personal org: display name, else the email local-part,
 *  else a stable fallback. Never user-facing as "an org" in Solo, but kept
 *  meaningful for the audit trail and a baseline-restore. */
export function personalOrgName(user: PersonalOrgUser): string {
  const display = user.displayName?.trim();
  if (display) return display.slice(0, NAME_MAX);
  const local = user.email.split("@")[0]?.trim();
  if (local) return local.slice(0, NAME_MAX);
  return "Personal";
}

/** Deterministic, globally-unique slug derived from the user id. Determinism is
 *  what makes provisioning race-safe: two concurrent logins generate the same
 *  slug, so the loser hits a 409 (already exists) instead of a duplicate org.
 *  Shaped to satisfy membership's slug rule (^[a-z0-9][a-z0-9-]*[a-z0-9]$). */
export function personalOrgSlug(userId: string): string {
  const body = userId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `personal-${body}`.slice(0, SLUG_MAX).replace(/-+$/g, "");
}

/**
 * Ensure the user owns exactly one personal organization. No-op unless
 * SOLO_MODE is on and a membership binding is available. Never throws.
 */
export async function ensurePersonalOrg(
  env: Env,
  requestId: string,
  user: PersonalOrgUser,
): Promise<void> {
  if (!isSoloMode(env)) return;
  const membership = env.MEMBERSHIP_WORKER;
  if (!membership) return;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": requestId,
    "x-actor-subject-id": user.id,
    "x-actor-subject-type": "user",
    "x-actor-email": user.email,
  };

  try {
    // Idempotency: a returning user already has their workspace.
    const listRes = await membership.fetch(
      "https://membership.internal/v1/organizations?limit=1",
      { method: "GET", headers },
    );
    if (listRes.ok) {
      const body = (await listRes.json().catch(() => null)) as
        | { data?: { organizations?: unknown[] }; organizations?: unknown[] }
        | null;
      const orgs = body?.data?.organizations ?? body?.organizations ?? [];
      if (Array.isArray(orgs) && orgs.length > 0) return;
    }

    // Bootstrap the one personal workspace (membership assigns the owner role).
    // A 409 here means a concurrent login already created it — also success.
    await membership.fetch("https://membership.internal/v1/organizations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: personalOrgName(user),
        slug: personalOrgSlug(user.id),
      }),
    });
  } catch {
    // Best-effort by design — a provisioning hiccup must not break sign-in.
  }
}
