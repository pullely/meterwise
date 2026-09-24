import type { Env } from "../env.js";
import { createD1Adapter } from "@saas/db/d1";

export async function handleHealth(env: Env, requestId: string): Promise<Response> {
  const dbCheck = await checkDatabase(env);
  const debugDelivery = env.DEBUG_DELIVERY === "true";

  const status = !dbCheck.configured ? "ok" : dbCheck.reachable ? "ok" : "degraded";
  const code = status === "ok" ? 200 : 503;

  return Response.json(
    {
      data: {
        status,
        service: "identity-worker",
        environment: env.ENVIRONMENT ?? "local",
        timestamp: new Date().toISOString(),
        checks: {
          database: dbCheck,
          debugDelivery: { enabled: debugDelivery },
        },
      },
      meta: { requestId, cursor: null },
    },
    { status: code },
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
