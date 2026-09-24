import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createIdentityRepository } from "@saas/db/identity";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { extractRequestContext } from "../request-context.js";
import { ensurePersonalOrg } from "../solo-mode.js";

const CODE_RE = /^\d{6}$/;

export async function handleLoginComplete(request: Request, env: Env, requestId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be a JSON object"] });
  }

  const { challengeId, code } = body as { challengeId?: unknown; code?: unknown };
  const errors: Record<string, string[]> = {};

  if (typeof challengeId !== "string" || !challengeId.trim()) {
    errors["challengeId"] = ["challengeId is required"];
  }
  if (typeof code !== "string" || !CODE_RE.test(code)) {
    errors["code"] = ["A valid 6-digit code is required"];
  }

  if (Object.keys(errors).length > 0) {
    return validationError(requestId, errors);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createIdentityRepository(executor);
    const ctx = extractRequestContext(request, requestId);
    const auth = createAuthService({ repo, now: () => new Date(), ctx });
    const result = await auth.completeLogin(challengeId as string, code as string);

    if ("error" in result) {
      const statusMap: Record<string, number> = {
        not_found: 404,
        precondition_failed: 422,
        internal_error: 500,
      };
      return errorResponse(result.error, result.message, statusMap[result.error] ?? 500, requestId);
    }

    // M0 / Solo profile: ensure the user's one invisible personal workspace
    // exists before the console loads. No-op (and zero latency) off the profile.
    await ensurePersonalOrg(env, requestId, result.user);

    return successResponse(
      {
        token: result.token,
        tokenType: "bearer" as const,
        expiresAt: result.expiresAt.toISOString(),
        user: result.user,
      },
      requestId,
      200,
    );
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
