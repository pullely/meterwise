import type { Env } from "./env.js";
import { route } from "./router.js";
import { drainInboundDeliveries } from "./drain.js";
import { createSqlExecutor } from "@saas/db/d1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // Inbox drain (IG2): attribute received inbound deliveries to connections,
  // process provider lifecycle events, normalize and emit `scm.*` into the
  // event log. NOTE: the cron trigger is not attached yet — the Cloudflare
  // account is at its 5-cron limit (see the epic IMPLEMENTATION-STATUS) —
  // so this handler is ready but idle until a slot frees.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_DB) {
      return;
    }
    const executor = createSqlExecutor(env.PLATFORM_DB);
    try {
      const summary = await drainInboundDeliveries(executor, env);
      if (summary.processed > 0) {
        console.warn(
          `[scheduled] drain: ${summary.emitted} emitted, ${summary.skipped} skipped, ${summary.retried} retried, ${summary.failed} failed`,
        );
      }
    } finally {
      if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
        await (executor as unknown as { dispose: () => Promise<void> }).dispose();
      }
    }
  },
} satisfies ExportedHandler<Env>;
