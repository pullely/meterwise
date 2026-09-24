import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createIdentityRepository } from "@saas/db/identity";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, extractBearerToken } from "../http.js";
import { extractRequestContext } from "../request-context.js";

export async function handleLogout(request: Request, env: Env, requestId: string): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createIdentityRepository(executor);
    const ctx = extractRequestContext(request, requestId);
    const auth = createAuthService({ repo, now: () => new Date(), ctx });
    const result = await auth.logout(token);

    if ("error" in result) {
      const status = result.error === "internal_error" ? 500 : 401;
      return errorResponse(result.error, result.message, status, requestId);
    }

    return successResponse({ success: true }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
