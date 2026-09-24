export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
  DEBUG_DELIVERY: string;
  // M0 / Solo profile switch. "true" auto-provisions one invisible personal
  // organization per user on first session (see ./solo-mode.ts); absent or any
  // other value keeps the baseline (no auto-org). Deploy-time var, not a secret.
  SOLO_MODE?: string;

  // --- OAuth sign-in (B1) ---
  // Non-secret vars live in wrangler.jsonc; secrets are set via
  // `wrangler secret put`. A provider is "enabled" only when its client
  // credentials AND the shared runtime config (state secret + redirect base)
  // are all present — otherwise the console shows no button and `start` 400s.

  /** GitHub OAuth App client id (non-secret config). */
  GITHUB_OAUTH_CLIENT_ID?: string;
  /** GitHub OAuth App client secret (secret). */
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** Google OAuth 2.0 client id (non-secret config). */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  /** Google OAuth 2.0 client secret (secret). */
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** HMAC signing secret for the stateless OAuth `state` token (secret). */
  OAUTH_STATE_SECRET?: string;
  /** Public api-edge origin fronting this worker; used to build the provider
   *  redirect_uri (must match the OAuth app's registered callback). */
  OAUTH_REDIRECT_BASE_URL?: string;
  /** Comma-separated console origins allowed as post-login redirect targets. */
  OAUTH_ALLOWED_CONSOLE_ORIGINS?: string;
}
