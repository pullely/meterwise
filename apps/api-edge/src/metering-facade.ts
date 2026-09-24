import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

const ORG_USAGE_RE = /^\/v1\/organizations\/[^/]+\/usage$/;
const ORG_USAGE_BATCH_RE = /^\/v1\/organizations\/[^/]+\/usage\/batch$/;
const ORG_USAGE_SUMMARY_RE = /^\/v1\/organizations\/[^/]+\/usage\/summary$/;
const ORG_QUOTA_CHECK_RE = /^\/v1\/organizations\/[^/]+\/quotas\/check$/;
const ORG_QUOTA_VIOLATIONS_RE = /^\/v1\/organizations\/[^/]+\/quotas\/violations$/;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

export function isMeteringRoute(pathname: string): boolean {
  return (
    ORG_USAGE_RE.test(pathname) ||
    ORG_USAGE_BATCH_RE.test(pathname) ||
    ORG_USAGE_SUMMARY_RE.test(pathname) ||
    ORG_QUOTA_CHECK_RE.test(pathname) ||
    ORG_QUOTA_VIOLATIONS_RE.test(pathname)
  );
}

export async function handleMeteringRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const allowedMethods = ["GET", "POST"];
  if (!allowedMethods.includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "metering", async () => {

    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }

    if (!env.METERING_WORKER) {
      return errorResponse("internal_error", "Metering service unavailable", 503, requestId);
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
    const target = new URL(pathname + url.search, "https://metering.internal");

    try {
      const fetchInit: RequestInit = {
        method: request.method,
        headers,
      };
      if (request.method === "POST") {
        fetchInit.body = request.body;
      }
      const downstream = await env.METERING_WORKER.fetch(target.toString(), fetchInit);
      return new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
    } catch {
      return errorResponse("internal_error", "Metering service unavailable", 503, requestId);
    }
  });
}