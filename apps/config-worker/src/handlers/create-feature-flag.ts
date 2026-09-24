import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Scope } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import type { ConfigRepository } from "@saas/db/config";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { toPublicFeatureFlag } from "../mappers.js";
import type { PolicyResource } from "@saas/contracts/policy";

const FLAG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;

export interface CreateFeatureFlagDeps {
  repo: Pick<ConfigRepository, "createFeatureFlag">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function handleCreateFeatureFlag(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: CreateFeatureFlagDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be a JSON object"] });
  }

  const { flagKey, enabled, value, description } = body as {
    flagKey?: unknown;
    enabled?: unknown;
    value?: unknown;
    description?: unknown;
  };
  const fields: Record<string, string[]> = {};

  if (typeof flagKey !== "string" || !FLAG_KEY_RE.test(flagKey)) {
    fields.flagKey = ["A valid flag key is required (alphanumeric, dots, hyphens, underscores, 1-128 chars)"];
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    fields.enabled = ["Enabled must be a boolean"];
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    fields.description = ["Description must be a string or null"];
  }
  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!deps && !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  // Authorization
  if (!deps) {
    const contextResult = await fetchAuthorizationContext(
      env.MEMBERSHIP_WORKER!,
      actor.subjectId,
      actor.subjectType,
      scope.orgId,
      requestId,
    );
    if (!contextResult.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const policyAction = scope.kind === "organization" ? "organization.config.write" : "project.config.write";
    const resource: PolicyResource = { kind: scope.kind === "organization" ? "organization" : "project", orgId: scope.orgId };
    if ("projectId" in scope) {
      resource.projectId = scope.projectId;
    }

    const policyResult = await authorizeViaPolicy(
      env.POLICY_WORKER!,
      actor.subjectId,
      actor.subjectType,
      policyAction,
      resource,
      contextResult.memberships,
      requestId,
    );
    if (!policyResult.allow) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
  }

  const flagId = crypto.randomUUID();
  const genId = deps?.generateId ?? (() => randomHex(16));
  const now = deps?.now ? deps.now() : new Date();

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    if (executor && "transaction" in executor) {
      const txResult = await executor.transaction(async (txExec) => {
        const txRepo = createConfigRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        const result = await txRepo.createFeatureFlag({
          id: flagId,
          scope,
          flagKey: flagKey as string,
          enabled: (enabled as boolean) ?? false,
          value: value ?? undefined,
          description: (description as string) ?? undefined,
        });

        if (!result.ok) {
          return { result };
        }

        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "feature.updated",
            version: 1,
            source: "config-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: scope.orgId,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
            subjectKind: "feature_flag",
            subjectId: flagId,
            requestId,
            payload: {
              operation: "create",
              scope: scope.kind,
              flagKey: flagKey as string,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Feature flag created: ${flagKey as string}`,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }

        return { result };
      });

      if (!txResult.result.ok) {
        const err = txResult.result.error;
        if (err.kind === "conflict") {
          return errorResponse("conflict", "Feature flag already exists for this scope and key", 409, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      return successResponse({ featureFlag: toPublicFeatureFlag(txResult.result.value) }, requestId, 201);
    }

    // Non-transactional path (deps injection for tests)
    if (deps) {
      const result = await deps.repo.createFeatureFlag({
        id: flagId,
        scope,
        flagKey: flagKey as string,
        enabled: (enabled as boolean) ?? false,
        value: value ?? undefined,
        description: (description as string) ?? undefined,
      });

      if (!result.ok) {
        const err = result.error;
        if (err.kind === "conflict") {
          return errorResponse("conflict", "Feature flag already exists for this scope and key", 409, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      if (deps.eventsRepo) {
        const eventResult = await deps.eventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "feature.updated",
            version: 1,
            source: "config-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: scope.orgId,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
            subjectKind: "feature_flag",
            subjectId: flagId,
            requestId,
            payload: {
              operation: "create",
              scope: scope.kind,
              flagKey: flagKey as string,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Feature flag created: ${flagKey as string}`,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }
      }

      return successResponse({ featureFlag: toPublicFeatureFlag(result.value) }, requestId, 201);
    }

    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
