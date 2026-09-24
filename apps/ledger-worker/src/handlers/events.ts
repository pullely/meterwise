import type { ListLlmEventsResponse } from "@saas/contracts/ledger";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { successResponse, validationError } from "../http.js";
import { toPublicEvent } from "../present.js";
import { eventsCursor, validateEventsQuery } from "../validate.js";
import { withDb } from "./common.js";

/** GET /v1/organizations/{org}/llm-events — newest first, paged by a (received_at, id) cursor. */
export async function handleListEvents(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "ledger.read", async (db) => {
    const v = validateEventsQuery(new URL(request.url).searchParams);
    if (!v.valid) return validationError(requestId, v.fields);
    const rows = await db.ledger.listEvents(orgId, { ...v.value, limit: v.value.limit + 1 });
    const page = rows.slice(0, v.value.limit);
    const last = page[page.length - 1];
    const body: ListLlmEventsResponse = {
      events: page.map(toPublicEvent),
      nextBefore: rows.length > v.value.limit && last ? eventsCursor(last.receivedAt, last.id) : null,
    };
    return successResponse(body, requestId);
  });
}
