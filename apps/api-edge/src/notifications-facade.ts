import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { enforceRateLimit, mergeRateLimitHeaders } from "./rate-limit.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

/**
 * Public facade for end-user notification preferences (PX3).
 *
 * `GET` / `PUT /v1/notifications/preferences` forward to notifications-worker
 * over the service binding. The subject is **pinned to the resolved session
 * actor**: whatever `subjectKind` / `subjectId` the caller supplies is
 * replaced with `user` / the actor's own id, so a user can only ever read or
 * update their own preferences. Org-level (subjectKind=organization) defaults
 * remain internal-only — no public route exposes them.
 */

const PREFERENCES_PATH = "/v1/notifications/preferences";

export function isNotificationsRoute(pathname: string): boolean {
  return pathname === PREFERENCES_PATH;
}

export async function handleNotificationsRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  const rateDecision = await enforceRateLimit(request, requestId, env, "notifications");
  if (rateDecision.kind === "denied") {
    return rateDecision.response;
  }
  const rateHeaders = rateDecision.headers;

  if (!env.IDENTITY_WORKER) {
    return mergeRateLimitHeaders(
      errorResponse("internal_error", "Authentication service unavailable", 503, requestId),
      rateHeaders,
    );
  }
  if (!env.NOTIFICATIONS_WORKER) {
    return mergeRateLimitHeaders(
      errorResponse("internal_error", "Notifications service unavailable", 503, requestId),
      rateHeaders,
    );
  }

  const timings = createTimings();
  const endTotal = timings.start("edge_total");
  const sessionResult = await timings.measure("edge_auth", () =>
    resolveActor(request, env, requestId),
  );
  if ("error" in sessionResult) {
    return mergeRateLimitHeaders(sessionResult.error, rateHeaders);
  }

  const headers = new Headers();
  headers.set("x-request-id", requestId);
  // notifications-worker's internal-actor gate: the edge is an allowed caller
  // and the actor headers carry the pinned subject.
  headers.set("x-internal-actor", "api-edge");
  headers.set("x-actor-subject-id", sessionResult.subjectId);
  headers.set("x-actor-subject-type", sessionResult.subjectType);
  const traceparent = request.headers.get("traceparent");
  if (traceparent) headers.set("traceparent", traceparent);

  const url = new URL(request.url);
  let init: RequestInit;
  let target: URL;

  if (request.method === "GET") {
    // Rebuild the query with the subject pinned to the actor; pass through
    // only orgId and the optional channel filter.
    target = new URL(pathname, "https://notifications.internal");
    const orgId = url.searchParams.get("orgId");
    if (orgId) target.searchParams.set("orgId", orgId);
    const channel = url.searchParams.get("channel");
    if (channel) target.searchParams.set("channel", channel);
    target.searchParams.set("subjectKind", "user");
    target.searchParams.set("subjectId", sessionResult.subjectId);
    init = { method: "GET", headers };
  } else {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return mergeRateLimitHeaders(
        errorResponse("bad_request", "Invalid JSON body", 400, requestId),
        rateHeaders,
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return mergeRateLimitHeaders(
        errorResponse("bad_request", "Body must be a JSON object", 400, requestId),
        rateHeaders,
      );
    }
    const pinned = {
      ...(body as Record<string, unknown>),
      subjectKind: "user",
      subjectId: sessionResult.subjectId,
    };
    headers.set("content-type", "application/json");
    target = new URL(pathname, "https://notifications.internal");
    init = { method: "PUT", headers, body: JSON.stringify(pinned) };
  }

  try {
    const downstream = await timings.measure("edge_downstream", () =>
      env.NOTIFICATIONS_WORKER!.fetch(target.toString(), init),
    );
    endTotal();
    return mergeRateLimitHeaders(
      withEdgeTimings(
        new Response(downstream.body, {
          status: downstream.status,
          headers: downstream.headers,
        }),
        requestId,
        "edge.notifications",
        timings,
      ),
      rateHeaders,
    );
  } catch {
    return mergeRateLimitHeaders(
      errorResponse("internal_error", "Notifications service unavailable", 503, requestId),
      rateHeaders,
    );
  }
}
