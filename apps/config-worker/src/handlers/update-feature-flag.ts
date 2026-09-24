import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, Scope, UpdateFeatureFlagInput } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { toPublicFeatureFlag } from "../mappers.js";
import { scopeMatchesRequested } from "../scope-match.js";
import type { PolicyResource } from "@saas/contracts/policy";

export interface UpdateFeatureFlagDeps {
  repo: Pick<ConfigRepository, "getFeatureFlag" | "updateFeatureFlag">;
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

export async function handleUpdateFeatureFlag(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  requestedScope: Scope,
  flagId: string,
  deps?: UpdateFeatureFlagDeps,
): Promise<Response> {
  const orgId = requestedScope.orgId;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be a JSON object"] });
  }

  const { enabled, value, description } = body as {
    enabled?: unknown;
    value?: unknown;
    description?: unknown;
  };
  const fields: Record<string, string[]> = {};

  if (enabled !== undefined && typeof enabled !== "boolean") {
    fields.enabled = ["Enabled must be a boolean"];
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    fields.description = ["Description must be a string or null"];
  }
  if (enabled === undefined && value === undefined && description === undefined) {
    fields.body = ["At least one field (enabled, value, description) must be provided"];
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

  const genId = deps?.generateId ?? (() => randomHex(16));
  const now = deps?.now ? deps.now() : new Date();

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    if (executor && "transaction" in executor) {
      const txResult = await executor.transaction(async (txExec) => {
        const txRepo = createConfigRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        // Get flag to determine scope for authz
        const existing = await txRepo.getFeatureFlag(orgId, flagId);
        if (!existing.ok) {
          return { result: existing };
        }

        // Verify requested route scope matches stored row scope
        if (!scopeMatchesRequested(existing.value, requestedScope)) {
          return { result: { ok: false as const, error: { kind: "not_found" as const } } };
        }

        const flag = existing.value;
        const contextResult = await fetchAuthorizationContext(
          env.MEMBERSHIP_WORKER!,
          actor.subjectId,
          actor.subjectType,
          orgId,
          requestId,
        );
        if (!contextResult.ok) {
          return { result: { ok: false as const, error: { kind: "not_found" as const } } };
        }

        const policyAction = flag.scopeKind === "organization" ? "organization.config.write" : "project.config.write";
        const resource: PolicyResource = { kind: flag.scopeKind === "organization" ? "organization" : "project", orgId };
        if (flag.projectId) {
          resource.projectId = flag.projectId;
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
          return { result: { ok: false as const, error: { kind: "not_found" as const } } };
        }

        const updateInput: UpdateFeatureFlagInput = {};
        if (enabled !== undefined) updateInput.enabled = enabled as boolean;
        if (value !== undefined) updateInput.value = value;
        if (description !== undefined && description !== null) updateInput.description = description as string;
        const result = await txRepo.updateFeatureFlag(orgId, flagId, updateInput);

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
            orgId,
            projectId: flag.projectId,
            environmentId: flag.environmentId,
            subjectKind: "feature_flag",
            subjectId: flagId,
            requestId,
            payload: {
              operation: "update",
              scope: flag.scopeKind,
              flagKey: flag.flagKey,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Feature flag updated: ${flag.flagKey}`,
            projectId: flag.projectId,
            environmentId: flag.environmentId,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }

        return { result };
      });

      if (!txResult.result.ok) {
        const err = txResult.result.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Feature flag not found", 404, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      return successResponse({ featureFlag: toPublicFeatureFlag(txResult.result.value) }, requestId);
    }

    // Non-transactional path (deps injection for tests)
    if (deps) {
      // Scope match check: get the existing row and verify route scope matches
      const existing = await deps.repo.getFeatureFlag(orgId, flagId);
      if (!existing.ok) {
        const err = existing.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Feature flag not found", 404, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      if (!scopeMatchesRequested(existing.value, requestedScope)) {
        return errorResponse("not_found", "Feature flag not found", 404, requestId);
      }

      const updateInput2: UpdateFeatureFlagInput = {};
      if (enabled !== undefined) updateInput2.enabled = enabled as boolean;
      if (value !== undefined) updateInput2.value = value;
      if (description !== undefined && description !== null) updateInput2.description = description as string;
      const result = await deps.repo.updateFeatureFlag(orgId, flagId, updateInput2);

      if (!result.ok) {
        const err = result.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Feature flag not found", 404, requestId);
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
            orgId,
            subjectKind: "feature_flag",
            subjectId: flagId,
            requestId,
            payload: {
              operation: "update",
              scope: result.value.scopeKind,
              flagKey: result.value.flagKey,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Feature flag updated: ${result.value.flagKey}`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }
      }

      return successResponse({ featureFlag: toPublicFeatureFlag(result.value) }, requestId);
    }

    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
