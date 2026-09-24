import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Scope, CreateSecretMetadataInput } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import type { ConfigRepository } from "@saas/db/config";
import { createConfigRepository } from "@saas/db/config";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { uuidFromPublicId } from "@saas/db";
import { toPublicSecretMetadata } from "../mappers.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type { EncryptionAdapter } from "../encryption.js";

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;

/**
 * Fields that must never appear in a create-secret request body,
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

export interface CreateSecretDeps {
  repo: Pick<ConfigRepository, "createSecretMetadata">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
  encryptionAdapter?: EncryptionAdapter | null;
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

export async function handleCreateSecret(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  scope: Scope,
  deps?: CreateSecretDeps,
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

  const raw = body as Record<string, unknown>;
  const fields: Record<string, string[]> = {};

  // Reject secret-material fields (except value, which is now accepted)
  for (const forbidden of SECRET_MATERIAL_FIELDS) {
    if (forbidden in raw) {
      fields[forbidden] = ["Secret material fields are not accepted"];
    }
  }

  const { secretKey, displayName, rotationPolicy, expiresAt, value } = raw as {
    secretKey?: unknown;
    displayName?: unknown;
    rotationPolicy?: unknown;
    expiresAt?: unknown;
    value?: unknown;
  };

  if (typeof secretKey !== "string" || !KEY_RE.test(secretKey)) {
    fields.secretKey = ["A valid secretKey is required (letters, digits, dots, hyphens, underscores; 1-128 chars)"];
  }
  if (displayName !== undefined && displayName !== null && typeof displayName !== "string") {
    fields.displayName = ["displayName must be a string or null"];
  }
  if (rotationPolicy !== undefined && rotationPolicy !== null && typeof rotationPolicy !== "string") {
    fields.rotationPolicy = ["rotationPolicy must be a string or null"];
  }
  if (value !== undefined && value !== null && typeof value !== "string") {
    fields.value = ["value must be a string"];
  }
  if (value !== undefined && value !== null && typeof value === "string" && value.length === 0) {
    fields.value = ["value must not be empty"];
  }

  let parsedExpiresAt: Date | undefined;
  if (expiresAt !== undefined && expiresAt !== null) {
    if (typeof expiresAt !== "string") {
      fields.expiresAt = ["expiresAt must be an ISO 8601 date string or null"];
    } else {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) {
        fields.expiresAt = ["expiresAt must be a valid ISO 8601 date string"];
      } else {
        parsedExpiresAt = d;
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  // Resolve encryption adapter
  let encryptionAdapter: EncryptionAdapter | null | undefined = deps?.encryptionAdapter;
  if (encryptionAdapter === undefined && !deps) {
    // Production path: lazy-import encryption adapter
    const { createEncryptionAdapter } = await import("../encryption.js");
    encryptionAdapter = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  }

  // If value is provided, encryption adapter is required
  const secretValue = typeof value === "string" ? value : null;
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

  const secretId = crypto.randomUUID();
  const genId = deps?.generateId ?? (() => randomHex(16));
  const now = deps?.now ? deps.now() : new Date();

  // config_secret_metadata.created_by is a UUID column; the actor id arrives as
  // the public `usr_<hex>` form. uuidFromPublicId returns a branded `Uuid`, which
  // is what CreateSecretMetadataInput.createdBy now requires (a raw string no
  // longer type-checks — a missing decode here is a compile error).
  const createdByUuid = uuidFromPublicId(actor.subjectId);
  if (!createdByUuid) return errorResponse("validation_failed", "Invalid actor id", 422, requestId);

  const baseInput = {
    id: secretId,
    scope,
    secretKey: secretKey as string,
    displayName: (displayName as string) ?? undefined,
    rotationPolicy: (rotationPolicy as string) ?? undefined,
    createdBy: createdByUuid,
  };
  const input: CreateSecretMetadataInput = parsedExpiresAt !== undefined
    ? { ...baseInput, expiresAt: parsedExpiresAt }
    : baseInput;
  if (ciphertextEnvelope !== undefined) {
    input.ciphertextEnvelope = ciphertextEnvelope;
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    if (executor && "transaction" in executor) {
      const txResult = await executor.transaction(async (txExec) => {
        const txRepo = createConfigRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        const result = await txRepo.createSecretMetadata(input);

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
            orgId: scope.orgId,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
            subjectKind: "secret",
            subjectId: secretId,
            requestId,
            payload: {
              operation: "create",
              scope: scope.kind,
              key: secretKey as string,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata created: ${secretKey as string}`,
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
          return errorResponse("conflict", "Secret already exists for this scope and key", 409, requestId);
        }
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      return successResponse({ secret: toPublicSecretMetadata(txResult.result.value) }, requestId, 201);
    }

    // Non-transactional path (deps injection for tests)
    if (deps) {
      const result = await deps.repo.createSecretMetadata(input);

      if (!result.ok) {
        const err = result.error;
        if (err.kind === "conflict") {
          return errorResponse("conflict", "Secret already exists for this scope and key", 409, requestId);
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
            orgId: scope.orgId,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
            subjectKind: "secret",
            subjectId: secretId,
            requestId,
            payload: {
              operation: "create",
              scope: scope.kind,
              key: secretKey as string,
            },
          },
          audit: {
            id: genId(),
            category: "config",
            description: `Secret metadata created: ${secretKey as string}`,
            projectId: "projectId" in scope ? scope.projectId : null,
            environmentId: "environmentId" in scope ? scope.environmentId : null,
          },
        });

        if (!eventResult.ok) {
          throw new Error("Failed to append event");
        }
      }

      return successResponse({ secret: toPublicSecretMetadata(result.value) }, requestId, 201);
    }

    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
