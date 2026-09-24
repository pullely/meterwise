import type { Env } from "../env.js";
import type { LoginStartResponse } from "@saas/contracts/auth";
import type { IdentityRepository } from "@saas/db/identity";
import { createSqlExecutor } from "@saas/db/d1";
import { createIdentityRepository } from "@saas/db/identity";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { extractRequestContext } from "../request-context.js";
import {
  enqueueNotification,
  buildIdempotencyKey,
} from "@saas/notifications-client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pre-org sentinel `orgId` for identity-level transactional notifications.
 *
 * Magic-link login happens BEFORE any org context is established (a single
 * user may belong to many orgs; the login challenge is identity-scoped).
 * The notifications row schema requires a UUID `org_id` (no FK), and this
 * zero UUID is already used elsewhere in the repo as a system sentinel
 * (see `config-worker` settings rows, COALESCE patterns in migrations 070
 * and 080). Using it here keeps the row well-formed without coupling
 * identity to membership.
 */
const SYSTEM_ORG_ID = "00000000-0000-0000-0000-000000000000";

export interface HandleLoginStartDeps {
  /**
   * Injectable repository for unit tests. When omitted, a real
   * `createSqlExecutor(env.PLATFORM_DB)` + `createIdentityRepository`
   * pair is used (production path).
   */
  repo?: IdentityRepository;
  /**
   * Injectable notifications enqueue for tests. When omitted, the real
   * `@saas/notifications-client` `enqueueNotification` is used (best-effort;
   * absent `env.NOTIFICATIONS_WORKER` binding is a no-op).
   */
  enqueueNotification?: typeof enqueueNotification;
}

export async function handleLoginStart(
  request: Request,
  env: Env,
  requestId: string,
  deps?: HandleLoginStartDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  if (!body || typeof body !== "object" || !("email" in body)) {
    return validationError(requestId, { email: ["Email is required"] });
  }

  const { email } = body as { email: unknown };
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return validationError(requestId, { email: ["A valid email address is required"] });
  }

  if (!deps?.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createIdentityRepository(executor!);
    const ctx = extractRequestContext(request, requestId);
    const auth = createAuthService({ repo, now: () => new Date(), ctx });
    const result = await auth.startLogin(email);

    if ("error" in result) {
      return errorResponse(result.error, result.message, 500, requestId);
    }

    const isDebug = env.DEBUG_DELIVERY === "true";

    // Non-debug path: enqueue a magic-link notification through
    // notifications-worker over the internal service binding. Best-effort —
    // a notifications failure must NOT 5xx the login response.
    //
    // Debug path: skip enqueue entirely. `code` is returned inline in the
    // response (existing local_debug contract), so emitting an additional
    // notification would be redundant and would write a `local-debug`
    // provider row for every dev call.
    if (!isDebug) {
      // Fire-and-forget intentionally: we do not propagate errors. Awaiting
      // here is safe — the client itself catches all failure modes and
      // returns a `{ ok: false, reason }` shape without throwing.
      const enqueueFn = deps?.enqueueNotification ?? enqueueNotification;
      await enqueueFn(
        env,
        {
          internalActor: "identity-worker",
          actorSubjectType: "system",
          actorSubjectId: "identity-worker",
          requestId,
        },
        {
          orgId: SYSTEM_ORG_ID,
          // Magic-link login is "identity proof / login challenge
          // validation" per spec 14 (line 40). The existing V1 contract
          // enumerates allowed categories as
          // invitation|billing|security|support|product (no
          // "transactional"); "security" is the auditable category for
          // this flow per spec 14 line 72.
          category: "security",
          templateKey: "auth.magic_link",
          templateData: {
            code: result.rawCode,
            emailHint: result.emailHint,
            expiresAt: result.expiresAt.toISOString(),
            requestId,
          },
          recipient: {
            channel: "email",
            address: email.trim().toLowerCase(),
          },
          // Stripe-quality idempotency: a Workers-runtime retry of this
          // login-start (same `challengeId`, same logical action) must
          // collapse to one notification row + one provider attempt.
          // `challengeId` is the durable, public-id handle for the
          // magic-link challenge row — created once, returned to the
          // caller, and unique per logical login attempt. It is NOT
          // secret material (the rawCode is hashed server-side; the
          // public id only references the row). Template-scoped to
          // prevent cross-template collisions on the same upstream id.
          idempotencyKey: buildIdempotencyKey("auth.magic_link", result.challengeId),
          correlationId: requestId,
        },
      );
    }

    const response: LoginStartResponse = {
      challengeId: result.challengeId,
      expiresAt: result.expiresAt.toISOString(),
      delivery: {
        mode: isDebug ? "local_debug" : "email",
        emailHint: result.emailHint,
        ...(isDebug ? { code: result.rawCode } : {}),
      },
    };

    return successResponse(response, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
