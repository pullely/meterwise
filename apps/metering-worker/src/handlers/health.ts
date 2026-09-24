import type { Env } from "../env.js";
import { successResponse, errorResponse } from "../http.js";

export function handleHealth(env: Env, requestId: string): Response {
  const missing: string[] = [];
  if (!env.PLATFORM_DB) missing.push("PLATFORM_DB");
  if (!env.MEMBERSHIP_WORKER) missing.push("MEMBERSHIP_WORKER");
  if (!env.POLICY_WORKER) missing.push("POLICY_WORKER");

  if (missing.length > 0) {
    return errorResponse(
      "misconfigured",
      `Missing bindings: ${missing.join(", ")}`,
      503,
      requestId,
    );
  }

  return successResponse({ status: "ok" }, requestId);
}
