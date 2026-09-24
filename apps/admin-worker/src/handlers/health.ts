import type { Env } from "../env.js";
import { isDbConfigured } from "../support-events.js";

export function handleHealth(env: Env, requestId: string): Response {
  return Response.json(
    {
      status: "ok",
      service: "admin-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: { database: { configured: isDbConfigured(env) } },
    },
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
    },
  );
}
