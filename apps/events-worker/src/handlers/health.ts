import type { Env } from "../env.js";

export function handleHealth(env: Env, requestId: string): Response {
  return Response.json(
    {
      status: "ok",
      service: "events-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      meta: { requestId },
    },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
