// Repo ↔ project links with branch → environment maps (IG3, design §3/§8).
// A link is a plain org/project-scoped record — forward-compatible with
// becoming a manifested resource when P2 lands.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PolicyResource } from "@saas/contracts/policy";
import {
  INTEGRATION_ENTITLEMENTS,
  INTEGRATION_POLICY_ACTIONS,
  SCM_EVENT_TYPES,
  type BranchEnvMap,
  type CreateRepoLinkResponse,
  type DeleteRepoLinkResponse,
  type ListRepoLinksResponse,
  type PublicRepoLink,
  type UpdateRepoLinkResponse,
} from "@saas/contracts/integrations";
import {
  createIntegrationsRepository,
  type RepoLink,
} from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { asUuid, uuidFromPublicId, type Uuid } from "@saas/db/ids";
import type { SqlExecutor } from "@saas/db/d1";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement } from "../billing-client.js";
import { fetchProjectEnvironmentSlugs } from "../projects-client.js";
import { errorResponse, listResponse, successResponse, validationError } from "../http.js";
import {
  connectionPublicId,
  generateUuid,
  orgPublicId,
  parseConnectionPublicId,
  projectPublicId,
  repoLinkPublicId,
} from "../ids.js";
import { encodeCursor, parsePageParams } from "../pagination.js";

export interface RepoLinkDeps {
  executor?: SqlExecutor;
}

const MAX_BRANCH_MAP_ENTRIES = 32;
const BRANCH_RE = /^[^\s~^:?*\\[\]]{1,255}$/;

function toPublicRepoLink(link: RepoLink): PublicRepoLink {
  return {
    id: repoLinkPublicId(link.id),
    orgId: orgPublicId(link.orgId),
    projectId: projectPublicId(link.projectId),
    connectionId: connectionPublicId(link.connectionId),
    repoExternalId: link.repoExternalId,
    repoFullName: link.repoFullName,
    defaultBranch: link.defaultBranch,
    branchEnvMap: link.branchEnvMap,
    status: link.status,
    createdBy: link.createdBy,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

async function authorizeRepoLinkWrite(
  env: Env,
  actor: ActorContext,
  orgId: string,
  projectId: string,
  requestId: string,
): Promise<Response | null> {
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);

  const resource: PolicyResource = { kind: "project", orgId, projectId };
  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    INTEGRATION_POLICY_ACTIONS.REPO_LINK_WRITE,
    resource,
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);
  return null;
}

async function authorizeRepoLinkRead(
  env: Env,
  actor: ActorContext,
  orgId: string,
  requestId: string,
): Promise<Response | null> {
  const contextResult = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!contextResult.ok) return errorResponse("not_found", "Not found", 404, requestId);
  const policyResult = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    INTEGRATION_POLICY_ACTIONS.READ,
    { kind: "organization", orgId },
    contextResult.memberships,
    requestId,
  );
  if (!policyResult.allow) return errorResponse("not_found", "Not found", 404, requestId);
  return null;
}

/** Validate the branch map shape + that every environment slug is live. */
async function validateBranchEnvMap(
  env: Env,
  orgId: string,
  projectId: string,
  requestId: string,
  branchEnvMap: unknown,
): Promise<{ ok: true; map: BranchEnvMap } | { ok: false; response: Response }> {
  if (branchEnvMap == null) return { ok: true, map: {} };
  if (typeof branchEnvMap !== "object" || Array.isArray(branchEnvMap)) {
    return {
      ok: false,
      response: validationError(requestId, { branchEnvMap: ["Must be an object"] }),
    };
  }
  const entries = Object.entries(branchEnvMap as Record<string, unknown>);
  if (entries.length > MAX_BRANCH_MAP_ENTRIES) {
    return {
      ok: false,
      response: validationError(requestId, {
        branchEnvMap: [`At most ${MAX_BRANCH_MAP_ENTRIES} branch mappings`],
      }),
    };
  }
  const map: BranchEnvMap = {};
  for (const [branch, slug] of entries) {
    if (!BRANCH_RE.test(branch) || typeof slug !== "string" || slug.length === 0) {
      return {
        ok: false,
        response: validationError(requestId, {
          branchEnvMap: [`Invalid mapping for branch "${branch}"`],
        }),
      };
    }
    map[branch] = slug;
  }
  if (entries.length === 0) return { ok: true, map };

  if (!env.PROJECTS_WORKER) {
    return {
      ok: false,
      response: errorResponse("internal_error", "Project service unavailable", 503, requestId),
    };
  }
  const live = await fetchProjectEnvironmentSlugs(env.PROJECTS_WORKER, orgId, projectId, requestId);
  if (!live.ok) {
    return {
      ok: false,
      response: errorResponse("internal_error", "Project service unavailable", 503, requestId),
    };
  }
  const liveSet = new Set(live.slugs);
  const unknown = Object.values(map).filter((slug) => !liveSet.has(slug));
  if (unknown.length > 0) {
    return {
      ok: false,
      response: validationError(requestId, {
        branchEnvMap: [`Unknown environment(s): ${[...new Set(unknown)].join(", ")}`],
      }),
    };
  }
  return { ok: true, map };
}

// ── Create ──────────────────────────────────────────────────

export async function handleCreateRepoLink(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: RepoLinkDeps,
): Promise<Response> {
  const denied = await authorizeRepoLinkWrite(env, actor, orgId, projectId, requestId);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const connectionUuid =
    typeof body.connectionId === "string" ? parseConnectionPublicId(body.connectionId) : null;
  const repoExternalId = typeof body.repoExternalId === "string" ? body.repoExternalId.trim() : "";
  const repoFullName = typeof body.repoFullName === "string" ? body.repoFullName.trim() : "";
  if (!connectionUuid || !repoExternalId || !repoFullName || !repoFullName.includes("/")) {
    return validationError(requestId, {
      ...(connectionUuid ? {} : { connectionId: ["Required (int_…)"] }),
      ...(repoExternalId ? {} : { repoExternalId: ["Required"] }),
      ...(repoFullName && repoFullName.includes("/") ? {} : { repoFullName: ["Required, owner/name"] }),
    });
  }

  const mapResult = await validateBranchEnvMap(env, orgId, projectId, requestId, body.branchEnvMap);
  if (!mapResult.ok) return mapResult.response;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);

    // Connection must be this org's, and live.
    const connection = await repo.getConnection(orgId, asUuid(connectionUuid));
    if (!connection.ok || connection.value.status !== "active") {
      return errorResponse("not_found", "Connection not found or not active", 404, requestId);
    }

    // Entitlement: limit.repo_links is a quantity gate (412 + upgrade UX).
    const entitlement = await checkBillingEntitlement(
      env.BILLING_WORKER!,
      orgPublicId(orgId),
      INTEGRATION_ENTITLEMENTS.REPO_LINKS_LIMIT,
      requestId,
    );
    if (entitlement.kind === "service_error") {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    if (!entitlement.decision.allowed) {
      return errorResponse(
        "precondition_failed",
        "Repository links are not included in your current plan",
        412,
        requestId,
        { reason: entitlement.decision.reason ?? "not_configured" },
      );
    }
    const limit = entitlement.decision.limitValue;
    if (typeof limit === "number") {
      const count = await repo.countActiveRepoLinks(orgId);
      if (!count.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      if (count.value >= limit) {
        return errorResponse(
          "precondition_failed",
          "Repository link limit reached for your plan",
          412,
          requestId,
          {
            reason: "limit_reached",
            entitlementKey: INTEGRATION_ENTITLEMENTS.REPO_LINKS_LIMIT,
            currentUsage: count.value,
            limitValue: limit,
          },
        );
      }
    }

    const defaultBranch =
      typeof body.defaultBranch === "string" && BRANCH_RE.test(body.defaultBranch)
        ? body.defaultBranch
        : null;
    const created = await repo.createRepoLink({
      id: generateUuid(),
      orgId,
      projectId,
      connectionId: connectionUuid as Uuid,
      repoExternalId,
      repoFullName,
      defaultBranch,
      branchEnvMap: mapResult.map,
      createdBy: uuidFromPublicId(actor.subjectId),
    });
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        return errorResponse(
          "conflict",
          "This repository is already linked to the project",
          409,
          requestId,
        );
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: SCM_EVENT_TYPES.REPO_LINKED,
          version: 1,
          source: "integrations-worker",
          occurredAt: new Date(),
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          projectId,
          subjectKind: "repo_link",
          subjectId: created.value.id,
          subjectName: repoFullName,
          requestId,
          payload: {
            version: 1,
            orgId: orgPublicId(orgId),
            projectId: projectPublicId(projectId),
            environment: null,
            repo: { provider: "github", externalId: repoExternalId, fullName: repoFullName },
            repoLinkId: repoLinkPublicId(created.value.id),
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `Repository linked: ${repoFullName}`,
          projectId,
        },
      });
    } catch {
      // Best-effort audit.
    }

    const payload: CreateRepoLinkResponse = { repoLink: toPublicRepoLink(created.value) };
    return successResponse(payload, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}

// ── List ────────────────────────────────────────────────────

export async function handleListRepoLinks(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: RepoLinkDeps,
): Promise<Response> {
  const denied = await authorizeRepoLinkRead(env, actor, orgId, requestId);
  if (denied) return denied;

  const page = parsePageParams(new URL(request.url));
  if (!page.ok) {
    return validationError(requestId, { [page.field]: [page.reason] });
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const result = await repo.listRepoLinks(
      orgId,
      {
        limit: page.value.limit,
        cursor: page.value.cursor
          ? { createdAt: page.value.cursor.createdAt, id: page.value.cursor.id }
          : null,
      },
      { projectId, status: "active" },
    );
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const payload: ListRepoLinksResponse = {
      repoLinks: result.value.items.map(toPublicRepoLink),
      nextCursor: result.value.nextCursor,
    };
    const cursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;
    return listResponse(payload, requestId, cursor);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}

// ── Update ──────────────────────────────────────────────────

export async function handleUpdateRepoLink(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  repoLinkId: Uuid,
  deps?: RepoLinkDeps,
): Promise<Response> {
  const denied = await authorizeRepoLinkWrite(env, actor, orgId, projectId, requestId);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const mapResult =
    body.branchEnvMap === undefined
      ? null
      : await validateBranchEnvMap(env, orgId, projectId, requestId, body.branchEnvMap);
  if (mapResult && !mapResult.ok) return mapResult.response;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const existing = await repo.getRepoLink(orgId, repoLinkId);
    if (!existing.ok || existing.value.projectId !== projectId) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const updateInput: { defaultBranch?: string; branchEnvMap?: Record<string, string> } = {};
    if (typeof body.defaultBranch === "string" && BRANCH_RE.test(body.defaultBranch)) {
      updateInput.defaultBranch = body.defaultBranch;
    }
    if (mapResult) {
      updateInput.branchEnvMap = mapResult.map;
    }
    const updated = await repo.updateRepoLink(orgId, repoLinkId, updateInput);
    if (!updated.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    const payload: UpdateRepoLinkResponse = { repoLink: toPublicRepoLink(updated.value) };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}

// ── Unlink ──────────────────────────────────────────────────

export async function handleUnlinkRepoLink(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  repoLinkId: Uuid,
  deps?: RepoLinkDeps,
): Promise<Response> {
  const denied = await authorizeRepoLinkWrite(env, actor, orgId, projectId, requestId);
  if (denied) return denied;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const existing = await repo.getRepoLink(orgId, repoLinkId);
    if (!existing.ok || existing.value.projectId !== projectId) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    if (existing.value.status === "active") {
      const unlinked = await repo.unlinkRepoLink(orgId, repoLinkId);
      if (!unlinked.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      try {
        const events = createEventsRepository(executor);
        await events.appendEventWithAudit({
          event: {
            id: generateUuid(),
            type: SCM_EVENT_TYPES.REPO_UNLINKED,
            version: 1,
            source: "integrations-worker",
            occurredAt: new Date(),
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            projectId,
            subjectKind: "repo_link",
            subjectId: repoLinkId,
            subjectName: existing.value.repoFullName,
            requestId,
            payload: {
              version: 1,
              orgId: orgPublicId(orgId),
              projectId: projectPublicId(projectId),
              environment: null,
              repo: {
                provider: "github",
                externalId: existing.value.repoExternalId,
                fullName: existing.value.repoFullName,
              },
              repoLinkId: repoLinkPublicId(repoLinkId),
            },
          },
          audit: {
            id: generateUuid(),
            category: "integrations",
            description: `Repository unlinked: ${existing.value.repoFullName}`,
            projectId,
          },
        });
      } catch {
        // Best-effort audit.
      }
    }
    const payload: DeleteRepoLinkResponse = { deleted: true };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
