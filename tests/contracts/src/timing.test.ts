import {
  createTimings,
  parseServerTimingDuration,
  appendServerTiming,
  shouldEmitTimingLog,
} from "@saas/contracts/timing";

describe("contracts: timing (Server-Timing helper)", () => {
  // Deterministic clock: each call advances by the queued deltas.
  function fakeClock(values: number[]): () => number {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)]!;
  }

  it("records a phase via start()/end and renders a Server-Timing header", () => {
    const t = createTimings(fakeClock([100, 145]));
    const end = t.start("db");
    end();
    expect(t.header()).toBe("db;dur=45");
    expect(t.toJSON()).toEqual({ db: 45 });
  });

  it("times an async function via measure()", async () => {
    const t = createTimings(fakeClock([1000, 1120]));
    const value = await t.measure("authz", async () => "ok");
    expect(value).toBe("ok");
    expect(t.toJSON()).toEqual({ authz: 120 });
  });

  it("still records duration when the measured function throws", async () => {
    const t = createTimings(fakeClock([0, 30]));
    await expect(
      t.measure("db", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(t.toJSON()).toEqual({ db: 30 });
  });

  it("preserves insertion order and supports add() for precomputed durations", () => {
    const t = createTimings(fakeClock([0, 10]));
    t.start("auth")();
    t.add("downstream", 200, "membership");
    expect(t.phases().map((p) => p.name)).toEqual(["auth", "downstream"]);
    expect(t.header()).toBe('auth;dur=10, downstream;dur=200;desc="membership"');
  });

  it("end() is idempotent (records once)", () => {
    const t = createTimings(fakeClock([0, 5, 99]));
    const end = t.start("x");
    end();
    end();
    expect(t.phases()).toHaveLength(1);
    expect(t.toJSON()).toEqual({ x: 5 });
  });

  it("sanitizes phase names and strips quotes from descriptions (header-safe)", () => {
    const t = createTimings(fakeClock([0, 1]));
    t.add("bad name!", 1, 'has "quotes" and \\slashes');
    expect(t.header()).toBe('bad_name_;dur=1;desc="has quotes and slashes"');
  });

  it("clamps negative/non-finite durations to 0", () => {
    const t = createTimings();
    t.add("neg", -5);
    t.add("nan", Number.NaN);
    expect(t.toJSON()).toEqual({ neg: 0, nan: 0 });
  });

  it("returns an empty header when no phases recorded", () => {
    expect(createTimings().header()).toBe("");
  });

  describe("parseServerTimingDuration", () => {
    it("extracts dur for a named metric", () => {
      expect(parseServerTimingDuration("authz;dur=120, db;dur=45", "db")).toBe(45);
      expect(parseServerTimingDuration("authz;dur=120.5, db;dur=45", "authz")).toBe(120.5);
    });
    it("returns null for missing metric or header", () => {
      expect(parseServerTimingDuration("authz;dur=10", "db")).toBeNull();
      expect(parseServerTimingDuration(null, "db")).toBeNull();
      expect(parseServerTimingDuration("db", "db")).toBeNull();
    });
  });

  describe("appendServerTiming", () => {
    it("joins existing and new metrics", () => {
      expect(appendServerTiming("a;dur=1", "b;dur=2")).toBe("a;dur=1, b;dur=2");
    });
    it("handles empty sides", () => {
      expect(appendServerTiming(null, "b;dur=2")).toBe("b;dur=2");
      expect(appendServerTiming("a;dur=1", "")).toBe("a;dur=1");
      expect(appendServerTiming(null, "")).toBe("");
    });
  });

  describe("shouldEmitTimingLog (PERF14 sampling)", () => {
    it("always emits when a phase is slow, regardless of the sample roll", () => {
      // random=0.99 (would normally be sampled out at rate 0.1), but a slow phase forces emit.
      expect(shouldEmitTimingLog({ total: 1200 }, { rate: 0.1, slowMs: 1000, random: () => 0.99 })).toBe(true);
    });
    it("emits a fast request only when the sample roll is under the rate", () => {
      expect(shouldEmitTimingLog({ total: 50 }, { rate: 0.1, random: () => 0.05 })).toBe(true);
      expect(shouldEmitTimingLog({ total: 50 }, { rate: 0.1, random: () => 0.5 })).toBe(false);
    });
    it("respects a custom slow threshold", () => {
      expect(shouldEmitTimingLog({ edge_ratelimit: 300 }, { rate: 0, slowMs: 200, random: () => 0.99 })).toBe(true);
      expect(shouldEmitTimingLog({ edge_ratelimit: 100 }, { rate: 0, slowMs: 200, random: () => 0.99 })).toBe(false);
    });
  });
});
