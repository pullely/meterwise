import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PublicAuditEntry } from "@saas/contracts/events";
import type { StoredAuditEntry, EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, validationError, withTimings } from "../http.js";
import { parsePageParams, parseAuditFilters, encodeCursor } from "../pagination.js";
import { toPublicId, toPublicScopeId } from "../ids.js";
import { createTimings } from "@saas/contracts/timing";

const CATEGORY_RE = /^[a-z0-9_.\-]{1,64}$/;

export interface HandleListAuditDeps {
  eventsRepo?: EventsRepository;
}

function redactPayload(payload: Record<string, unknown>, redactPaths: string[]): Record<string, unknown> {
  if (redactPaths.length === 0) return payload;
  const copy = structuredClone(payload);
  for (const rawPath of redactPaths) {
    let normalized = rawPath;
    if (normalized.startsWith("$.")) normalized = normalized.slice(2);
    if (normalized.startsWith("payload.")) normalized = normalized.slice(8);
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
  return copy;
}

function toPublicAuditEntry(entry: StoredAuditEntry): PublicAuditEntry {
  const payload = redactPayload(entry.payload, entry.redactPaths);
  return {
    id: entry.id,
    eventId: entry.eventId,
    orgId: toPublicScopeId("org_", entry.orgId) ?? entry.orgId,
    projectId: toPublicScopeId("prj_", entry.projectId),
    environmentId: toPublicScopeId("env_", entry.environmentId),
    actorType: entry.actorType as PublicAuditEntry["actorType"],
    actorId: entry.actorId,
    eventType: entry.eventType,
    source: entry.source,
    category: entry.category,
    description: entry.description,
    subject: {
      kind: entry.subjectKind,
      id: toPublicId(entry.subjectKind, entry.subjectId),
      name: entry.subjectName,
    },
    occurredAt: entry.occurredAt.toISOString(),
    requestId: entry.requestId,
    correlationId: entry.correlationId,
    payload,
  };
}

export async function handleListAudit(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps?: HandleListAuditDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const url = new URL(request.url);

  const pageResult = parsePageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }

  const categoryParam = url.searchParams.get("category");
  if (categoryParam !== null && !CATEGORY_RE.test(categoryParam)) {
    return validationError(requestId, { category: ["Must be lowercase letters, numbers, underscore, hyphen, or dot (max 64 chars)"] });
  }

  const filtersResult = parseAuditFilters(url);
  if (!filtersResult.ok) {
    return validationError(requestId, { [filtersResult.field]: [filtersResult.reason] });
  }

  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { occurredAt: cursor.occurredAt, id: cursor.id } : null;

  const executor = createSqlExecutor(env.PLATFORM_DB);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.eventsRepo ?? createEventsRepository(executor);

    // PERF4 (task 0133): the authorization-context fetch (membership-worker) and
    // the resource read are independent — the read does not depend on the authz
    // result for WHAT to read, only on WHETHER to return it. Run them
    // concurrently, then apply the policy decision and discard the read on deny.
    const [contextResult, result] = await Promise.all([
      timings.measure("authctx", () =>
        fetchAuthorizationContext(
          env.MEMBERSHIP_WORKER!,
          actor.subjectId,
          actor.subjectType,
          orgId,
          requestId,
        ),
      ),
      timings.measure("db", () =>
        repo.queryAuditByOrg(
          orgId,
          { limit, cursor: dbCursor },
          categoryParam ?? undefined,
          filtersResult.value,
        ),
      ),
    ]);

    if (!contextResult.ok) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "audit.read", timings);
    }

    const policyResult = await timings.measure("policy", () =>
      authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        "audit.read",
        { kind: "organization", orgId },
        contextResult.memberships,
        requestId,
      ),
    );
    if (!policyResult.allow) {
      // Deny-by-default: never return the speculatively-read data.
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "audit.read", timings);
    }

    if (!result.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "audit.read", timings);
    }

    const auditEntries = result.value.items.map(toPublicAuditEntry);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.occurredAt, result.value.nextCursor.id)
      : null;

    endTotal();
    return withTimings(
      Response.json(
        {
          data: { auditEntries },
          meta: { requestId, cursor: nextCursor },
        },
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      requestId,
      "audit.read",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "audit.read", timings);
  } finally {
    await executor.dispose();
  }
}
