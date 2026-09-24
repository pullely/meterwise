import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import type {
  ConnectIntegrationResponse,
  GetIntegrationResponse,
  ListIntegrationsResponse,
  RevokeIntegrationResponse,
} from "@saas/contracts/integrations";
import {
  INTEGRATION_ENTITLEMENTS,
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_POLICY_ACTIONS,
} from "@saas/contracts/integrations";
import { createIntegrationsRepository } from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import type { Uuid } from "@saas/db/ids";
import type { SqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement } from "../billing-client.js";
import { errorResponse, listResponse, successResponse } from "../http.js";
import { toPublicConnection, toPublicConnectionWithSelection } from "../mappers.js";
import { generateUuid, orgPublicId } from "../ids.js";
import { uuidFromPublicId } from "@saas/db/ids";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { getConfiguredProvider } from "../providers/registry.js";
import {
  CONNECT_STATE_TTL_MS,
  generateStateNonce,
  hashStateNonce,
  signConnectState,
} from "../state.js";

/** Test seam: inject a fake executor; production callers omit it. */
export interface HandlerDeps {
  executor?: SqlExecutor;
}

function resolveExecutor(env: Env, deps?: HandlerDeps): { executor: SqlExecutor; owned: boolean } {
  if (deps?.executor) return { executor: deps.executor, owned: false };
  return { executor: createSqlExecutor(env.PLATFORM_DB!), owned: true };
}

async function disposeIfOwned(executor: SqlExecutor, owned: boolean): Promise<void> {
  if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

// ── Authorization helper ─────────────────────────────────────

async function authorizeIntegration(
  env: Env,
  actor: ActorContext,
  orgId: string,
  action: string,
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

  const resource: PolicyResource = { kind: "organization", orgId };
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

  return null;
}

// ── Connect ─────────────────────────────────────────────────

export async function handleConnectIntegration(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.CONNECT,
    requestId,
  );
  if (denied) return denied;

  // Entitlement gate (fails closed on service error).
  const entitlement = await checkBillingEntitlement(
    env.BILLING_WORKER!,
    orgPublicId(orgId),
    INTEGRATION_ENTITLEMENTS.GITHUB,
    requestId,
  );
  if (entitlement.kind === "service_error") {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!entitlement.decision.allowed) {
    const reason = entitlement.decision.reason ?? "not_configured";
    return errorResponse(
      "precondition_failed",
      "GitHub integration is not included in your current plan",
      412,
      requestId,
      { reason, entitlementKey: INTEGRATION_ENTITLEMENTS.GITHUB },
    );
  }

  // D1 gate: live connect parks until the environment's GitHub App exists.
  const configured = getConfiguredProvider(env, "github");
  if (!configured || !env.INTEGRATIONS_STATE_SECRET) {
    return errorResponse(
      "precondition_failed",
      "The GitHub App for this environment is not configured yet",
      412,
      requestId,
      { reason: "not_configured", gate: "github_app_registration" },
    );
  }

  let displayName: string | null = null;
  if (request.headers.get("content-length") !== "0" && request.body) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      if (typeof body.displayName === "string" && body.displayName.trim()) {
        displayName = body.displayName.trim().slice(0, 200);
      }
    } catch {
      // Empty/absent body is fine — displayName is optional.
    }
  }

  // created_by stores the decoded actor UUID (repo-wide convention enforced
  // by lint); the public form is re-derivable for display.
  const createdByUuid = uuidFromPublicId(actor.subjectId);

  const connectionId = generateUuid();
  const nonce = generateStateNonce();
  const nonceHash = await hashStateNonce(nonce);
  const now = Date.now();
  const expiresAt = new Date(now + CONNECT_STATE_TTL_MS);

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const created = await repo.createConnection({
      id: connectionId,
      orgId,
      provider: "github",
      displayName,
      createdBy: createdByUuid,
      stateNonceHash: nonceHash,
      stateExpiresAt: expiresAt,
    });
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        return errorResponse("conflict", "A connection for this account already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const state = await signConnectState(
      { n: nonce, p: "github", c: connectionId, o: orgId, exp: now + CONNECT_STATE_TTL_MS },
      env.INTEGRATIONS_STATE_SECRET,
    );
    const installUrl = configured.provider.buildInstallUrl({ state });

    const payload: ConnectIntegrationResponse = {
      connection: toPublicConnection(created.value),
      installUrl,
    };
    return successResponse(payload, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}

// ── List / Get ──────────────────────────────────────────────

export async function handleListIntegrations(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.READ,
    requestId,
  );
  if (denied) return denied;

  const page = parsePageParams(new URL(request.url));
  if (!page.ok) {
    return errorResponse("validation_failed", "Validation failed", 422, requestId, {
      fields: { [page.field]: [page.reason] },
    });
  }

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const result = await repo.listConnections(orgId, {
      limit: page.value.limit,
      cursor: page.value.cursor
        ? { createdAt: page.value.cursor.createdAt, id: page.value.cursor.id }
        : null,
    });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const payload: ListIntegrationsResponse = {
      connections: result.value.items.map(toPublicConnection),
      nextCursor: result.value.nextCursor,
    };
    const cursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;
    return listResponse(payload, requestId, cursor);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}

export async function handleGetIntegration(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: HandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.READ,
    requestId,
  );
  if (denied) return denied;

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const result = await repo.getConnection(orgId, connectionId);
    if (!result.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    let repositorySelection: string | null = null;
    const installation = await repo.getGithubInstallationByConnectionId(connectionId);
    if (installation.ok) {
      repositorySelection = installation.value.repositorySelection;
    }

    const payload: GetIntegrationResponse = {
      connection: toPublicConnectionWithSelection(result.value, repositorySelection),
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}

// ── Revoke ──────────────────────────────────────────────────

export async function handleRevokeIntegration(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: HandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.MANAGE,
    requestId,
  );
  if (denied) return denied;

  const { executor, owned } = resolveExecutor(env, deps);
  try {
    const repo = createIntegrationsRepository(executor);
    const existing = await repo.getConnection(orgId, connectionId);
    if (!existing.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    if (existing.value.status === "revoked") {
      const payload: RevokeIntegrationResponse = { revoked: true };
      return successResponse(payload, requestId);
    }

    const updated = await repo.updateConnectionStatus(orgId, connectionId, "revoked");
    if (!updated.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // Cached platform token is dead the moment the connection is.
    await repo.deleteInstallationToken(connectionId);

    // Best-effort GitHub-side uninstall (the inverse arrives via IG2 once the
    // inbound pipeline lands). Failure here never blocks the platform revoke.
    const installation = await repo.getGithubInstallationByConnectionId(connectionId);
    if (installation.ok) {
      const configured = getConfiguredProvider(env, "github");
      if (configured) {
        await configured.provider.revokeInstallation(
          installation.value.installationId,
          Date.now(),
        );
      }
    }

    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: INTEGRATION_EVENT_TYPES.REVOKED,
          version: 1,
          source: "integrations-worker",
          occurredAt: new Date(),
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          subjectKind: "integration_connection",
          subjectId: connectionId,
          requestId,
          payload: {
            provider: "github",
            externalAccountLogin: existing.value.externalAccountLogin,
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `GitHub connection revoked${existing.value.externalAccountLogin ? ` (${existing.value.externalAccountLogin})` : ""}`,
        },
      });
    } catch {
      // Best-effort: audit emission never fails the revoke.
    }

    const payload: RevokeIntegrationResponse = { revoked: true };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await disposeIfOwned(executor, owned);
  }
}
