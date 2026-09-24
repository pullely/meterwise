import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, Scope } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { toPublicSetting } from "../mappers.js";
import { scopeMatchesRequested } from "../scope-match.js";
import type { PolicyResource } from "@saas/contracts/policy";

export interface UpdateSettingDeps {
  repo: Pick<ConfigRepository, "getSetting" | "updateSetting">;
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

export async function handleUpdateSetting(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  requestedScope: Scope,
  settingId: string,
  deps?: UpdateSettingDeps,
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

  const { value, description } = body as { value?: unknown; description?: unknown };
  const fields: Record<string, string[]> = {};

  if (value === undefined) {
    fields.value = ["A value is required"];
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

  const genId = deps?.generateId ?? (() => randomHex(16));
  const now = deps?.now ? deps.now() : new Date();

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    if (executor && "transaction" in executor) {
      const txResult = await executor.transaction(async (txExec) => {
        const txRepo = createConfigRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        // Get setting to determine scope for authz
        const existing = await txRepo.getSetting(orgId, settingId);
        if (!existing.ok) {
          return { result: existing };
        }

        // Verify requested route scope matches stored row scope
        if (!scopeMatchesRequested(existing.value, requestedScope)) {
          return { result: { ok: false as const, error: { kind: "not_found" as const } } };
        }

        // Authorize based on existing setting scope
        const setting = existing.value;
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

        const policyAction = setting.scopeKind === "organization" ? "organization.config.write" : "project.config.write";
        const resource: PolicyResource = { kind: setting.scopeKind === "organization" ? "organization" : "project", orgId };
        if (setting.projectId) {
          resource.projectId = setting.projectId;
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

        const result = await txRepo.updateSetting(orgId, settingId, {
          value,
          description: (description as string) ?? undefined,
        });

        if (!result.ok) {
          return { result };
        }

        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "settings.updated",
            version: 1,
            source: "config-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            projectId: setting.projectId,
            environmentId: setting.environmentId,
            subjectKind: "setting",
            subjectId: settingId,
            requestId,
            payload: {
              operation: "update",
              scope: setting.scopeKind,
              key: setting.key,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Setting updated: ${setting.key}`,
            projectId: setting.projectId,
            environmentId: setting.environmentId,
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
          return errorResponse("not_found", "Setting not found", 404, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      return successResponse({ setting: toPublicSetting(txResult.result.value) }, requestId);
    }

    // Non-transactional path (deps injection for tests)
    if (deps) {
      // Scope match check: get the existing row and verify route scope matches
      const existing = await deps.repo.getSetting(orgId, settingId);
      if (!existing.ok) {
        const err = existing.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Setting not found", 404, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      if (!scopeMatchesRequested(existing.value, requestedScope)) {
        return errorResponse("not_found", "Setting not found", 404, requestId);
      }

      const result = await deps.repo.updateSetting(orgId, settingId, {
        value,
        description: (description as string) ?? undefined,
      });

      if (!result.ok) {
        const err = result.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Setting not found", 404, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      if (deps.eventsRepo) {
        const eventResult = await deps.eventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "settings.updated",
            version: 1,
            source: "config-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            subjectKind: "setting",
            subjectId: settingId,
            requestId,
            payload: {
              operation: "update",
              scope: result.value.scopeKind,
              key: result.value.key,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Setting updated: ${result.value.key}`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }
      }

      return successResponse({ setting: toPublicSetting(result.value) }, requestId);
    }

    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
