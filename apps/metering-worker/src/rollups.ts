import { createMeteringRepository } from "@saas/db/metering";
import type {
  MeteringRepository,
  RollupMaterializationResult,
} from "@saas/db/metering";
import { createSqlExecutor } from "@saas/db/d1";
import type { Env } from "./env.js";

/**
 * Bounded window descriptor for a scheduled rollup pass.
 *
 * Each pass materializes two windows:
 *   - prior + current hour  → `hour` rollups
 *   - prior + current day   → `day` rollups
 *
 * The windows are intentionally narrow: a scheduled invocation must never
 * scan unbounded usage history. Backfills for older windows are out of scope
 * for this seam and require a dedicated maintenance entry point.
 */
export interface ScheduledWindowSummary {
  bucketType: "hour" | "day";
  windowStart: string;
  windowEnd: string;
  rollupsWritten: number;
  ok: boolean;
}

export interface MaterializeAllResult {
  windows: ScheduledWindowSummary[];
  errors: number;
}

/** Compute `[startOfPriorHour, startOfNextHour)` from a reference instant. */
export function recentHourWindow(now: Date): { start: Date; end: Date } {
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() + 1,
      0,
      0,
      0,
    ),
  );
  const start = new Date(end.getTime() - 2 * 60 * 60 * 1000);
  return { start, end };
}

/** Compute `[startOfPriorDay, startOfNextDay)` from a reference instant. */
export function recentDayWindow(now: Date): { start: Date; end: Date } {
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
  const start = new Date(end.getTime() - 2 * 24 * 60 * 60 * 1000);
  return { start, end };
}

function toSummary(r: RollupMaterializationResult): ScheduledWindowSummary {
  return {
    bucketType: r.bucketType,
    windowStart: r.windowStart.toISOString(),
    windowEnd: r.windowEnd.toISOString(),
    rollupsWritten: r.rollupsWritten,
    ok: true,
  };
}

/**
 * Materialize hour and day rollups over a conservative recent window.
 *
 * Returns a per-window summary. Both passes are attempted independently; a
 * failure in one does not skip the other. No raw usage metadata, bearer
 * tokens, or per-org rows are returned — only window bounds and counts.
 */
export async function materializeRecentRollups(
  repo: MeteringRepository,
  now: Date = new Date(),
): Promise<MaterializeAllResult> {
  const windows: ScheduledWindowSummary[] = [];
  let errors = 0;

  const hour = recentHourWindow(now);
  const hourResult = await repo.materializeUsageRollups({
    bucketType: "hour",
    start: hour.start,
    end: hour.end,
  });
  if (hourResult.ok) {
    windows.push(toSummary(hourResult.value));
  } else {
    errors++;
    windows.push({
      bucketType: "hour",
      windowStart: hour.start.toISOString(),
      windowEnd: hour.end.toISOString(),
      rollupsWritten: 0,
      ok: false,
    });
  }

  const day = recentDayWindow(now);
  const dayResult = await repo.materializeUsageRollups({
    bucketType: "day",
    start: day.start,
    end: day.end,
  });
  if (dayResult.ok) {
    windows.push(toSummary(dayResult.value));
  } else {
    errors++;
    windows.push({
      bucketType: "day",
      windowStart: day.start.toISOString(),
      windowEnd: day.end.toISOString(),
      rollupsWritten: 0,
      ok: false,
    });
  }

  return { windows, errors };
}

/**
 * Scheduled entry point: opens an executor against the D1 binding,
 * runs the recent-window materialization, and logs bounded counts only.
 *
 * Fails closed when `PLATFORM_DB` is missing — does not throw.
 */
export async function runScheduledMaterialization(env: Env): Promise<void> {
  if (!env.PLATFORM_DB) {
    console.error("[scheduled] PLATFORM_DB binding missing");
    return;
  }
  const executor = createSqlExecutor(env.PLATFORM_DB);
  const repo = createMeteringRepository(executor);
  const result = await materializeRecentRollups(repo);
  for (const w of result.windows) {
    console.warn(
      `[scheduled] rollup ${w.bucketType} ${w.windowStart}..${w.windowEnd} ok=${w.ok} rows=${w.rollupsWritten}`,
    );
  }
  if (result.errors > 0) {
    console.error(`[scheduled] rollup pass completed with ${result.errors} errors`);
  }
}
