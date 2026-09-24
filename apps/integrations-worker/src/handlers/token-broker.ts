// The token broker (design §7): a tenant product exchanges its control-plane
// credential for a short-lived, repo-scoped GitHub installation token.
//
// Invariants (R4):
//   - requested repositories must each match an ACTIVE repo link in the org,
//     and all resolve to one connection
//   - requested permissions must be ⊆ the App's granted permissions
//     (deny-by-default; write requires granted write)
//   - the token is minted fresh, scoped down by GitHub itself, returned
//     exactly once — never cached, never logged, never in the audit payload
//   - issuance is audited: actor, repos, permissions

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import {
  INTEGRATION_ENTITLEMENTS,
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_POLICY_ACTIONS,
  type IssueIntegrationTokenResponse,
} from "@saas/contracts/integrations";
import { createIntegrationsRepository } from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { asUuid, type Uuid } from "@saas/db/ids";
import type { SqlExecutor } from "@saas/db/d1";
import type { FetchLike } from "../github-app.js";
import { createScopedInstallationToken, mintAppJwt } from "../github-app.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement } from "../billing-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { generateUuid, orgPublicId } from "../ids.js";

export interface TokenBrokerDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

const MAX_REPOSITORIES = 20;
const MAX_PERMISSIONS = 10;
const PERMISSION_KEY_RE = /^[a-z_]{1,40}$/;

/** Requested ⊆ granted, deny-by-default ("write" needs granted "write"). */
export function permissionsWithinGrant(
  requested: Record<string, "read" | "write">,
  granted: Record<string, unknown> | null,
): boolean {
  if (!granted) return false;
  for (const [key, level] of Object.entries(requested)) {
    const grantedLevel = granted[key];
    if (grantedLevel !== "read" && grantedLevel !== "write" && grantedLevel !== "admin") {
      return false;
    }
    if (level === "write" && grantedLevel === "read") return false;
  }
  return true;
}

export async function handleIssueGithubToken(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: TokenBrokerDeps,
): Promise<Response> {
  // D3 default posture: owner/admin users and service principals holding an
  // org role that grants the action — evaluated by policy, deny-by-default.
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);
  const resource: PolicyResource = { kind: "organization", orgId };
  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    INTEGRATION_POLICY_ACTIONS.TOKEN_ISSUE,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);

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
    return errorResponse(
      "precondition_failed",
      "GitHub integration is not included in your current plan",
      412,
      requestId,
      { reason: entitlement.decision.reason ?? "not_configured" },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const repositories = Array.isArray(body.repositories)
    ? body.repositories.filter((r): r is string => typeof r === "string" && r.length > 0)
    : [];
  if (
    repositories.length === 0 ||
    repositories.length > MAX_REPOSITORIES ||
    !Array.isArray(body.repositories) ||
    repositories.length !== body.repositories.length
  ) {
    return validationError(requestId, {
      repositories: [`1–${MAX_REPOSITORIES} provider repository ids`],
    });
  }

  const rawPermissions =
    body.permissions && typeof body.permissions === "object" && !Array.isArray(body.permissions)
      ? (body.permissions as Record<string, unknown>)
      : null;
  const permissionEntries = rawPermissions ? Object.entries(rawPermissions) : [];
  if (!rawPermissions || permissionEntries.length === 0 || permissionEntries.length > MAX_PERMISSIONS) {
    return validationError(requestId, { permissions: [`1–${MAX_PERMISSIONS} permission entries`] });
  }
  const permissions: Record<string, "read" | "write"> = {};
  for (const [key, level] of permissionEntries) {
    if (!PERMISSION_KEY_RE.test(key) || (level !== "read" && level !== "write")) {
      return validationError(requestId, { permissions: [`Invalid entry "${key}"`] });
    }
    permissions[key] = level;
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return errorResponse(
      "precondition_failed",
      "The GitHub App for this environment is not configured yet",
      412,
      requestId,
      { reason: "not_configured", gate: "github_app_registration" },
    );
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);

    // Every requested repo must be linked (active) in THIS org; all links
    // must resolve to one connection.
    const repositoryIds: number[] = [];
    let connectionId: string | null = null;
    for (const externalId of repositories) {
      const links = await repo.listActiveRepoLinksForRepo(orgId, externalId);
      if (!links.ok || links.value.length === 0) {
        return errorResponse(
          "precondition_failed",
          `Repository ${externalId} is not linked to any project in this organization`,
          412,
          requestId,
          { reason: "repository_not_linked", repository: externalId },
        );
      }
      const linkConnection = links.value[0]!.connectionId;
      if (connectionId === null) connectionId = linkConnection;
      if (connectionId !== linkConnection) {
        return validationError(requestId, {
          repositories: ["All repositories must belong to the same connection"],
        });
      }
      const numeric = Number(externalId);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        return validationError(requestId, { repositories: [`Invalid repository id ${externalId}`] });
      }
      repositoryIds.push(numeric);
    }

    const connection = await repo.getConnection(orgId, asUuid(connectionId!));
    if (!connection.ok || connection.value.status !== "active") {
      return errorResponse(
        "precondition_failed",
        "The owning connection is not active",
        412,
        requestId,
        { reason: "disabled" },
      );
    }

    const installation = await repo.getGithubInstallationByConnectionId(asUuid(connectionId!));
    if (!installation.ok) return errorResponse("not_found", "Not found", 404, requestId);

    // Deny-by-default against the App grant snapshot.
    if (!permissionsWithinGrant(permissions, installation.value.permissions)) {
      return errorResponse(
        "precondition_failed",
        "Requested permissions exceed the App's granted permissions",
        412,
        requestId,
        { reason: "permissions_exceed_grant" },
      );
    }

    const jwt = await mintAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, Date.now());
    if (!jwt) {
      return errorResponse("internal_error", "Token minting unavailable", 503, requestId);
    }
    const minted = await createScopedInstallationToken(
      jwt,
      installation.value.installationId,
      { repositoryIds, permissions },
      deps?.fetchImpl,
    );
    if (!minted) {
      return errorResponse("internal_error", "GitHub did not issue a token", 503, requestId);
    }

    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: INTEGRATION_EVENT_TYPES.TOKEN_ISSUED,
          version: 1,
          source: "integrations-worker",
          occurredAt: new Date(),
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          subjectKind: "integration_connection",
          subjectId: connection.value.id,
          requestId,
          // Actor, repos, permissions — NEVER the token.
          payload: {
            provider: "github",
            orgId: orgPublicId(orgId),
            repositories,
            permissions,
            expiresAt: minted.expiresAt,
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `GitHub token issued for ${repositories.length} repo(s): ${Object.entries(permissions)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ")}`,
        },
      });
    } catch {
      // Audit emission is best-effort; the issuance itself already succeeded.
    }

    const payload: IssueIntegrationTokenResponse = {
      token: minted.token,
      expiresAt: minted.expiresAt,
      repositories,
      permissions,
    };
    return successResponse(payload, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
