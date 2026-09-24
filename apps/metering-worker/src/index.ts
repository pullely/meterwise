import type { Env } from "./env.js";
import { route } from "./router.js";
import { runScheduledMaterialization } from "./rollups.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduledMaterialization(env);
  },
} satisfies ExportedHandler<Env>;

// perf(db): reverted to per-request DB client (task 0134 connection reuse rolled back).
