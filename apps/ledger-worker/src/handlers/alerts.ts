import type { ListAlertsResponse, PublicAlert } from "@saas/contracts/ledger";
import type { LedgerAlert } from "@saas/db/ledger";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { successResponse } from "../http.js";
import { alertPublicId } from "../ids.js";
import { withDb } from "./common.js";
import { parseAlertSubject } from "../sweep.js";

export function toPublicAlert(a: LedgerAlert): PublicAlert {
  const [tenant, second] = parseAlertSubject(a.subject);
  return {
    id: alertPublicId(a.id),
    kind: a.kind,
    tenant: tenant ?? a.subject,
    feature: a.kind === "runaway_loop" ? second || null : null,
    user: a.kind === "abusive_user" ? second || null : null,
    windowStart: a.windowStart,
    windowEnd: a.windowEnd,
    detail: a.detail,
    status: a.status,
    recipients: a.recipients,
    accepted: a.accepted,
    createdAt: a.createdAt,
  };
}

/** GET /v1/organizations/{org}/alerts — the 100 newest. */
export async function handleListAlerts(_request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "ledger.read", async (db) => {
    const body: ListAlertsResponse = { alerts: (await db.guard.listAlerts(orgId, 100)).map(toPublicAlert) };
    return successResponse(body, requestId);
  });
}
