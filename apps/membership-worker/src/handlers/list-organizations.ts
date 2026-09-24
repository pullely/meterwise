import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId } from "../ids.js";
import { parsePageParams, encodeCursor } from "../pagination.js";

export async function handleListOrganizations(
  env: Env,
  requestId: string,
  actor: ActorContext,
  url: URL,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const pageResult = parsePageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }
  const { limit, cursor } = pageResult.value;

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createMembershipRepository(executor);
    const result = await repo.listOrganizationsForSubjectPaged(actor.subjectId, {
      limit,
      cursor: cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null,
    });

    if (!result.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    const { items, nextCursor } = result.value;
    const organizations = items.map((org) => ({
      id: orgPublicId(org.id),
      name: org.name,
      slug: org.slug,
      status: org.status,
      createdAt: org.createdAt.toISOString(),
    }));

    const cursorToken = nextCursor ? encodeCursor(nextCursor.createdAt, nextCursor.id) : null;
    return successResponse({ organizations }, requestId, 200, cursorToken);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await executor.dispose();
  }
}
