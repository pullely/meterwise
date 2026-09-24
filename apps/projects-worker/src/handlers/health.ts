import type { Env } from "../env.js";
import { successResponse } from "../http.js";

export function handleHealth(env: Env, requestId: string): Response {
  const db = !!env.PLATFORM_DB;
  const membership = !!env.MEMBERSHIP_WORKER;
  const policy = !!env.POLICY_WORKER;

  return successResponse(
    {
      status: "ok",
      service: "projects-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: {
        database: { configured: db },
        membership: { configured: membership },
        policy: { configured: policy },
      },
    },
    requestId,
  );
}
