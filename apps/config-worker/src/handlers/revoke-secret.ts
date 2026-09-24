import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, Scope } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse } from "../http.js";
import { toPublicSecretMetadata } from "../mappers.js";
import { scopeMatchesRequested } from "../scope-match.js";
import type { PolicyResource } from "@saas/contracts/policy";

export interface RevokeSecretDeps {
  repo: Pick<ConfigRepository, "getSecretMetadata" | "revokeSecretMetadata">;
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

export async function handleRevokeSecret(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  requestedScope: Scope,
  secretId: string,
  deps?: RevokeSecretDeps,
): Promise<Response> {
  const orgId = requestedScope.orgId;

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

        const existing = await txRepo.getSecretMetadata(orgId, secretId);
        if (!existing.ok) {
          return { result: existing };
        }

        if (!scopeMatchesRequested(existing.value, requestedScope)) {
          return { result: { ok: false as const, error: { kind: "not_found" as const } } };
        }

        // Authorize
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

        const secret = existing.value;
        const policyAction = secret.scopeKind === "organization" ? "organization.config.write" : "project.config.write";
        const resource: PolicyResource = { kind: secret.scopeKind === "organization" ? "organization" : "project", orgId };
        if (secret.projectId) {
          resource.projectId = secret.projectId;
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

        const result = await txRepo.revokeSecretMetadata(orgId, secretId);

        if (!result.ok) {
          return { result };
        }

        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "secrets.updated",
            version: 1,
            source: "config-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            projectId: secret.projectId,
            environmentId: secret.environmentId,
            subjectKind: "secret",
            subjectId: secretId,
            requestId,
            payload: {
              operation: "revoke",
              scope: secret.scopeKind,
              key: secret.secretKey,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata revoked: ${secret.secretKey}`,
            projectId: secret.projectId,
            environmentId: secret.environmentId,
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
          return errorResponse("not_found", "Secret not found", 404, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      return successResponse({ secret: toPublicSecretMetadata(txResult.result.value) }, requestId);
    }

    // Non-transactional path (deps injection for tests)
    if (deps) {
      const existing = await deps.repo.getSecretMetadata(orgId, secretId);
      if (!existing.ok) {
        const err = existing.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Secret not found", 404, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      if (!scopeMatchesRequested(existing.value, requestedScope)) {
        return errorResponse("not_found", "Secret not found", 404, requestId);
      }

      const result = await deps.repo.revokeSecretMetadata(orgId, secretId);

      if (!result.ok) {
        const err = result.error;
        if (err.kind === "not_found") {
          return errorResponse("not_found", "Secret not found", 404, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      if (deps.eventsRepo) {
        const eventResult = await deps.eventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "secrets.updated",
            version: 1,
            source: "config-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            subjectKind: "secret",
            subjectId: secretId,
            requestId,
            payload: {
              operation: "revoke",
              scope: result.value.scopeKind,
              key: result.value.secretKey,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata revoked: ${result.value.secretKey}`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }
      }

      return successResponse({ secret: toPublicSecretMetadata(result.value) }, requestId);
    }

    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
