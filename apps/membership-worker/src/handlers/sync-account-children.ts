import type { Env } from "../env.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { successResponse, errorResponse } from "../http.js";
import { parseOrgPublicId, orgPublicId } from "../ids.js";
import { fanOutPlan, type FanOutResult } from "../billing-client.js";

/**
 * Internal, service-binding-only child re-sync (MO3). Called by billing-worker
 * after a billing parent's plan changes:
 *   - "refanout": reactivate each child (unfreeze) and re-copy the parent's
 *     entitlements onto it (so plan upgrades/changes propagate).
 *   - "freeze":   suspend each child (flag-only freeze; access-enforcement is a
 *     later milestone — the console surfaces a warning meanwhile).
 *
 * Per-child best-effort: one failing child never aborts the rest.
 */

type Mode = "refanout" | "freeze";
type RepoSlice = Pick<MembershipRepository, "listChildOrganizations" | "setOrganizationStatus">;

export interface SyncChildrenDeps {
  repo?: RepoSlice;
  /** Injectable billing fan-out (refanout mode); defaults to the real seam. */
  fanOut?: (parentOrgPublicId: string, childOrgPublicId: string) => Promise<FanOutResult>;
  now?: () => Date;
}

export function parseSyncBody(
  body: unknown,
): { parentHex: string; parentPublic: string; mode: Mode } | { error: string } {
  if (!body || typeof body !== "object") return { error: "request body must be a JSON object" };
  const o = body as Record<string, unknown>;
  const parent = o.parentOrgId;
  const mode = o.mode;
  if (typeof parent !== "string") return { error: "parentOrgId is required" };
  if (mode !== "refanout" && mode !== "freeze") return { error: "mode must be 'refanout' or 'freeze'" };
  const parentHex = parseOrgPublicId(parent);
  if (!parentHex) return { error: "parentOrgId is malformed" };
  return { parentHex, parentPublic: parent, mode };
}

export async function handleSyncAccountChildren(
  request: Request,
  env: Env,
  requestId: string,
  deps: SyncChildrenDeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  }
  if (!deps.repo && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const parsed = parseSyncBody(payload);
  if ("error" in parsed) return errorResponse("bad_request", parsed.error, 400, requestId);

  const now = deps.now ? deps.now() : new Date();
  const executor = deps.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps.repo ?? createMembershipRepository(executor!);
    const childrenRes = await repo.listChildOrganizations(parsed.parentHex);
    if (!childrenRes.ok) {
      return errorResponse("internal_error", "Failed to list child organizations", 503, requestId);
    }

    const doFanOut = deps.fanOut ?? ((p: string, c: string) => realFanOut(env, p, c, requestId));
    let synced = 0;
    for (const child of childrenRes.value) {
      if (parsed.mode === "freeze") {
        const r = await repo.setOrganizationStatus(child.id, "suspended", now);
        if (r.ok) synced++;
      } else {
        // refanout: reactivate (in case it was frozen) then re-copy entitlements.
        await repo.setOrganizationStatus(child.id, "active", now);
        await doFanOut(parsed.parentPublic, orgPublicId(child.id));
        synced++;
      }
    }
    return successResponse({ mode: parsed.mode, childrenSynced: synced }, requestId);
  } catch {
    return errorResponse("internal_error", "Failed to sync child organizations", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

async function realFanOut(
  env: Env,
  parentOrgPublicId: string,
  childOrgPublicId: string,
  requestId: string,
): Promise<FanOutResult> {
  if (!env.BILLING_WORKER) return { kind: "service_error" };
  return fanOutPlan(env.BILLING_WORKER as Fetcher, parentOrgPublicId, childOrgPublicId, requestId);
}
