import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createWebhookRepository } from "@saas/db/webhooks";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse, listResponse, validationError, withTimings } from "../http.js";
import { createTimings } from "@saas/contracts/timing";
import { toPublicWebhookEndpoint } from "../mappers.js";
import { parsePageParams, encodeCursor } from "../pagination.js";
import { parseProjectPublicId } from "../ids.js";
import type { Uuid } from "@saas/db/ids";
import type { PolicyResource } from "@saas/contracts/policy";
import type { UpdateWebhookEndpointInput, DisableWebhookEndpointInput, WebhookRepository } from "@saas/db/webhooks";
import type { EventsRepository } from "@saas/db/events";

const URL_RE = /^https:\/\/.{1,2048}$/;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

// ── Authorization helper ─────────────────────────────────────

async function authorizeWebhook(
  env: Env,
  actor: ActorContext,
  orgId: string,
  projectId: string | null | undefined,
  action: "organization.webhook.read" | "organization.webhook.write" | "project.webhook.read" | "project.webhook.write",
  requestId: string,
): Promise<Response | null> {
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const resource: PolicyResource = projectId
    ? { kind: "project", orgId, projectId }
    : { kind: "organization", orgId };

  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    action,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  return null; // authorized
}

// ── Encrypt signing secret ───────────────────────────────────

async function encryptSigningSecret(
  env: Env,
): Promise<{ secret: string; ciphertext: string } | undefined> {
  if (!env.SECRET_ENCRYPTION_KEY) return undefined;

  const secret = randomHex(32);
  const { createEncryptionAdapter } = await import("../encryption.js");
  const adapter = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!adapter) return undefined;

  const envelope = await adapter.encrypt(secret);
  return { secret, ciphertext: JSON.stringify(envelope) };
}

// ── Create ───────────────────────────────────────────────────

export async function handleCreateWebhookEndpoint(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
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

  const { url, name, description, projectId } = body as {
    url?: unknown; name?: unknown; description?: unknown; projectId?: unknown;
  };
  const fields: Record<string, string[]> = {};

  if (typeof url !== "string" || !URL_RE.test(url)) {
    fields.url = ["A valid HTTPS URL is required"];
  }
  if (name !== undefined && name !== null && typeof name !== "string") {
    fields.name = ["Name must be a string or null"];
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    fields.description = ["Description must be a string or null"];
  }
  if (projectId !== undefined && projectId !== null && typeof projectId !== "string") {
    fields.projectId = ["Project ID must be a string or null"];
  }
  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  // Resolve project public ID if provided. webhook_endpoints.project_id is a
  // UUID column, so decode the public `prj_<hex>` form and reject anything that
  // isn't a valid project id (previously this used the wrong parser and fell
  // back to storing the raw public string, which the UUID column rejects).
  let resolvedProjectId: Uuid | null = null;
  if (typeof projectId === "string") {
    const parsed = parseProjectPublicId(projectId);
    if (!parsed) return validationError(requestId, { projectId: ["Invalid project id"] });
    resolvedProjectId = parsed;
  }

  // Authorization
  const policyAction = resolvedProjectId
    ? "project.webhook.write" as const
    : "organization.webhook.write" as const;
  const denied = await authorizeWebhook(env, actor, orgId, resolvedProjectId, policyAction, requestId);
  if (denied) return denied;

  const endpointId = crypto.randomUUID();

  const encrypted = await encryptSigningSecret(env);
  const secretCiphertext = encrypted?.ciphertext;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);

    const createInput: import("@saas/db/webhooks").CreateWebhookEndpointInput = {
      id: endpointId,
      orgId,
      projectId: resolvedProjectId,
      url: url as string,
      name: (name as string) ?? null,
      description: (description as string) ?? null,
    };
    if (secretCiphertext !== undefined) {
      createInput.secretCiphertext = secretCiphertext;
    }

    const result = await repo.createEndpoint(createInput);

    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "Webhook endpoint already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await eventsRepo.appendEventWithAudit({
      event: {
        id: randomHex(16),
        type: "webhook_endpoint.created",
        version: 1,
        source: "webhooks-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: resolvedProjectId,
        subjectKind: "webhook_endpoint",
        subjectId: endpointId,
        requestId,
        payload: { url: url as string, name: name ?? null },
      },
      audit: {
        id: randomHex(16),
        category: "webhooks",
        description: `Webhook endpoint created: ${url as string}`,
        projectId: resolvedProjectId,
      },
    });

    return successResponse({ endpoint: toPublicWebhookEndpoint(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── Get ──────────────────────────────────────────────────────

export async function handleGetWebhookEndpoint(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  endpointId: string,
): Promise<Response> {
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const result = await repo.getEndpoint(orgId, endpointId);
    if (!result.ok) {
      return errorResponse("not_found", "Webhook endpoint not found", 404, requestId);
    }

    const policyAction = result.value.projectId
      ? "project.webhook.read" as const
      : "organization.webhook.read" as const;
    const denied = await authorizeWebhook(env, actor, orgId, result.value.projectId, policyAction, requestId);
    if (denied) return denied;

    return successResponse({ endpoint: toPublicWebhookEndpoint(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── List ─────────────────────────────────────────────────────

export async function handleListWebhookEndpoints(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  projectId: string | null,
): Promise<Response> {
  const policyAction = projectId
    ? "project.webhook.read" as const
    : "organization.webhook.read" as const;

  const pageResult = parsePageParams(new URL(request.url));
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }

  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  // PERF14b: phase timings — `authz` and `db` run concurrently (PERF12c), so
  // their overlap is directly visible in the Server-Timing breakdown.
  const timings = createTimings();
  const endTotal = timings.start("total");
  const route = "webhooks.endpoints.list";
  try {
    const repo = createWebhookRepository(executor);
    // PERF12: authorization (membership + policy) and the read are independent
    // (the policy resource is the route's org/project, not row-derived) — run
    // them concurrently and discard the speculatively read rows on deny.
    const [denied, result] = await Promise.all([
      timings.measure("authz", () => authorizeWebhook(env, actor, orgId, projectId, policyAction, requestId)),
      timings.measure("db", () => repo.listEndpoints(orgId, { limit, cursor: dbCursor }, projectId)),
    ]);
    endTotal();
    if (denied) return withTimings(denied, requestId, route, timings);
    if (!result.ok) {
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, route, timings);
    }

    const endpoints = result.value.items.map(toPublicWebhookEndpoint);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return withTimings(listResponse({ endpoints }, requestId, nextCursor), requestId, route, timings);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── Update ───────────────────────────────────────────────────

export async function handleUpdateWebhookEndpoint(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  endpointId: string,
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

  const { url, name, description } = body as { url?: unknown; name?: unknown; description?: unknown };
  const fields: Record<string, string[]> = {};

  if (url !== undefined && (typeof url !== "string" || !URL_RE.test(url))) {
    fields.url = ["A valid HTTPS URL is required"];
  }
  if (name !== undefined && name !== null && typeof name !== "string") {
    fields.name = ["Name must be a string or null"];
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    fields.description = ["Description must be a string or null"];
  }
  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);

    const existing = await repo.getEndpoint(orgId, endpointId);
    if (!existing.ok) {
      return errorResponse("not_found", "Webhook endpoint not found", 404, requestId);
    }

    const policyAction = existing.value.projectId
      ? "project.webhook.write" as const
      : "organization.webhook.write" as const;
    const denied = await authorizeWebhook(env, actor, orgId, existing.value.projectId, policyAction, requestId);
    if (denied) return denied;

    const input: UpdateWebhookEndpointInput = {};
    if (typeof url === "string") input.url = url;
    if (name !== undefined) input.name = (name as string) ?? null;
    if (description !== undefined) input.description = (description as string) ?? null;

    const result = await repo.updateEndpoint(orgId, endpointId, input);
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await eventsRepo.appendEventWithAudit({
      event: {
        id: randomHex(16),
        type: "webhook_endpoint.updated",
        version: 1,
        source: "webhooks-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: existing.value.projectId,
        subjectKind: "webhook_endpoint",
        subjectId: endpointId,
        requestId,
        payload: { url, name, description },
      },
      audit: {
        id: randomHex(16),
        category: "webhooks",
        description: "Webhook endpoint updated",
        projectId: existing.value.projectId,
      },
    });

    return successResponse({ endpoint: toPublicWebhookEndpoint(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── Disable ──────────────────────────────────────────────────

export async function handleDisableWebhookEndpoint(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  endpointId: string,
): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // body is optional for disable
  }

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);

    const existing = await repo.getEndpoint(orgId, endpointId);
    if (!existing.ok) {
      return errorResponse("not_found", "Webhook endpoint not found", 404, requestId);
    }

    const policyAction = existing.value.projectId
      ? "project.webhook.write" as const
      : "organization.webhook.write" as const;
    const denied = await authorizeWebhook(env, actor, orgId, existing.value.projectId, policyAction, requestId);
    if (denied) return denied;

    const input: DisableWebhookEndpointInput = {};
    if (typeof body.reason === "string") input.reason = body.reason;

    const result = await repo.disableEndpoint(orgId, endpointId, input);
    if (!result.ok) {
      if (result.error.kind === "not_found") {
        return errorResponse("not_found", "Webhook endpoint not found or already disabled", 404, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await eventsRepo.appendEventWithAudit({
      event: {
        id: randomHex(16),
        type: "webhook_endpoint.disabled",
        version: 1,
        source: "webhooks-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: existing.value.projectId,
        subjectKind: "webhook_endpoint",
        subjectId: endpointId,
        requestId,
        payload: { reason: input.reason ?? null },
      },
      audit: {
        id: randomHex(16),
        category: "webhooks",
        description: "Webhook endpoint disabled",
        projectId: existing.value.projectId,
      },
    });

    return successResponse({ endpoint: toPublicWebhookEndpoint(result.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── Enable ───────────────────────────────────────────────────

export interface EnableWebhookEndpointDeps {
  /** Repository implementation (full surface — `getEndpoint` + `enableEndpoint` are used). */
  repo: Pick<WebhookRepository, "getEndpoint" | "enableEndpoint">;
  /** Optional events-repo seam for atomicity tests. When omitted, the
   *  non-tx path simply skips event/audit emission (used by tests that
   *  only exercise the policy/repo branches). */
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateId?: () => string;
  now?: () => Date;
}

export async function handleEnableWebhookEndpoint(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  endpointId: string,
  deps?: EnableWebhookEndpointDeps,
): Promise<Response> {
  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createWebhookRepository(executor!);

    const existing = await repo.getEndpoint(orgId, endpointId);
    if (!existing.ok) {
      return errorResponse("not_found", "Webhook endpoint not found", 404, requestId);
    }

    const policyAction = existing.value.projectId
      ? "project.webhook.write" as const
      : "organization.webhook.write" as const;
    const denied = await authorizeWebhook(env, actor, orgId, existing.value.projectId, policyAction, requestId);
    if (denied) return denied;

    const genId = deps?.generateId ?? (() => randomHex(16));
    const now = deps?.now ? deps.now() : new Date();

    // Transactional path: mutation + event/audit emit atomically.
    // Mutation failure → callback returns early, no event append.
    // Event append failure → throw rolls back the mutation.
    if (executor && "transaction" in executor) {
      try {
        const txResult = await executor.transaction(async (txExec) => {
          const txRepo = createWebhookRepository(txExec);
          const txEventsRepo = createEventsRepository(txExec);

          const enableResult = await txRepo.enableEndpoint(orgId, endpointId);
          if (!enableResult.ok) {
            return { enableResult } as const;
          }

          const eventResult = await txEventsRepo.appendEventWithAudit({
            event: {
              id: genId(),
              type: "webhook_endpoint.enabled",
              version: 1,
              source: "webhooks-worker",
              occurredAt: now,
              actorType: actor.subjectType,
              actorId: actor.subjectId,
              orgId,
              projectId: existing.value.projectId,
              subjectKind: "webhook_endpoint",
              subjectId: endpointId,
              requestId,
              payload: {},
            },
            audit: {
              id: genId(),
              category: "webhooks",
              description: "Webhook endpoint re-enabled",
              projectId: existing.value.projectId,
            },
          });

          if (!eventResult.ok) {
            throw new Error("event_append_failed");
          }

          return { enableResult } as const;
        });

        if (!txResult.enableResult.ok) {
          if (txResult.enableResult.error.kind === "not_found") {
            return errorResponse("not_found", "Webhook endpoint not found or already active", 404, requestId);
          }
          return errorResponse("internal_error", "Service unavailable", 503, requestId);
        }
        return successResponse({ endpoint: toPublicWebhookEndpoint(txResult.enableResult.value) }, requestId);
      } catch {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    }

    // Non-transactional path (unit tests with injected deps): mutation
    // first, then optional event/audit emit. Tests that need atomicity
    // semantics should exercise the transactional branch via the live
    // executor; this branch keeps the policy/repo path testable in
    // isolation.
    const enableResult = await repo.enableEndpoint(orgId, endpointId);
    if (!enableResult.ok) {
      if (enableResult.error.kind === "not_found") {
        return errorResponse("not_found", "Webhook endpoint not found or already active", 404, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    if (deps?.eventsRepo) {
      const eventResult = await deps.eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "webhook_endpoint.enabled",
          version: 1,
          source: "webhooks-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          projectId: existing.value.projectId,
          subjectKind: "webhook_endpoint",
          subjectId: endpointId,
          requestId,
          payload: {},
        },
        audit: {
          id: genId(),
          category: "webhooks",
          description: "Webhook endpoint re-enabled",
          projectId: existing.value.projectId,
        },
      });
      if (!eventResult.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    }

    return successResponse({ endpoint: toPublicWebhookEndpoint(enableResult.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── Delete ───────────────────────────────────────────────────

export async function handleDeleteWebhookEndpoint(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  endpointId: string,
): Promise<Response> {
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);

    const existing = await repo.getEndpoint(orgId, endpointId);
    if (!existing.ok) {
      return errorResponse("not_found", "Webhook endpoint not found", 404, requestId);
    }

    const policyAction = existing.value.projectId
      ? "project.webhook.write" as const
      : "organization.webhook.write" as const;
    const denied = await authorizeWebhook(env, actor, orgId, existing.value.projectId, policyAction, requestId);
    if (denied) return denied;

    const result = await repo.deleteEndpoint(orgId, endpointId);
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await eventsRepo.appendEventWithAudit({
      event: {
        id: randomHex(16),
        type: "webhook_endpoint.deleted",
        version: 1,
        source: "webhooks-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: existing.value.projectId,
        subjectKind: "webhook_endpoint",
        subjectId: endpointId,
        requestId,
        payload: {},
      },
      audit: {
        id: randomHex(16),
        category: "webhooks",
        description: "Webhook endpoint deleted",
        projectId: existing.value.projectId,
      },
    });

    return successResponse({ deleted: true }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

// ── Rotate signing secret ────────────────────────────────────

export async function handleRotateWebhookSecret(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  endpointId: string,
): Promise<Response> {
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);

    const existing = await repo.getEndpoint(orgId, endpointId);
    if (!existing.ok) {
      return errorResponse("not_found", "Webhook endpoint not found", 404, requestId);
    }

    const policyAction = existing.value.projectId
      ? "project.webhook.write" as const
      : "organization.webhook.write" as const;
    const denied = await authorizeWebhook(env, actor, orgId, existing.value.projectId, policyAction, requestId);
    if (denied) return denied;

    const encrypted = await encryptSigningSecret(env);
    const secretCiphertext = encrypted?.ciphertext;
    const plaintextSecret = encrypted?.secret;

    // Default grace window: 24h. Operators can override via env (0 disables snapshot).
    const DEFAULT_GRACE_SECONDS = 24 * 60 * 60;
    const rawGrace = env.WEBHOOK_SECRET_ROTATION_GRACE_SECONDS;
    let graceSeconds = DEFAULT_GRACE_SECONDS;
    if (typeof rawGrace === "string" && rawGrace.length > 0) {
      const parsed = Number.parseInt(rawGrace, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        graceSeconds = parsed;
      }
    }

    const result = await repo.rotateEndpointSecret(orgId, endpointId, {
      ...(secretCiphertext !== undefined ? { secretCiphertext } : {}),
      ...(graceSeconds > 0 ? { gracePeriodSeconds: graceSeconds } : {}),
    });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await eventsRepo.appendEventWithAudit({
      event: {
        id: randomHex(16),
        type: "webhook_endpoint.secret_rotated",
        version: 1,
        source: "webhooks-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: existing.value.projectId,
        subjectKind: "webhook_endpoint",
        subjectId: endpointId,
        requestId,
        // SECURITY: never include the plaintext signing secret in event payloads.
        payload: {
          secretVersion: result.value.endpoint.secretVersion,
          previousSecretExpiresAt: result.value.previousSecretExpiresAt,
        },
      },
      audit: {
        id: randomHex(16),
        category: "webhooks",
        description: "Webhook endpoint signing secret rotated",
        projectId: existing.value.projectId,
      },
    });

    // Reveal-once response: plaintext is included exactly here, never persisted
    // and never re-readable. Console (Task 0109) and CLI (Task 0110) consume this.
    return successResponse(
      {
        endpoint: toPublicWebhookEndpoint(result.value.endpoint),
        ...(plaintextSecret !== undefined ? { secret: `whsec_${plaintextSecret}` } : {}),
        previousSecretExpiresAt: result.value.previousSecretExpiresAt,
        gracePeriodSeconds: graceSeconds,
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
