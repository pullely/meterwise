import { enqueueNotification } from "@saas/notifications-client";
import type { Env } from "./env.js";
import { openDb, type Db } from "./context.js";
import { runSweep, type SweepDeps, type SweepReport } from "./sweep.js";

/** The sweep's dependencies over one database handle and the notifications binding. */
export function sweepDeps(env: Env, db: Db): SweepDeps {
  return {
    guard: db.guard,
    executor: db.executor,
    enqueue: env.NOTIFICATIONS_WORKER
      ? (request, requestId) =>
          enqueueNotification(
            env,
            { internalActor: "ledger-worker", actorSubjectType: "system", actorSubjectId: "ledger-worker", requestId },
            request,
          )
      : null,
  };
}

/** The `scheduled()` entry point: one tick, one fixed-shape log line. */
export async function runScheduledSweep(env: Env, now: Date): Promise<SweepReport | null> {
  const db = openDb(env);
  if (!db) return null;
  try {
    const report = await runSweep(sweepDeps(env, db), now);
    // eslint-disable-next-line no-console -- one structured line per tick for Workers Logs; counts only
    console.log(JSON.stringify({ level: "info", msg: "ledger.sweep", ...report }));
    return report;
  } catch {
    // eslint-disable-next-line no-console -- fixed string; never the error's text
    console.error(JSON.stringify({ level: "error", msg: "ledger.sweep.failed" }));
    return null;
  } finally {
    await db.dispose();
  }
}
