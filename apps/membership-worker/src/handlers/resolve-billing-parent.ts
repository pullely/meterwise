import type { Env } from "../env.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { successResponse, errorResponse } from "../http.js";
import { parseOrgPublicId, orgPublicId } from "../ids.js";

/**
 * Internal, service-binding-only resolution of an org to the org whose billing
 * covers it (MO4): its parent when it is a child, otherwise itself. Used by
 * billing-worker so a child org's billing reads (summary/invoices/customer)
 * resolve to the account's single subscription/customer on the parent.
 */

export interface ResolveBillingParentDeps {
  repo?: Pick<MembershipRepository, "getOrganizationById">;
}

export async function handleResolveBillingParent(
  request: Request,
  env: Env,
  requestId: string,
  deps: ResolveBillingParentDeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  }
  if (!deps.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const raw = (body as { orgId?: unknown } | null)?.orgId;
  if (typeof raw !== "string") {
    return errorResponse("bad_request", "orgId is required", 400, requestId);
  }
  const hex = parseOrgPublicId(raw);
  if (!hex) {
    return errorResponse("bad_request", "orgId is malformed", 400, requestId);
  }

  const executor = deps.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps.repo ?? createMembershipRepository(executor!);
    const res = await repo.getOrganizationById(hex);
    if (!res.ok) {
      if (res.error.kind === "not_found") {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      return errorResponse("internal_error", "Failed to resolve billing parent", 503, requestId);
    }
    const billingHex = effectiveBillingOrgId(res.value);
    return successResponse(
      { orgId: raw, billingOrgId: orgPublicId(billingHex), isChild: res.value.parentOrgId !== null },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Failed to resolve billing parent", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
