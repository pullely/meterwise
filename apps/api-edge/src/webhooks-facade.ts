import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

// Organization-scoped webhook routes
const ORG_WEBHOOKS_RE = /^\/v1\/organizations\/[^/]+\/webhooks\//;

// Project-scoped webhook routes
const PRJ_WEBHOOKS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/webhooks\//;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

export function isWebhooksRoute(pathname: string): boolean {
  return ORG_WEBHOOKS_RE.test(pathname) || PRJ_WEBHOOKS_RE.test(pathname);
}

export async function handleWebhooksRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const allowedMethods = ["GET", "POST", "PATCH", "DELETE"];
  if (!allowedMethods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "webhooks", async () => {

    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }

    if (!env.WEBHOOKS_WORKER) {
      return errorResponse("internal_error", "Webhooks service unavailable", 503, requestId);
    }

    const sessionResult = await resolveActor(request, env, requestId);
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    if (sessionResult.orgId) {
    }
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://webhooks.internal");

    try {
      const fetchInit: RequestInit = {
        method: request.method,
        headers,
      };
      if (request.method === "POST" || request.method === "PATCH") {
        fetchInit.body = request.body;
      }
      const downstream = await env.WEBHOOKS_WORKER.fetch(target.toString(), fetchInit);
      return new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
    } catch {
      return errorResponse("internal_error", "Webhooks service unavailable", 503, requestId);
    }
  });
}