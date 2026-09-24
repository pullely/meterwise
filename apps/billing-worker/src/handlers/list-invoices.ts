import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ListInvoicesResponse, PublicInvoiceStatus } from "@saas/contracts/billing";
import type { CursorPosition, InvoiceStatus, ListInvoicesQuery } from "@saas/db/billing";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { errorResponse, listResponse, validationError } from "../http.js";
import { authorizeBillingRead } from "../policy.js";
import { resolveBillingOrgHex } from "../billing-scope.js";
import { mapInvoiceToPublic } from "../mappers.js";
import { parseSubscriptionPublicId } from "../ids.js";

const VALID_STATUS: ReadonlySet<PublicInvoiceStatus> = new Set([
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null, requestId: string): number | Response {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    return validationError(requestId, `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return n;
}

function parseCursor(raw: string | null, requestId: string): CursorPosition | null | Response {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(atob(raw)) as Partial<CursorPosition>;
    if (typeof decoded.createdAt !== "string" || typeof decoded.id !== "string") {
      return validationError(requestId, "invalid cursor");
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return validationError(requestId, "invalid cursor");
  }
}

function encodeCursor(c: CursorPosition | null): string | null {
  if (!c) return null;
  return btoa(JSON.stringify(c));
}

export async function handleListInvoices(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  const url = new URL(request.url);

  const rawStatus = url.searchParams.get("status");
  let status: InvoiceStatus | undefined;
  if (rawStatus) {
    if (!VALID_STATUS.has(rawStatus as PublicInvoiceStatus)) {
      return validationError(requestId, "status is invalid");
    }
    status = rawStatus as InvoiceStatus;
  }

  let subscriptionId: string | undefined;
  const rawSub = url.searchParams.get("subscriptionId");
  if (rawSub) {
    const parsed = parseSubscriptionPublicId(rawSub);
    if (!parsed) {
      return validationError(requestId, "invalid subscriptionId");
    }
    subscriptionId = parsed;
  }

  const limitOrErr = parseLimit(url.searchParams.get("limit"), requestId);
  if (typeof limitOrErr !== "number") return limitOrErr;
  const limit = limitOrErr;

  const cursorOrErr = parseCursor(url.searchParams.get("cursor"), requestId);
  if (cursorOrErr instanceof Response) return cursorOrErr;
  const cursor = cursorOrErr;

  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createBillingRepository(executor);
  try {
    // PERF12: authorization and the MO4 billing-parent resolution are
    // independent — run them concurrently. The invoices read needs the resolved
    // org, so it follows the gate (no speculative read of invoice data on deny).
    const [auth, billingOrgId] = await Promise.all([
      authorizeBillingRead(env, actor, orgId, requestId),
      resolveBillingOrgHex(env, orgId, requestId),
    ]);
    if (!auth.ok) return auth.response;

    const query: ListInvoicesQuery = { orgId: billingOrgId, ...(status ? { status } : {}), ...(subscriptionId ? { subscriptionId } : {}) };
    const result = await repo.listInvoices(query, { limit, cursor });
    if (!result.ok) {
      return errorResponse("internal_error", "Failed to list invoices", 503, requestId);
    }

    const body: ListInvoicesResponse = {
      invoices: result.value.items.map(mapInvoiceToPublic),
      nextCursor: result.value.nextCursor,
    };
    return listResponse(body, requestId, encodeCursor(result.value.nextCursor));
  } catch {
    return errorResponse("internal_error", "Failed to list invoices", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
