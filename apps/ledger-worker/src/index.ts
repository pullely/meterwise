import type { Env } from "./env.js";
import { route } from "./router.js";
import { runScheduledSweep } from "./scheduled.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // MW2: the anomaly and budget sweep, every 15 minutes (the cron trigger is
  // declared in wrangler.template.jsonc).
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledSweep(env, new Date(controller.scheduledTime)).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
