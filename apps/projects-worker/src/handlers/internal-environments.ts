// Internal worker-to-worker seam: resolve a project's live environments so
// other bounded contexts can validate environment references (first consumer:
// integrations-worker validating branch → environment maps, IG3).
//
// Reachable only over Cloudflare service bindings — there is no public route
// to this path and api-edge never forwards /v1/internal/*. No actor, no
// policy: the caller is a platform worker acting on already-authorized input;
// ids arrive as raw UUIDs.

import type { Env } from "../env.js";
import { createProjectsRepository } from "@saas/db/projects";
import { createSqlExecutor } from "@saas/db/d1";
import { asUuid, isUuid } from "@saas/db/ids";
import { errorResponse, successResponse } from "../http.js";

const MAX_ENVIRONMENTS = 100;

export async function handleInternalListEnvironments(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId") ?? "";
  const projectId = url.searchParams.get("projectId") ?? "";
  if (!isUuid(orgId) || !isUuid(projectId)) {
    return errorResponse("bad_request", "orgId and projectId must be UUIDs", 400, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createProjectsRepository(executor);
    const result = await repo.listEnvironmentsPaged(asUuid(orgId), asUuid(projectId), {
      limit: MAX_ENVIRONMENTS,
      cursor: null,
    });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return successResponse(
      {
        environments: result.value.items.map((e) => ({
          id: e.id,
          slug: e.slug,
          name: e.name,
          status: e.status,
        })),
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
