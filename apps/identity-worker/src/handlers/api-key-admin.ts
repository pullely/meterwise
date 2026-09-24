import type { Env } from "../env.js";
import type { IdentityRepository } from "@saas/db/identity";
import type { EventsRepository } from "@saas/db/events";
import { createIdentityRepository } from "@saas/db/identity";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { servicePrincipalSubjectId } from "@saas/contracts/service-principal";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, parseSubjectUuid, parseProjectPublicId } from "../ids.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActorContext {
  subjectId: string;
  subjectType: string;
}

export interface ApiKeyAdminDeps {
  identityRepo?: IdentityRepository;
  eventsRepo?: EventsRepository;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LABEL_MAX = 128;
const VALID_ROLES = new Set([
  "owner", "admin", "builder", "viewer", "billing_admin",
  "project_admin", "project_builder", "project_viewer",
]);
const PROJECT_ROLES = new Set(["project_admin", "project_builder", "project_viewer"]);

function extractActorFromHeaders(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

function extractOrgIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/organizations\/([^/]+)\/api-keys/);
  return match ? match[1]! : null;
}

function extractApiKeyIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/organizations\/[^/]+\/api-keys\/([^/]+)$/);
  return match ? match[1]! : null;
}

async function generateApiKeySecret(): Promise<{ raw: string; hash: string; prefix: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = `sk_${toHex(bytes)}`;
  const prefix = raw.slice(0, 12);

  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hash = toHex(new Uint8Array(hashBuffer));

  return { raw, hash, prefix };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Internal: call membership worker to create/list/revoke SP bindings
// ---------------------------------------------------------------------------

async function createSpBinding(
  membershipWorker: Fetcher,
  orgId: string,
  spSubjectId: string,
  role: string,
  scopeKind: string,
  scopeRef: string | null,
  requestId: string,
): Promise<{ ok: boolean; bindingId?: string | undefined }> {
  try {
    const body: Record<string, unknown> = {
      orgId,
      subjectId: spSubjectId,
      role,
      scopeKind,
    };
    if (scopeRef) body.scopeRef = scopeRef;

    const resp = await membershipWorker.fetch(
      "http://membership-worker/v1/internal/membership/service-principal-bindings",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) return { ok: false };

    const parsed = await resp.json() as { data?: { id?: string } };
    return { ok: true, bindingId: parsed?.data?.id };
  } catch {
    return { ok: false };
  }
}

async function listSpBindings(
  membershipWorker: Fetcher,
  orgId: string,
  spSubjectId: string,
  requestId: string,
): Promise<{ ok: boolean; bindings?: Array<{ id: string; role: string; scopeKind: string; scopeRef: string | null }> }> {
  try {
    const resp = await membershipWorker.fetch(
      `http://membership-worker/v1/internal/membership/service-principal-bindings?orgId=${encodeURIComponent(orgId)}&subjectId=${encodeURIComponent(spSubjectId)}`,
      {
        method: "GET",
        headers: { "x-request-id": requestId },
      },
    );
    if (!resp.ok) return { ok: false };

    const parsed = await resp.json() as { data?: Array<{ id: string; role: string; scopeKind: string; scopeRef: string | null }> };
    if (!Array.isArray(parsed?.data)) return { ok: false };
    return { ok: true, bindings: parsed.data };
  } catch {
    return { ok: false };
  }
}

async function revokeSpBinding(
  membershipWorker: Fetcher,
  orgId: string,
  bindingId: string,
  requestId: string,
): Promise<boolean> {
  try {
    const resp = await membershipWorker.fetch(
      `http://membership-worker/v1/internal/membership/service-principal-bindings/${encodeURIComponent(bindingId)}?orgId=${encodeURIComponent(orgId)}`,
      {
        method: "DELETE",
        headers: { "x-request-id": requestId },
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /v1/organizations/{orgId}/api-keys
// ---------------------------------------------------------------------------

export async function handleCreateApiKey(
  request: Request,
  env: Env,
  requestId: string,
  deps?: ApiKeyAdminDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.MEMBERSHIP_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.POLICY_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  const actor = extractActorFromHeaders(request);
  if (!actor) return errorResponse("unauthorized", "Unauthorized", 401, requestId);

  const url = new URL(request.url);
  const orgId = extractOrgIdFromPath(url.pathname);
  if (!orgId) return errorResponse("validation_failed", "Invalid org ID", 422, requestId);
  // Membership/identity persistence keys org_id as UUID; the public id is
  // `org_<hex>`. Decode it before any DB/service call (the events tables use the
  // public TEXT form, so `orgId` is still used for event payloads below).
  const orgUuid = parseOrgPublicId(orgId);
  if (!orgUuid) return errorResponse("validation_failed", "Invalid org ID", 422, requestId);
  // created_by (service_principals/api_keys) and security_events.user_id are UUID
  // columns; the actor id arrives as the public `usr_<hex>` form and must be
  // decoded. (event_log.actor_id is TEXT, so `actor.subjectId` is kept for events.)
  const actorUuid = parseSubjectUuid(actor.subjectId);
  if (!actorUuid) return errorResponse("validation_failed", "Invalid actor id", 422, requestId);

  // Parse body
  let body: unknown;
  try { body = await request.json(); } catch { return validationError(requestId, { body: ["Invalid JSON"] }); }
  if (!body || typeof body !== "object") return validationError(requestId, { body: ["Request body must be an object"] });

  const b = body as Record<string, unknown>;
  const errors: Record<string, string[]> = {};

  if (typeof b.label !== "string" || b.label.length === 0 || b.label.length > LABEL_MAX) {
    errors.label = [`Required, max ${LABEL_MAX} characters`];
  }
  if (typeof b.role !== "string" || !VALID_ROLES.has(b.role)) {
    errors.role = ["Must be a valid role"];
  }
  if (b.projectId !== undefined && b.projectId !== null && typeof b.projectId !== "string") {
    errors.projectId = ["Must be a string"];
  }
  if (typeof b.role === "string" && PROJECT_ROLES.has(b.role) && (typeof b.projectId !== "string" || b.projectId.length === 0)) {
    errors.projectId = ["Required for project-scoped roles"];
  }
  if (b.expiresAt !== undefined && b.expiresAt !== null) {
    if (typeof b.expiresAt !== "string" || isNaN(Date.parse(b.expiresAt))) {
      errors.expiresAt = ["Must be a valid ISO 8601 date"];
    } else if (new Date(b.expiresAt as string) <= new Date()) {
      errors.expiresAt = ["Must be in the future"];
    }
  }

  if (Object.keys(errors).length > 0) return validationError(requestId, errors);

  const label = b.label as string;
  const role = b.role as string;
  const projectId = typeof b.projectId === "string" && b.projectId.length > 0 ? b.projectId : null;
  const expiresAt = typeof b.expiresAt === "string" ? new Date(b.expiresAt) : null;

  // service_principals.project_id is a UUID column; decode the public `prj_<hex>`
  // form for project-scoped keys (was previously passed raw → uuid-cast crash).
  const projectUuid = projectId ? parseProjectPublicId(projectId) : null;
  if (projectId && !projectUuid) return errorResponse("validation_failed", "Invalid project id", 422, requestId);

  // Authorization
  const contextResult = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgUuid, requestId);
  if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);

  const policyResource = projectUuid
    ? { kind: "api_key", orgId: orgUuid, projectId: projectUuid }
    : { kind: "api_key", orgId: orgUuid };

  const policyResult = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, "organization.api_key.create", policyResource, contextResult.memberships, requestId);
  if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);

  // Generate key material
  const { raw, hash, prefix } = await generateApiKeySecret();

  const spId = crypto.randomUUID();
  const spSubjectId = servicePrincipalSubjectId(spId);
  const apiKeyId = crypto.randomUUID();
  const now = new Date();

  // Determine scope for membership binding
  const scopeKind = projectUuid ? "project" : "organization";

  // Create membership binding first (SP role assignment)
  const bindResult = await createSpBinding(env.MEMBERSHIP_WORKER, orgUuid, spSubjectId, role, scopeKind, projectUuid, requestId);
  if (!bindResult.ok) return errorResponse("internal_error", "Failed to create service principal binding", 500, requestId);

  // Persist identity-side state in a transaction
  const executor = deps?.identityRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const doCreate = async (identityRepo: IdentityRepository, eventsRepo: EventsRepository) => {
      // Create service principal
      const spResult = await identityRepo.createServicePrincipal({
        id: spId,
        orgId: orgUuid,
        projectId: projectUuid,
        displayName: `API Key: ${label}`,
        createdBy: actorUuid,
        createdAt: now,
      });
      if (!spResult.ok) throw new Error("sp_create_failed");

      // Create API key
      const keyResult = await identityRepo.createApiKey({
        id: apiKeyId,
        servicePrincipalId: spId,
        orgId: orgUuid,
        keyPrefix: prefix,
        keyHash: hash,
        label,
        expiresAt: expiresAt,
        createdBy: actorUuid,
        createdAt: now,
      });
      if (!keyResult.ok) throw new Error("api_key_create_failed");

      // Record identity security event
      const secEventResult = await identityRepo.recordSecurityEvent({
      id: crypto.randomUUID(),
      eventType: "api_key.created",
      outcome: "success",
      userId: actor.subjectType === "user" ? actorUuid : null,
        sessionId: null,
        challengeId: null,
        requestId,
        correlationId: null,
        ip: null,
        userAgent: null,
        occurredAt: now,
        metadata: {
          apiKeyId,
          orgId,
          label,
          prefix,
          role,
          projectId: projectId ?? undefined,
        },
        redactPaths: [],
      });
      if (!secEventResult.ok) throw new Error("security_event_failed");

      // Write org-scoped audit/event copy
      const eventResult = await eventsRepo.appendEventWithAudit({
        event: {
          id: crypto.randomUUID(),
          type: "api_key.created",
          version: 1,
          source: "identity-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          // event_log/audit_entries.{org_id,project_id} store the bare UUID (the
          // read path re-encodes to public); keep the public form only in `payload`.
          orgId: orgUuid,
          projectId: projectUuid,
          subjectKind: "api_key",
          subjectId: apiKeyId,
          subjectName: label,
          requestId,
          payload: {
            apiKeyId,
            orgId,
            label,
            prefix,
            role,
            projectId,
          },
        },
        audit: {
          id: crypto.randomUUID(),
          category: "api_keys",
          description: `Created API key "${label}"`,
          projectId,
        },
      });
      if (!eventResult.ok) throw new Error("event_append_failed");

      return keyResult.value;
    };

    let apiKey: import("@saas/db/identity").ApiKey;

    if (deps?.identityRepo && deps?.eventsRepo) {
      apiKey = await doCreate(deps.identityRepo, deps.eventsRepo);
    } else {
      apiKey = await executor!.transaction(async (txExecutor) => {
        const identityRepo = createIdentityRepository(txExecutor);
        const eventsRepo = createEventsRepository(txExecutor);
        return doCreate(identityRepo, eventsRepo);
      });
    }

    return successResponse({
      apiKey: {
        id: apiKey.id,
        label: apiKey.label,
        prefix: apiKey.keyPrefix,
        secret: raw,
        createdAt: apiKey.createdAt.toISOString(),
        expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
        servicePrincipal: {
          id: spId,
          displayName: `API Key: ${label}`,
          role,
          projectId: projectId ?? null,
        },
      },
    }, requestId, 201);
  } catch {
    // Compensate: best-effort revoke the binding if identity persistence failed
    if (bindResult.bindingId) {
      await revokeSpBinding(env.MEMBERSHIP_WORKER, orgUuid, bindResult.bindingId, requestId);
    }
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ---------------------------------------------------------------------------
// GET /v1/organizations/{orgId}/api-keys
// ---------------------------------------------------------------------------

export async function handleListApiKeys(
  request: Request,
  env: Env,
  requestId: string,
  deps?: ApiKeyAdminDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.MEMBERSHIP_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.POLICY_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  const actor = extractActorFromHeaders(request);
  if (!actor) return errorResponse("unauthorized", "Unauthorized", 401, requestId);

  const url = new URL(request.url);
  const orgId = extractOrgIdFromPath(url.pathname);
  if (!orgId) return errorResponse("validation_failed", "Invalid org ID", 422, requestId);
  // Decode public `org_<hex>` id to the bare UUID used by identity/membership stores.
  const orgUuid = parseOrgPublicId(orgId);
  if (!orgUuid) return errorResponse("validation_failed", "Invalid org ID", 422, requestId);

  const projectIdFilter = url.searchParams.get("projectId") || undefined;

  // Authorization
  const contextResult = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgUuid, requestId);
  if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);

  const policyResource = projectIdFilter
    ? { kind: "api_key", orgId: orgUuid, projectId: projectIdFilter }
    : { kind: "api_key", orgId: orgUuid };

  const policyResult = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, "organization.api_key.list", policyResource, contextResult.memberships, requestId);
  if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);

  // Pagination
  const limitParam = url.searchParams.get("limit");
  const cursorParam = url.searchParams.get("cursor");
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 100) : 20;

  const executor = deps?.identityRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const identityRepo = deps?.identityRepo ?? createIdentityRepository(executor!);

    const cursor = cursorParam ? JSON.parse(decodeURIComponent(cursorParam)) as import("@saas/db/identity").ApiKeyCursorPosition : null;
    const result = await identityRepo.listApiKeysByOrg({ orgId: orgUuid, limit, cursor });
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    // Enrich with SP binding info
    let items = result.value.items;

    // Apply projectId filter if needed
    if (projectIdFilter) {
      // We need SP data to filter by project. Fetch SPs for each key's SP ID.
      const spIds = [...new Set(items.map(k => k.servicePrincipalId))];
      const spMap = new Map<string, { displayName: string; projectId: string | null }>();
      for (const sid of spIds) {
        const spResult = await identityRepo.getServicePrincipalById(sid);
        if (spResult.ok) {
          spMap.set(sid, { displayName: spResult.value.displayName, projectId: spResult.value.projectId ?? null });
        }
      }
      items = items.filter(k => {
        const sp = spMap.get(k.servicePrincipalId);
        return sp && sp.projectId === projectIdFilter;
      });
    }

    // Enrich items with SP + binding details
    const enriched = await Promise.all(items.map(async (apiKey) => {
      const spSubjId = servicePrincipalSubjectId(apiKey.servicePrincipalId);
      let spInfo: { displayName: string; role: string; projectId: string | null } = {
        displayName: "",
        role: "unknown",
        projectId: null,
      };

      // Get SP info
      const spResult = await identityRepo.getServicePrincipalById(apiKey.servicePrincipalId);
      if (spResult.ok) {
        spInfo.displayName = spResult.value.displayName;
        spInfo.projectId = spResult.value.projectId ?? null;
      }

      // Get binding info for role
      if (env.MEMBERSHIP_WORKER) {
        const bindResult = await listSpBindings(env.MEMBERSHIP_WORKER, orgUuid, spSubjId, requestId);
        if (bindResult.ok && bindResult.bindings && bindResult.bindings.length > 0) {
          spInfo.role = bindResult.bindings[0]!.role;
          if (bindResult.bindings[0]!.scopeRef) {
            spInfo.projectId = bindResult.bindings[0]!.scopeRef;
          }
        }
      }

      return {
        id: apiKey.id,
        label: apiKey.label,
        prefix: apiKey.keyPrefix,
        createdAt: apiKey.createdAt.toISOString(),
        expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
        lastUsedAt: apiKey.lastUsedAt ? apiKey.lastUsedAt.toISOString() : null,
        revokedAt: apiKey.revokedAt ? apiKey.revokedAt.toISOString() : null,
        servicePrincipal: {
          id: apiKey.servicePrincipalId,
          displayName: spInfo.displayName,
          role: spInfo.role,
          projectId: spInfo.projectId,
        },
      };
    }));

    const nextCursor = result.value.nextCursor
      ? encodeURIComponent(JSON.stringify(result.value.nextCursor))
      : null;

    return Response.json(
      {
        data: { apiKeys: enriched },
        meta: { requestId, cursor: nextCursor },
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ---------------------------------------------------------------------------
// DELETE /v1/organizations/{orgId}/api-keys/{apiKeyId}
// ---------------------------------------------------------------------------

export async function handleRevokeApiKey(
  request: Request,
  env: Env,
  requestId: string,
  deps?: ApiKeyAdminDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.MEMBERSHIP_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!env.POLICY_WORKER) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  const actor = extractActorFromHeaders(request);
  if (!actor) return errorResponse("unauthorized", "Unauthorized", 401, requestId);

  const url = new URL(request.url);
  const orgId = extractOrgIdFromPath(url.pathname);
  const apiKeyId = extractApiKeyIdFromPath(url.pathname);
  if (!orgId || !apiKeyId) return errorResponse("validation_failed", "Invalid path", 422, requestId);
  // Decode public `org_<hex>` id to the bare UUID used by identity/membership stores.
  const orgUuid = parseOrgPublicId(orgId);
  if (!orgUuid) return errorResponse("validation_failed", "Invalid org ID", 422, requestId);
  // revoked_by and security_events.user_id are UUID columns; decode the public
  // actor id (event_log.actor_id is TEXT and keeps the public form).
  const actorUuid = parseSubjectUuid(actor.subjectId);
  if (!actorUuid) return errorResponse("validation_failed", "Invalid actor id", 422, requestId);

  // Authorization: need to know the key's scope to authorize correctly
  const executor = deps?.identityRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const identityRepo = deps?.identityRepo ?? createIdentityRepository(executor!);

    // Look up the API key to find its SP and org scope
    // We need to look up by ID, but the repo only has getApiKeyByKeyHash.
    // Use listApiKeysByOrg and filter - we need the key to verify orgId match.
    // Actually, let's just use the SP to find it.
    // For safety: list org keys and find by ID.
    const listResult = await identityRepo.listApiKeysByOrg({ orgId: orgUuid, limit: 1000, cursor: null });
    if (!listResult.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const apiKey = listResult.value.items.find(k => k.id === apiKeyId);
    if (!apiKey) return errorResponse("not_found", "API key not found", 404, requestId);

    if (apiKey.revokedAt) return errorResponse("conflict", "API key already revoked", 409, requestId);

    // Get SP to determine scope for policy check
    const spResult = await identityRepo.getServicePrincipalById(apiKey.servicePrincipalId);
    const projectId = spResult.ok ? (spResult.value.projectId ?? null) : null;

    // Fetch authorization context
    const contextResult = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgUuid, requestId);
    if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const policyResource = projectId
      ? { kind: "api_key", orgId: orgUuid, projectId }
      : { kind: "api_key", orgId: orgUuid };

    const policyResult = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, "organization.api_key.revoke", policyResource, contextResult.memberships, requestId);
    if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);

    // Revoke in transaction — revoke + security event + audit must be atomic
    const now = new Date();

    const doRevoke = async (idRepo: IdentityRepository, evRepo: EventsRepository) => {
      const revokeResult = await idRepo.revokeApiKey(apiKeyId, actorUuid, now);
      if (!revokeResult.ok) throw new Error("revoke_failed");

      // Record identity security event
      const secResult = await idRepo.recordSecurityEvent({
        id: crypto.randomUUID(),
        eventType: "api_key.revoked",
        outcome: "success",
        userId: actor.subjectType === "user" ? actorUuid : null,
        sessionId: null,
        challengeId: null,
        requestId,
        correlationId: null,
        ip: null,
        userAgent: null,
        occurredAt: now,
        metadata: {
          apiKeyId,
          orgId,
          label: apiKey.label,
          prefix: apiKey.keyPrefix,
        },
        redactPaths: [],
      });
      if (!secResult.ok) throw new Error("security_event_failed");

      // Write org-scoped audit/event copy
      const eventResult = await evRepo.appendEventWithAudit({
        event: {
          id: crypto.randomUUID(),
          type: "api_key.revoked",
          version: 1,
          source: "identity-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          // event_log/audit_entries.org_id stores the bare UUID (read path
          // re-encodes to public); keep the public form only in `payload`.
          orgId: orgUuid,
          projectId,
          subjectKind: "api_key",
          subjectId: apiKeyId,
          subjectName: apiKey.label,
          requestId,
          payload: {
            apiKeyId,
            orgId,
            label: apiKey.label,
            prefix: apiKey.keyPrefix,
          },
        },
        audit: {
          id: crypto.randomUUID(),
          category: "api_keys",
          description: `Revoked API key "${apiKey.label}"`,
          projectId,
        },
      });
      if (!eventResult.ok) throw new Error("event_append_failed");

      return revokeResult.value;
    };

    let revokedKey: import("@saas/db/identity").ApiKey;

    if (deps?.identityRepo && deps?.eventsRepo) {
      revokedKey = await doRevoke(deps.identityRepo, deps.eventsRepo);
    } else {
      revokedKey = await executor!.transaction(async (txExecutor) => {
        const txIdentityRepo = createIdentityRepository(txExecutor);
        const txEventsRepo = createEventsRepository(txExecutor);
        return doRevoke(txIdentityRepo, txEventsRepo);
      });
    }

    return successResponse({
      apiKey: {
        id: revokedKey.id,
        label: revokedKey.label,
        prefix: revokedKey.keyPrefix,
        revokedAt: revokedKey.revokedAt ? revokedKey.revokedAt.toISOString() : now.toISOString(),
      },
    }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
