import type { Env } from "../env.js";
import { errorResponse, validationError } from "../http.js";
import { buildStateCookie } from "../oauth/cookies.js";
import {
  STATE_TTL_MS,
  buildProviderRedirectUri,
  getStateSecret,
  isAllowedReturnTo,
  isLocalEnv,
} from "../oauth/config.js";
import { getConfiguredProvider } from "../oauth/providers.js";
import { generateStateNonce, signState } from "../oauth/state.js";

const START_RE = /^\/v1\/auth\/oauth\/([^/]+)\/start$/;

/**
 * GET /v1/auth/oauth/{provider}/start?return_to={consoleCallbackUrl}
 *
 * Begins an OAuth login: validates the return target, mints a signed `state`
 * + matching state cookie, and 302s the browser to the provider's authorize
 * endpoint. This is a top-level browser navigation, not an XHR call.
 */
export async function handleOAuthStart(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const providerId = START_RE.exec(url.pathname)?.[1];
  if (!providerId) {
    return errorResponse("not_found", "Unknown OAuth provider", 404, requestId);
  }

  const cfg = getConfiguredProvider(env, providerId);
  const stateSecret = getStateSecret(env);
  const redirectUri = buildProviderRedirectUri(env, providerId);
  if (!cfg || !stateSecret || !redirectUri) {
    return errorResponse("unsupported", `OAuth provider '${providerId}' is not configured`, 400, requestId);
  }

  const returnTo = url.searchParams.get("return_to");
  if (!returnTo || !isAllowedReturnTo(returnTo, env)) {
    return validationError(requestId, { return_to: ["A valid, allow-listed return_to is required"] });
  }

  const nonce = generateStateNonce();
  const state = await signState(
    { n: nonce, p: providerId, r: returnTo, exp: Date.now() + STATE_TTL_MS },
    stateSecret,
  );
  const authorizeUrl = cfg.provider.buildAuthorizeUrl({ clientId: cfg.clientId, redirectUri, state });

  const headers = new Headers();
  headers.set("location", authorizeUrl);
  headers.set("cache-control", "no-store");
  headers.append(
    "set-cookie",
    buildStateCookie(nonce, { secure: !isLocalEnv(env), maxAgeSeconds: STATE_TTL_MS / 1000 }),
  );
  return new Response(null, { status: 302, headers });
}
