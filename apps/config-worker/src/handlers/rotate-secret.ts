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
import type { EncryptionAdapter } from "../encryption.js";

export interface RotateSecretDeps {
  repo: Pick<ConfigRepository, "getSecretMetadata" | "rotateSecretMetadata">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
  encryptionAdapter?: EncryptionAdapter | null;
}

/**
 * Fields that must never appear in a rotate-secret request body,
 * EXCEPT `value` which is now accepted for write-only encrypted storage.
 */
const SECRET_MATERIAL_FIELDS = [
  "plaintext",
  "secret",
  "ciphertext",
  "ciphertextEnvelope",
  "ciphertext_envelope",
  "hash",
  "token",
  "password",
  "credential",
];

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function handleRotateSecret(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  requestedScope: Scope,
  secretId: string,
  deps?: RotateSecretDeps,
): Promise<Response> {
  const orgId = requestedScope.orgId;

  // Parse body if JSON content-type is sent
  let secretValue: string | null = null;
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await request.json();
      if (body && typeof body === "object") {
        const raw = body as Record<string, unknown>;
        // Reject forbidden secret-material fields (except value)
        for (const f of SECRET_MATERIAL_FIELDS) {
          if (f in raw) {
            return errorResponse("validation_failed", "Secret material fields are not accepted on rotate", 422, requestId);
          }
        }
        // Accept `value` for write-only encrypted storage
        if ("value" in raw) {
          if (typeof raw.value !== "string" || raw.value.length === 0) {
            return errorResponse("validation_failed", "value must be a non-empty string", 422, requestId);
          }
          secretValue = raw.value as string;
        }
      }
    } catch {
      // Empty body is fine for rotate
    }
  }

  // Resolve encryption adapter
  let encryptionAdapter: EncryptionAdapter | null | undefined = deps?.encryptionAdapter;
  if (encryptionAdapter === undefined && !deps) {
    const { createEncryptionAdapter } = await import("../encryption.js");
    encryptionAdapter = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  }

  // If value is provided, encryption adapter is required
  if (secretValue && !encryptionAdapter) {
    return errorResponse("internal_error", "Encryption is not configured", 503, requestId);
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

  // Encrypt value before any DB mutation
  let ciphertextEnvelope: string | undefined;
  if (secretValue && encryptionAdapter) {
    try {
      const envelope = await encryptionAdapter.encrypt(secretValue);
      ciphertextEnvelope = JSON.stringify(envelope);
    } catch {
      return errorResponse("internal_error", "Encryption failed", 503, requestId);
    }
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

        const result = await txRepo.rotateSecretMetadata(orgId, secretId, ciphertextEnvelope);

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
              operation: "rotate",
              scope: secret.scopeKind,
              key: secret.secretKey,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata rotated: ${secret.secretKey}`,
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

      const result = await deps.repo.rotateSecretMetadata(orgId, secretId, ciphertextEnvelope);

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
              operation: "rotate",
              scope: result.value.scopeKind,
              key: result.value.secretKey,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata rotated: ${result.value.secretKey}`,
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
