"use client";

/**
 * Last-used organization persistence.
 *
 * We remember the org slug the operator was last working in and use it as the
 * default landing target (app root + post-login), so returning users skip the
 * org picker and go straight to where they left off — the pattern used by
 * Vercel/Linear/GitHub for "last active workspace".
 *
 * Storage is client-side localStorage, consistent with how the session token
 * and API target are already persisted (see `session.tsx`). It's a low-
 * sensitivity hint (just a slug); a stale/invalid value self-heals because the
 * org list and `OrgScope` clear it when the slug isn't accessible.
 *
 * Upgrade path: when a per-user preferences API exists, this can be backed by
 * the server instead so the default follows the user across devices/browsers.
 */

import { STORAGE_PREFIX } from "./app-config";
import { SOLO_MODE } from "./solo-mode";
import { pickAccountBillingOrg } from "@/components/billing/account-org";

const LAST_ORG_KEY = `${STORAGE_PREFIX}.last-org`;

export function readLastOrgSlug(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_ORG_KEY);
  } catch {
    return null;
  }
}

export function writeLastOrgSlug(slug: string): void {
  if (typeof window === "undefined" || !slug) return;
  try {
    window.localStorage.setItem(LAST_ORG_KEY, slug);
  } catch {
    /* ignore */
  }
}

export function clearLastOrgSlug(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LAST_ORG_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Default destination after auth / at the app root: the last-used org's projects
 * if one is remembered, otherwise onboarding. There is deliberately no org-less
 * landing view — an organization is the unit of work, so when we don't know one
 * we send the user to `/onboarding`, which either creates the first org or
 * forwards to an existing one. Pure given a slug so it's trivially testable;
 * callers pass `readLastOrgSlug()`.
 */
export function defaultOrgDestination(lastOrgSlug: string | null, soloMode: boolean = SOLO_MODE): string {
  if (!lastOrgSlug) return "/onboarding";
  // Solo: projects are suppressed, so the personal workspace's "dashboard" is
  // its Account (settings) surface — where the kept single-user features live
  // (account, notifications, billing, config). Baseline lands on projects.
  return soloMode ? `/orgs/${lastOrgSlug}/settings` : `/orgs/${lastOrgSlug}/projects`;
}

/** Minimal shape of the API client needed to resolve the post-auth destination. */
interface PostAuthClient {
  auth: { getProfile: () => Promise<{ user: { lastOrgSlug?: string | null } }> };
  organizations: {
    list: () => Promise<{ organizations: { id: string; slug: string; createdAt: string }[] }>;
  };
}

/**
 * Resolve where to send the user right after authentication.
 *
 * The server preference is the cross-device source of truth: we read it with the
 * freshly-authenticated client, seed the local cache from it, and route there.
 * Without a preference the org list decides: no orgs at all means a first
 * sign-in, which goes to mandatory onboarding (create the parent org + pick a
 * plan); otherwise we land on the account's billing-parent org. If every read
 * fails (network, API-key token) we fall back to the local cache so the
 * redirect is never blocked. Pass a client built with the NEW token — the
 * session context's client may not have it yet on this tick.
 */
export async function resolvePostAuthDestination(client: PostAuthClient): Promise<string> {
  try {
    const { user } = await client.auth.getProfile();
    const serverSlug = user.lastOrgSlug ?? null;
    if (serverSlug) {
      writeLastOrgSlug(serverSlug);
      return defaultOrgDestination(serverSlug);
    }
  } catch {
    /* fall through to the org list */
  }
  try {
    const { organizations } = await client.organizations.list();
    if (organizations.length === 0) return "/onboarding";
    const home = pickAccountBillingOrg(organizations)!;
    writeLastOrgSlug(home.slug);
    return defaultOrgDestination(home.slug);
  } catch {
    /* fall back to the local cache */
  }
  return defaultOrgDestination(readLastOrgSlug());
}
