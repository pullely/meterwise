import type { Env } from "../env.js";
import type { IdentityRepository } from "@saas/db/identity";
import { createSqlExecutor } from "@saas/db/d1";
import { createIdentityRepository } from "@saas/db/identity";
import { createAuthService } from "../services/auth.js";
import { errorResponse } from "../http.js";
import { extractRequestContext } from "../request-context.js";
import { clearStateCookie, readStateCookie } from "../oauth/cookies.js";
import {
  buildProviderRedirectUri,
  getStateSecret,
  isAllowedReturnTo,
  isLocalEnv,
} from "../oauth/config.js";
import { getConfiguredProvider, type OAuthProvider } from "../oauth/providers.js";
import { verifyState } from "../oauth/state.js";
import { ensurePersonalOrg } from "../solo-mode.js";

const CALLBACK_RE = /^\/v1\/auth\/oauth\/([^/]+)\/callback$/;

export interface HandleOAuthCallbackDeps {
  /** Injectable repository for unit tests (production path builds from the D1 binding). */
  repo?: IdentityRepository;
  /** Injectable provider override for unit tests (avoids real provider HTTP). */
  provider?: OAuthProvider;
}

/**
 * GET /v1/auth/oauth/{provider}/callback?code&state
 *
 * Completes an OAuth login. Verifies the signed `state` and the double-submit
 * cookie, exchanges the code, resolves/links/creates the user, issues a
 * session, and 302s back to the validated `return_to` with the token in the
 * URL fragment. All terminal outcomes also clear the state cookie.
 */
export async function handleOAuthCallback(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleOAuthCallbackDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const providerId = CALLBACK_RE.exec(url.pathname)?.[1];
  const secure = !isLocalEnv(env);

  // Redirect to the (already-validated) console target with a result fragment,
  // always clearing the one-time state cookie.
  function redirectToConsole(returnTo: string, fragment: string): Response {
    const headers = new Headers();
    headers.set("location", `${returnTo}#${fragment}`);
    headers.set("cache-control", "no-store");
    headers.append("set-cookie", clearStateCookie(secure));
    return new Response(null, { status: 302, headers });
  }

  const stateSecret = getStateSecret(env);
  const stateParam = url.searchParams.get("state");
  if (!providerId || !stateSecret || !stateParam) {
    return errorResponse("bad_request", "Invalid OAuth callback", 400, requestId);
  }

  const state = await verifyState(stateParam, stateSecret, Date.now());
  if (!state || state.p !== providerId) {
    return errorResponse("bad_request", "Invalid or expired OAuth state", 400, requestId);
  }

  // Double-submit: the cookie nonce must match the signed state nonce.
  const cookieNonce = readStateCookie(request);
  if (!cookieNonce || cookieNonce !== state.n) {
    return errorResponse("bad_request", "OAuth state verification failed", 400, requestId);
  }

  // Defense in depth: re-validate the return target before trusting it.
  if (!isAllowedReturnTo(state.r, env)) {
    return errorResponse("bad_request", "Invalid OAuth return target", 400, requestId);
  }

  // The user denied access (or the provider reported an error).
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return redirectToConsole(state.r, `error=${encodeURIComponent(providerError)}`);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return redirectToConsole(state.r, "error=missing_code");
  }

  const cfg = getConfiguredProvider(env, providerId);
  const redirectUri = buildProviderRedirectUri(env, providerId);
  if (!cfg || !redirectUri) {
    return redirectToConsole(state.r, "error=provider_unavailable");
  }
  const provider = deps?.provider ?? cfg.provider;

  // Exchange the code and fetch the provider identity.
  let identity;
  try {
    const accessToken = await provider.exchangeCode({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      redirectUri,
    });
    if (!accessToken) return redirectToConsole(state.r, "error=exchange_failed");
    identity = await provider.fetchIdentity(accessToken);
    if (!identity) return redirectToConsole(state.r, "error=identity_failed");
  } catch {
    return redirectToConsole(state.r, "error=oauth_failed");
  }

  if (!deps?.repo && !env.PLATFORM_DB) {
    return redirectToConsole(state.r, "error=server_error");
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createIdentityRepository(executor!);
    const ctx = extractRequestContext(request, requestId);
    const auth = createAuthService({ repo, now: () => new Date(), ctx });
    const result = await auth.loginWithOAuth({
      provider: providerId,
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified,
      displayName: identity.displayName,
    });

    if ("error" in result) {
      const reason =
        result.error === "email_required" || result.error === "email_unverified"
          ? result.error
          : "server_error";
      return redirectToConsole(state.r, `error=${reason}`);
    }

    // M0 / Solo profile: provision the user's invisible personal workspace
    // before handing the token back to the console. No-op off the profile.
    await ensurePersonalOrg(env, requestId, result.user);

    const fragment =
      `token=${encodeURIComponent(result.token)}` +
      `&token_type=bearer` +
      `&expires_at=${encodeURIComponent(result.expiresAt.toISOString())}`;
    return redirectToConsole(state.r, fragment);
  } catch {
    return redirectToConsole(state.r, "error=server_error");
  } finally {
    if (executor) await executor.dispose();
  }
}
