import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;

// perf(db): reverted to per-request DB client (task 0134 connection reuse rolled back).
// fix(db): members list batched role lookup uses a scalar IN-list (was ANY($array), which 500'd under fetch_types:false).
