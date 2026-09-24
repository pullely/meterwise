import type { Env } from "../env.js";
import { createD1Adapter } from "@saas/db/d1";

export async function handleHealth(env: Env, _requestId: string): Promise<Response> {
  const db = await checkDatabase(env);

  return Response.json(
    {
      status: db.configured && !db.reachable ? "degraded" : "ok",
      service: "notifications-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: { database: db },
    },
    { status: db.configured && !db.reachable ? 503 : 200 },
  );
}

async function checkDatabase(env: Env): Promise<{ configured: boolean; reachable: boolean }> {
  if (!env.PLATFORM_DB) {
    return { configured: false, reachable: false };
  }
  const adapter = createD1Adapter(env.PLATFORM_DB);
  try {
    return await adapter.ping();
  } finally {
    await adapter.dispose();
  }
}
