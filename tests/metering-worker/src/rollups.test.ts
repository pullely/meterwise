import {
  materializeRecentRollups,
  recentDayWindow,
  recentHourWindow,
  runScheduledMaterialization,
} from "@metering-worker/rollups";
import type { Env } from "@metering-worker/env";
import type {
  MeteringRepository,
  RollupMaterializationWindow,
} from "@saas/db/metering";

// ── Fake repo ──────────────────────────────────────────────

interface MaterializeCall {
  bucketType: string;
  startMs: number;
  endMs: number;
}

function createFakeRepo(opts?: {
  hourOk?: boolean;
  dayOk?: boolean;
  hourRows?: number;
  dayRows?: number;
}): MeteringRepository & { materializeCalls: MaterializeCall[] } {
  const calls: MaterializeCall[] = [];
  const hourOk = opts?.hourOk ?? true;
  const dayOk = opts?.dayOk ?? true;
  const hourRows = opts?.hourRows ?? 3;
  const dayRows = opts?.dayRows ?? 7;

  const repo: Partial<MeteringRepository> & {
    materializeCalls: MaterializeCall[];
  } = {
    materializeCalls: calls,
    async materializeUsageRollups(window: RollupMaterializationWindow) {
      calls.push({
        bucketType: window.bucketType,
        startMs: window.start.getTime(),
        endMs: window.end.getTime(),
      });
      const ok = window.bucketType === "hour" ? hourOk : dayOk;
      if (!ok) {
        return { ok: false, error: { kind: "internal", message: "boom" } };
      }
      return {
        ok: true,
        value: {
          bucketType: window.bucketType,
          windowStart: window.start,
          windowEnd: window.end,
          rollupsWritten: window.bucketType === "hour" ? hourRows : dayRows,
        },
      };
    },
  };
  return repo as MeteringRepository & { materializeCalls: MaterializeCall[] };
}

// ── Window math ───────────────────────────────────────────

describe("recentHourWindow", () => {
  it("returns [prior-hour-start, next-hour-start) — a 2-hour bounded window", () => {
    const now = new Date("2026-03-15T12:37:42.123Z");
    const { start, end } = recentHourWindow(now);
    expect(end.toISOString()).toBe("2026-03-15T13:00:00.000Z");
    expect(start.toISOString()).toBe("2026-03-15T11:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(2 * 60 * 60 * 1000);
  });

  it("handles UTC day rollover correctly", () => {
    const now = new Date("2026-03-15T23:50:00.000Z");
    const { start, end } = recentHourWindow(now);
    expect(end.toISOString()).toBe("2026-03-16T00:00:00.000Z");
    expect(start.toISOString()).toBe("2026-03-15T22:00:00.000Z");
  });
});

describe("recentDayWindow", () => {
  it("returns [prior-day-start, next-day-start) — a 2-day bounded window", () => {
    const now = new Date("2026-03-15T12:37:42.123Z");
    const { start, end } = recentDayWindow(now);
    expect(end.toISOString()).toBe("2026-03-16T00:00:00.000Z");
    expect(start.toISOString()).toBe("2026-03-14T00:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it("handles month/year rollover correctly", () => {
    const now = new Date("2026-12-31T18:00:00.000Z");
    const { start, end } = recentDayWindow(now);
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(start.toISOString()).toBe("2026-12-30T00:00:00.000Z");
  });
});

// ── materializeRecentRollups ──────────────────────────────

describe("materializeRecentRollups", () => {
  it("invokes hour and day materializations on a bounded recent window", async () => {
    const repo = createFakeRepo();
    const now = new Date("2026-03-15T12:00:00.000Z");
    const result = await materializeRecentRollups(repo, now);

    expect(repo.materializeCalls).toHaveLength(2);
    const buckets = repo.materializeCalls.map((c) => c.bucketType).sort();
    expect(buckets).toEqual(["day", "hour"]);

    // No call may scan more than the documented bounded window.
    for (const call of repo.materializeCalls) {
      const span = call.endMs - call.startMs;
      if (call.bucketType === "hour") {
        expect(span).toBe(2 * 60 * 60 * 1000);
      } else {
        expect(span).toBe(2 * 24 * 60 * 60 * 1000);
      }
    }

    expect(result.errors).toBe(0);
    expect(result.windows).toHaveLength(2);
    expect(result.windows.every((w) => w.ok)).toBe(true);
    expect(result.windows.find((w) => w.bucketType === "hour")!.rollupsWritten).toBe(3);
    expect(result.windows.find((w) => w.bucketType === "day")!.rollupsWritten).toBe(7);
  });

  it("continues the day pass even if the hour pass fails, and surfaces error count", async () => {
    const repo = createFakeRepo({ hourOk: false });
    const result = await materializeRecentRollups(repo, new Date("2026-03-15T12:00:00.000Z"));
    expect(result.errors).toBe(1);
    const hour = result.windows.find((w) => w.bucketType === "hour")!;
    const day = result.windows.find((w) => w.bucketType === "day")!;
    expect(hour.ok).toBe(false);
    expect(hour.rollupsWritten).toBe(0);
    expect(day.ok).toBe(true);
  });
});

// ── runScheduledMaterialization ───────────────────────────

describe("runScheduledMaterialization", () => {
  it("fails closed and logs when PLATFORM_DB is missing — no throw, no repo call", async () => {
    const env: Env = { ENVIRONMENT: "test" };
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      await expect(runScheduledMaterialization(env)).resolves.toBeUndefined();
    } finally {
      console.error = originalError;
    }
    expect(errors.some((e) => String(e[0]).includes("PLATFORM_DB binding missing"))).toBe(true);
  });
});
