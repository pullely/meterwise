import type { Env } from "./env.js";
import { errorResponse } from "./errors.js";
import { newRequestId } from "./ids.js";
import { logEvent } from "./log.js";
import { handleChatCompletions } from "./proxy.js";

export function handleHealth(env: Env): Response {
  return Response.json({
    status: "ok",
    service: "proxy-worker",
    environment: env.ENVIRONMENT ?? "local",
    checks: {
      identity: { configured: !!env.IDENTITY_WORKER },
      ledger: { configured: !!env.LEDGER_WORKER },
      // "openai" in prod: the constant origin. "override" only where a stage
      // or test binding stands in for the provider.
      upstream: env.UPSTREAM_OVERRIDE ? "override" : "openai",
    },
  });
}

export async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health" && request.method === "GET") return handleHealth(env);
  if (path === "/v1/chat/completions") {
    if (request.method !== "POST") return errorResponse("method_not_allowed", newRequestId());
    return handleChatCompletions(request, env, ctx);
  }
  const requestId = newRequestId();
  logEvent({ requestId, org: null, route: "other", outcome: "not_found", status: 404, upstreamStatus: null, latencyMs: 0, model: null, tokens: null, metered: false });
  return errorResponse("not_found", requestId);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
