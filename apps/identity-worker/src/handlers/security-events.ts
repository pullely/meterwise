import type { Env } from "../env.js";
import type { SecurityEvent, IdentityRepository } from "@saas/db/identity";
import type { PublicSecurityEvent } from "@saas/contracts/security-events";
import { createSqlExecutor } from "@saas/db/d1";
import { createIdentityRepository } from "@saas/db/identity";
import { createAuthService } from "../services/auth.js";
import { errorResponse, extractBearerToken, validationError } from "../http.js";
import { parsePageParams, encodeCursor } from "../pagination.js";

/** Secret-bearing metadata keys that must never appear in public responses. */
const SENSITIVE_KEYS = new Set([
  "code",
  "codeHash",
  "tokenHash",
  "token",
  "secret",
  "apiKey",
  "bearerToken",
  "rawCode",
  "tokenSecret",
  "providerSecret",
]);

export interface HandleSecurityEventsDeps {
  repo?: IdentityRepository;
}

function redactMetadata(
  metadata: Record<string, unknown>,
  redactPaths: string[],
): Record<string, unknown> {
  if (Object.keys(metadata).length === 0 && redactPaths.length === 0) return {};

  const copy = structuredClone(metadata);

  // Apply stored redactPaths
  for (const rawPath of redactPaths) {
    let normalized = rawPath;
    if (normalized.startsWith("$.")) normalized = normalized.slice(2);
    if (normalized.startsWith("metadata.")) normalized = normalized.slice(9);
    const parts = normalized.split(".");
    let target: Record<string, unknown> = copy;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (target[part] && typeof target[part] === "object" && !Array.isArray(target[part])) {
        target = target[part] as Record<string, unknown>;
      } else {
        target = undefined as unknown as Record<string, unknown>;
        break;
      }
    }
    if (target) {
      const lastKey = parts[parts.length - 1]!;
      if (lastKey in target) {
        target[lastKey] = "[REDACTED]";
      }
    }
  }

  // Strip any known sensitive keys that weren't covered by redactPaths
  for (const key of Object.keys(copy)) {
    if (SENSITIVE_KEYS.has(key)) {
      copy[key] = "[REDACTED]";
    }
  }

  return copy;
}

function toPublicSecurityEvent(event: SecurityEvent): PublicSecurityEvent {
  return {
    id: event.id,
    eventType: event.eventType,
    outcome: event.outcome,
    occurredAt: event.occurredAt.toISOString(),
    requestId: event.requestId,
    correlationId: event.correlationId,
    ip: event.ip,
    userAgent: event.userAgent,
    metadata: redactMetadata(event.metadata, event.redactPaths),
  };
}

export async function handleSecurityEvents(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleSecurityEventsDeps,
): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const url = new URL(request.url);
  const pageResult = parsePageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.repo ?? createIdentityRepository(executor!);
    const auth = createAuthService({ repo, now: () => new Date() });
    const sessionResult = await auth.getSession(token);

    if ("error" in sessionResult) {
      return errorResponse(sessionResult.error, sessionResult.message, 401, requestId);
    }

    const userId = sessionResult.user.id;
    const { limit, cursor } = pageResult.value;
    const dbCursor = cursor ? { occurredAt: cursor.occurredAt, id: cursor.id } : null;

    const result = await repo.querySecurityEventsByUser({ userId, limit, cursor: dbCursor });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const securityEvents = result.value.items.map(toPublicSecurityEvent);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.occurredAt, result.value.nextCursor.id)
      : null;

    return Response.json(
      {
        data: { securityEvents },
        meta: { requestId, cursor: nextCursor },
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
