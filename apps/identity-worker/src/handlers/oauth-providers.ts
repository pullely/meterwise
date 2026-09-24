import type { Env } from "../env.js";
import type { OAuthProvidersResponse } from "@saas/contracts/auth";
import { successResponse } from "../http.js";
import { listEnabledProviderInfos } from "../oauth/providers.js";

/**
 * GET /v1/auth/oauth/providers
 *
 * Public, pre-auth. Lists the OAuth providers that are fully configured so the
 * console only renders buttons for sign-in paths that will actually work.
 */
export function handleOAuthProviders(env: Env, requestId: string): Response {
  const response: OAuthProvidersResponse = { providers: listEnabledProviderInfos(env) };
  return successResponse(response, requestId, 200);
}
