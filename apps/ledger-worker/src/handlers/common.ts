import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { openDb, type Db } from "../context.js";
import { notFound, unavailable, validationError } from "../http.js";

export type LedgerAction = "ledger.read" | "ledger.ingest";

export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

export function invalidJson(requestId: string): Response {
  return validationError(requestId, { body: ["Invalid JSON"] });
}

/**
 * Authorize, open the database, run `fn`, always dispose. Deny-by-default: a
 * caller without `action` on the org gets 404, never 403, so a non-member (or
 * another org's API key) cannot probe whether anything exists. Any throw is a
 * 503, never a 500 that leaks a stack.
 */
export async function withDb(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  action: LedgerAction,
  fn: (db: Db) => Promise<Response>,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, action, requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db) return unavailable(requestId);
  try {
    return await fn(db);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
