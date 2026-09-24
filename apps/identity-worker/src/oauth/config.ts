// Env-derived OAuth configuration + redirect-target validation.
//
// All OAuth secrets/config arrive through the Worker `Env` (vars for non-secret
// values, `wrangler secret put` for secrets). Nothing here is hard-coded.

import type { Env } from "../env.js";

/** State + cookie TTL. The full GitHub round-trip is well under this. */
export const STATE_TTL_MS = 10 * 60 * 1000;

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isLocalEnv(env: Env): boolean {
  return (env.ENVIRONMENT ?? "local") === "local";
}

/** HMAC signing secret for the `state` token, or null when unset/too weak. */
export function getStateSecret(env: Env): string | null {
  const secret = env.OAUTH_STATE_SECRET;
  if (typeof secret !== "string" || secret.length < 16) return null;
  return secret;
}

/** Public api-edge origin fronting this worker, used to build the provider redirect_uri. */
export function getRedirectBaseOrigin(env: Env): string | null {
  const raw = env.OAUTH_REDIRECT_BASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** The provider's registered callback URL: `{redirectBase}/v1/auth/oauth/{provider}/callback`. */
export function buildProviderRedirectUri(env: Env, providerId: string): string | null {
  const base = getRedirectBaseOrigin(env);
  if (!base) return null;
  return `${base}/v1/auth/oauth/${providerId}/callback`;
}

function parseAllowedConsoleOrigins(env: Env): string[] {
  return (env.OAUTH_ALLOWED_CONSOLE_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Is `rawUrl` a permitted post-login redirect target? Prevents open-redirect:
 * only the configured console origins (plus localhost for dev) may be returned
 * to. We validate the ORIGIN, not the full URL.
 */
export function isAllowedReturnTo(rawUrl: string, env: Env): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const origin = parsed.origin;
  if (LOCALHOST_ORIGIN_RE.test(origin)) return true;
  return parseAllowedConsoleOrigins(env).includes(origin);
}
