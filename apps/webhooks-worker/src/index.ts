import type { Env } from "./env.js";
import { route } from "./router.js";
import { dispatchNewEvents, retryFailedDeliveries } from "./delivery.js";
import { createEncryptionAdapter } from "./encryption.js";
import { createWebhookRepository } from "@saas/db/webhooks";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_DB) {
      console.error("[scheduled] PLATFORM_DB binding missing");
      return;
    }

    const executor = createSqlExecutor(env.PLATFORM_DB);
    const webhookRepo = createWebhookRepository(executor);
    const eventsRepo = createEventsRepository(executor);
    const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);

    const ctx = { webhookRepo, eventsRepo, encryption };

    // Phase 1: Dispatch new events
    const dispatchResult = await dispatchNewEvents(ctx);
    if (dispatchResult.dispatched > 0 || dispatchResult.errors > 0) {
      console.warn(`[scheduled] dispatch: ${dispatchResult.dispatched} delivered, ${dispatchResult.errors} errors`);
    }

    // Phase 2: Retry failed deliveries
    const retryResult = await retryFailedDeliveries(ctx);
    if (retryResult.retried > 0 || retryResult.errors > 0) {
      console.warn(`[scheduled] retry: ${retryResult.retried} retried, ${retryResult.errors} errors`);
    }
  },
} satisfies ExportedHandler<Env>;

// perf(db): reverted to per-request DB client (task 0134 connection reuse rolled back).
