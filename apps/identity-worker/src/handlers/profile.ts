import type { Env } from "../env.js";
import type { IdentityRepository } from "@saas/db/identity";
import { createSqlExecutor } from "@saas/db/d1";
import { createIdentityRepository } from "@saas/db/identity";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, extractBearerToken, validationError, withTimings } from "../http.js";
import { createTimings } from "@saas/contracts/timing";
import { parseSessionToken } from "../ids.js";

const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_LAST_ORG_SLUG_LENGTH = 100;
const ALLOWED_FIELDS = new Set(["displayName", "lastOrgSlug"]);

export interface HandleProfileDeps {
  repo?: IdentityRepository;
}

export async function handleProfile(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleProfileDeps,
): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.repo ?? createIdentityRepository(executor!);
    const auth = createAuthService({
      repo,
      now: () => new Date(),
      ctx: { requestId, ip: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") },
    });

    if (request.method === "GET") {
      // PERF14b: profile reads bypass the edge bearer cache (design §3), so
      // every GET pays the DB-backed resolve — time it.
      const timings = createTimings();
      const endTotal = timings.start("total");
      const route = "identity.profile.get";
      const result = await timings.measure("resolve", () => auth.getProfile(token));
      endTotal();
      if ("error" in result) {
        return withTimings(errorResponse(result.error, result.message, 401, requestId), requestId, route, timings);
      }
      return withTimings(successResponse({ user: result.user }, requestId, 200), requestId, route, timings);
    }

    // PATCH
    // Reject API-key/service-principal tokens
    if (!parseSessionToken(token)) {
      return errorResponse("forbidden", "API keys cannot update user profiles", 403, requestId);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return validationError(requestId, { body: ["Must be a valid JSON object"] });
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return validationError(requestId, { body: ["Must be a JSON object"] });
    }

    const bodyObj = body as Record<string, unknown>;

    // Check for unsupported fields
    const unsupportedFields = Object.keys(bodyObj).filter((k) => !ALLOWED_FIELDS.has(k));
    if (unsupportedFields.length > 0) {
      const fields: Record<string, string[]> = {};
      for (const f of unsupportedFields) {
        fields[f] = ["Unsupported field"];
      }
      return validationError(requestId, fields);
    }

    // Partial update: validate only the provided fields; require at least one.
    const patch: { displayName?: string | null; lastOrgSlug?: string | null } = {};

    if ("displayName" in bodyObj) {
      const rawDisplayName = bodyObj.displayName;
      if (rawDisplayName !== null && typeof rawDisplayName !== "string") {
        return validationError(requestId, { displayName: ["Must be a string or null"] });
      }
      let displayName: string | null = null;
      if (typeof rawDisplayName === "string") {
        const trimmed = rawDisplayName.trim();
        if (trimmed === "") {
          displayName = null;
        } else if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
          return validationError(requestId, { displayName: [`Must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`] });
        } else {
          displayName = trimmed;
        }
      }
      patch.displayName = displayName;
    }

    if ("lastOrgSlug" in bodyObj) {
      const rawSlug = bodyObj.lastOrgSlug;
      if (rawSlug !== null && typeof rawSlug !== "string") {
        return validationError(requestId, { lastOrgSlug: ["Must be a string or null"] });
      }
      let lastOrgSlug: string | null = null;
      if (typeof rawSlug === "string") {
        const trimmed = rawSlug.trim();
        if (trimmed === "") {
          lastOrgSlug = null;
        } else if (trimmed.length > MAX_LAST_ORG_SLUG_LENGTH) {
          return validationError(requestId, {
            lastOrgSlug: [`Must be at most ${MAX_LAST_ORG_SLUG_LENGTH} characters`],
          });
        } else {
          lastOrgSlug = trimmed;
        }
      }
      patch.lastOrgSlug = lastOrgSlug;
    }

    if (Object.keys(patch).length === 0) {
      return validationError(requestId, { body: ["Provide at least one of: displayName, lastOrgSlug"] });
    }

    const result = await auth.updateProfile(token, patch);
    if ("error" in result) {
      if (result.error === "unauthenticated") {
        return errorResponse(result.error, result.message, 401, requestId);
      }
      if (result.error === "forbidden") {
        return errorResponse(result.error, result.message, 403, requestId);
      }
      if (result.error === "validation_failed") {
        return validationError(requestId, (result.details as Record<string, string[]>) ?? {});
      }
      return errorResponse("internal_error", result.message, 500, requestId);
    }

    return successResponse({ user: result.user }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
