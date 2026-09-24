import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

// Meterwise (ledger-worker). One authenticated lane, /v1/organizations/{org}/…:
// llm-events (ingest from the customer's SDK with a baseline API key, and the
// event list), llm-costs and llm-prices. resolveActor → actor headers over the
// LEDGER_WORKER binding, like every other org route; an API key resolves to its
// service principal, and the worker runs membership + policy itself. The
// `ledger` rate-limit family (rate-limit.ts) is sized for SDK ingest.

const LEDGER_RE = /^\/v1\/organizations\/[^/]+\/llm-(?:events|costs|prices)$/;

const FORWARDED_HEADERS = ["content-type", "content-length", "traceparent", "idempotency-key"];
const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

export function isLedgerRoute(pathname: string): boolean {
  return LEDGER_RE.test(pathname);
}

export async function handleLedgerRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  return replayOrExecute(request, requestId, env, "ledger", async () => {
    if (!env.LEDGER_WORKER) {
      return errorResponse("internal_error", "Ledger service unavailable", 503, requestId);
    }
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const session = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
    if ("error" in session) return session.error;

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", session.subjectId);
    headers.set("x-actor-subject-type", session.subjectType);
    headers.set("x-actor-email", session.email);
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://ledger.internal");
    const init: RequestInit = { method: request.method, headers };
    if (BODY_METHODS.has(request.method)) init.body = request.body;

    try {
      const downstream = await timings.measure("edge_downstream", () =>
        env.LEDGER_WORKER!.fetch(target.toString(), init),
      );
      const res = new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.ledger", timings);
    } catch {
      return errorResponse("internal_error", "Ledger service unavailable", 503, requestId);
    }
  });
}
