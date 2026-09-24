import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleAuthorize } from "./handlers/authorize.js";
import { handleEffectivePermissions } from "./handlers/effective-permissions.js";
import { handleValidateRoleAssignment } from "./handlers/validate-role-assignment.js";
import { errorResponse } from "./http.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function generateRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `req_${hex}`;
}

export async function route(request: Request, env: Env): Promise<Response> {
  const requestId = resolveRequestId(request);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  try {
    if (method === "GET" && path === "/health") {
      return handleHealth(env, requestId);
    }

    if (method === "POST" && path === "/v1/internal/policy/authorize") {
      return await handleAuthorize(request, requestId);
    }

    if (method === "POST" && path === "/v1/internal/policy/effective-permissions") {
      return await handleEffectivePermissions(request, requestId);
    }

    if (method === "POST" && path === "/v1/internal/policy/role-assignments/validate") {
      return await handleValidateRoleAssignment(request, requestId);
    }

    return errorResponse("not_found", "Route not found", 404, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
