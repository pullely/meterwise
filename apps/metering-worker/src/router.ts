import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleRecordUsage } from "./handlers/record-usage.js";
import { handleIngestBatch } from "./handlers/ingest-batch.js";
import { handleGetUsageSummary } from "./handlers/get-usage-summary.js";
import { handleCheckQuota } from "./handlers/check-quota.js";
import { handleListQuotaViolations } from "./handlers/list-quota-violations.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import { generateRequestId, parseOrgPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

// ── Route patterns ──────────────────────────────────────────
const USAGE_RE = /^\/v1\/organizations\/([^/]+)\/usage$/;
const USAGE_BATCH_RE = /^\/v1\/organizations\/([^/]+)\/usage\/batch$/;
const USAGE_SUMMARY_RE = /^\/v1\/organizations\/([^/]+)\/usage\/summary$/;
const QUOTA_CHECK_RE = /^\/v1\/organizations\/([^/]+)\/quotas\/check$/;
const QUOTA_VIOLATIONS_RE = /^\/v1\/organizations\/([^/]+)\/quotas\/violations$/;

type RouteKind = "usage" | "usage_batch" | "usage_summary" | "quota_check" | "quota_violations";

interface MatchedRoute {
  kind: RouteKind;
  orgId: string;
}

function matchRoute(pathname: string): MatchedRoute | null {
  let m = pathname.match(USAGE_BATCH_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "usage_batch", orgId };
  }

  m = pathname.match(USAGE_SUMMARY_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "usage_summary", orgId };
  }

  m = pathname.match(USAGE_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "usage", orgId };
  }

  m = pathname.match(QUOTA_CHECK_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "quota_check", orgId };
  }

  m = pathname.match(QUOTA_VIOLATIONS_RE);
  if (m) {
    const orgId = parseOrgPublicId(m[1]!);
    if (!orgId) return null;
    return { kind: "quota_violations", orgId };
  }

  return null;
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    const matched = matchRoute(url.pathname);
    if (!matched) {
      return notFound(requestId, url.pathname);
    }

    const actor = resolveActor(request);
    if (!actor) {
      return errorResponse("unauthenticated", "Authentication required", 401, requestId);
    }

    switch (matched.kind) {
      case "usage":
        if (request.method !== "POST") return methodNotAllowed(requestId);
        return handleRecordUsage(request, env, requestId, actor, matched.orgId);

      case "usage_batch":
        if (request.method !== "POST") return methodNotAllowed(requestId);
        return handleIngestBatch(request, env, requestId, actor, matched.orgId);

      case "usage_summary":
        if (request.method !== "GET") return methodNotAllowed(requestId);
        return handleGetUsageSummary(request, env, requestId, actor, matched.orgId);

      case "quota_check":
        if (request.method !== "POST") return methodNotAllowed(requestId);
        return handleCheckQuota(request, env, requestId, actor, matched.orgId);

      case "quota_violations":
        if (request.method !== "GET") return methodNotAllowed(requestId);
        return handleListQuotaViolations(request, env, requestId, actor, matched.orgId);
    }
  } catch {
    return errorResponse("internal_error", "Internal error", 500, requestId);
  }
}
