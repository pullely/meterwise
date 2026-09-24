import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const ORG_PROJECTS_RE = /^\/v1\/organizations\/[^/]+\/projects$/;
const ORG_PROJECT_ID_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+$/;
const ORG_PROJECT_ENVIRONMENTS_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/environments$/;
const ORG_PROJECT_ENVIRONMENT_ID_RE = /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/environments\/[^/]+$/;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

export function isProjectRoute(pathname: string): boolean {
  return (
    ORG_PROJECTS_RE.test(pathname) ||
    ORG_PROJECT_ID_RE.test(pathname) ||
    ORG_PROJECT_ENVIRONMENTS_RE.test(pathname) ||
    ORG_PROJECT_ENVIRONMENT_ID_RE.test(pathname)
  );
}

export async function handleProjectRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  if (ORG_PROJECTS_RE.test(pathname) && request.method !== "POST" && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_PROJECT_ID_RE.test(pathname) && request.method !== "GET" && request.method !== "DELETE") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_PROJECT_ENVIRONMENTS_RE.test(pathname) && request.method !== "POST" && request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  if (ORG_PROJECT_ENVIRONMENT_ID_RE.test(pathname) && request.method !== "GET" && request.method !== "DELETE") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "project", async () => {

    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }

    if (!env.PROJECTS_WORKER) {
      return errorResponse("internal_error", "Projects service unavailable", 503, requestId);
    }

    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () => resolveActor(request, env, requestId));
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
    const target = new URL(pathname + url.search, "https://projects.internal");

    const init: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.method === "POST") {
      init.body = request.body;
    }

    try {
      const downstream = await timings.measure("edge_downstream", () => env.PROJECTS_WORKER!.fetch(target.toString(), init));
      const res = new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.project", timings);
    } catch {
      return errorResponse("internal_error", "Projects service unavailable", 503, requestId);
    }
  });
}