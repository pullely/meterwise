// Repo browsing for the link picker (IG3): lists the repositories the
// connection's installation can see, via the platform's cached installation
// token. Read-only; the token never leaves the worker.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import {
  INTEGRATION_POLICY_ACTIONS,
  type ListRepositoriesResponse,
} from "@saas/contracts/integrations";
import { createIntegrationsRepository } from "@saas/db/integrations";
import { createSqlExecutor } from "@saas/db/d1";
import type { Uuid } from "@saas/db/ids";

import type { SqlExecutor } from "@saas/db/d1";
import type { FetchLike } from "../github-app.js";
import { listInstallationRepositories } from "../github-app.js";
import { getPlatformInstallationToken } from "../installation-token.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, successResponse } from "../http.js";

export interface RepositoriesDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

const MAX_RESULTS = 100;

export async function handleListRepositories(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  connectionId: Uuid,
  deps?: RepositoriesDeps,
): Promise<Response> {
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
    INTEGRATION_POLICY_ACTIONS.READ,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);

  const query = (new URL(request.url).searchParams.get("query") ?? "").toLowerCase();

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const connection = await repo.getConnection(orgId, connectionId);
    if (!connection.ok) return errorResponse("not_found", "Not found", 404, requestId);
    if (connection.value.status !== "active") {
      return errorResponse(
        "precondition_failed",
        "The connection is not active",
        412,
        requestId,
        { reason: "disabled" },
      );
    }

    const installation = await repo.getGithubInstallationByConnectionId(connectionId);
    if (!installation.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const token = await getPlatformInstallationToken(
      env,
      repo,
      connection.value.id,
      installation.value.installationId,
      Date.now(),
      deps?.fetchImpl,
    );
    if (!token) {
      return errorResponse(
        "precondition_failed",
        "The GitHub App for this environment is not fully configured",
        412,
        requestId,
        { reason: "not_configured", gate: "github_app_registration" },
      );
    }

    const listed = await listInstallationRepositories(token, deps?.fetchImpl);
    if (!listed) {
      return errorResponse("internal_error", "GitHub did not return repositories", 503, requestId);
    }

    const filtered = query
      ? listed.repositories.filter((r) => r.fullName.toLowerCase().includes(query))
      : listed.repositories;

    const payload: ListRepositoriesResponse = {
      repositories: filtered.slice(0, MAX_RESULTS).map((r) => ({
        externalId: r.externalId,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        private: r.private,
      })),
      truncated: listed.truncated || filtered.length > MAX_RESULTS,
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
