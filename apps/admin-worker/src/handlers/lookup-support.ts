import type { Env } from "../env.js";
import type { SupportActor } from "../support-auth.js";
import type {
  SupportRepository,
  SupportOrganizationProjection,
  SupportUserProjection,
} from "@saas/db/support";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createSupportRepository } from "@saas/db/support";
import { authorizeSupportAction } from "../support-auth.js";
import { successResponse, errorResponse } from "../http.js";
import {
  orgPublicId,
  userPublicId,
  parseOrgPublicId,
  parseUserPublicId,
  generateSupportActionUuid,
} from "../ids.js";
import { emitAccessDenied } from "./record-support-action.js";
import type { SupportRequestContext } from "./record-support-action.js";

// Test seam. When provided, the handler runs against an injected repo (no DB).
export interface LookupSupportDeps {
  supportRepo: Pick<SupportRepository, "lookupOrganizationForSupport" | "lookupUserForSupport">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
}

function publicOrg(p: SupportOrganizationProjection): Record<string, unknown> {
  return {
    orgId: orgPublicId(p.orgId),
    name: p.name,
    slug: p.slug,
    status: p.status,
    memberCount: p.memberCount,
    createdAt: p.createdAt.toISOString(),
  };
}

function publicUser(p: SupportUserProjection): Record<string, unknown> {
  return {
    userId: userPublicId(p.userId),
    email: p.email,
    displayName: p.displayName,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
  };
}

// Deny-by-default guard shared by both lookups. Returns null when authorized,
// or a 403 Response (after auditing the denial) when not.
async function guardSupportRead(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  targetOrgId: string,
  attemptedAction: string,
  now: Date,
  genId: () => string,
  deps?: LookupSupportDeps,
): Promise<Response | null> {
  const decision = authorizeSupportAction({
    actor: ctx.actor,
    supportRoleClaim: ctx.supportRoleClaim,
    systemOverride: ctx.systemOverride,
  });
  if (decision.allow) return null;

  const denialActor: SupportActor = ctx.actor ?? { subjectId: "anonymous", subjectType: "user" };
  const denialInput = {
    actor: denialActor,
    targetOrgId,
    attemptedAction,
    reason: decision.reason,
    requestId,
    occurredAt: now,
    genId,
  };
  if (deps?.eventsRepo) {
    await emitAccessDenied(env, { ...denialInput, deps: { supportRepo: {} as never, eventsRepo: deps.eventsRepo } });
  } else {
    await emitAccessDenied(env, denialInput);
  }
  return errorResponse("forbidden", "Support action denied", 403, requestId, { reason: decision.reason });
}

export async function handleLookupOrganizationForSupport(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  orgIdParam: string,
  deps?: LookupSupportDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const genId = deps?.generateId ?? (() => generateSupportActionUuid());

  const denied = await guardSupportRead(env, requestId, ctx, orgUuid, "support.organization.lookup", now, genId, deps);
  if (denied) return denied;

  if (deps) {
    const result = await deps.supportRepo.lookupOrganizationForSupport(orgUuid);
    if (!result.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    return successResponse({ organization: publicOrg(result.value) }, requestId, 200);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createSupportRepository(executor);
    const result = await repo.lookupOrganizationForSupport(orgUuid);
    if (!result.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }
    return successResponse({ organization: publicOrg(result.value) }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "Failed to look up organization", 500, requestId);
  } finally {
    await executor.dispose();
  }
}

export async function handleLookupUserForSupport(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  userIdParam: string,
  targetOrgIdParam: string | null,
  deps?: LookupSupportDeps,
): Promise<Response> {
  const userUuid = parseUserPublicId(userIdParam);
  if (!userUuid) {
    return errorResponse("not_found", "User not found", 404, requestId);
  }

  // A user lookup is still attributed to a target org for audit (the support
  // context the operator is working within). When absent, attribute to the user.
  const auditOrgId = targetOrgIdParam ? (parseOrgPublicId(targetOrgIdParam) ?? userUuid) : userUuid;

  const now = deps?.now ? deps.now() : new Date();
  const genId = deps?.generateId ?? (() => generateSupportActionUuid());

  const denied = await guardSupportRead(env, requestId, ctx, auditOrgId, "support.user.lookup", now, genId, deps);
  if (denied) return denied;

  if (deps) {
    const result = await deps.supportRepo.lookupUserForSupport(userUuid);
    if (!result.ok) {
      return errorResponse("not_found", "User not found", 404, requestId);
    }
    return successResponse({ user: publicUser(result.value) }, requestId, 200);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createSupportRepository(executor);
    const result = await repo.lookupUserForSupport(userUuid);
    if (!result.ok) {
      return errorResponse("not_found", "User not found", 404, requestId);
    }
    return successResponse({ user: publicUser(result.value) }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "Failed to look up user", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
