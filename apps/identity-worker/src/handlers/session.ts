import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createIdentityRepository } from "@saas/db/identity";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, extractBearerToken, withTimings } from "../http.js";
import { createTimings } from "@saas/contracts/timing";

export async function handleSession(request: Request, env: Env, requestId: string): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  // PERF14b: the `resolve` phase times the DB-backed session+user lookup (a
  // single JOINed query since PERF12d).
  const timings = createTimings();
  const endTotal = timings.start("total");
  const route = "identity.session";
  try {
    const repo = createIdentityRepository(executor);
    const auth = createAuthService({ repo, now: () => new Date() });
    const result = await timings.measure("resolve", () => auth.getSession(token));
    endTotal();

    if ("error" in result) {
      return withTimings(errorResponse(result.error, result.message, 401, requestId), requestId, route, timings);
    }

    return withTimings(successResponse(
      {
        session: {
          id: result.session.id,
          expiresAt: result.session.expiresAt.toISOString(),
          createdAt: result.session.createdAt.toISOString(),
        },
        user: result.user,
      },
      requestId,
      200,
    ), requestId, route, timings);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
