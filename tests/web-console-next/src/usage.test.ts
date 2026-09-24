import {
  buildUsageQuery,
  canQueryUsage,
  sortRollups,
  usageBarPercents,
  formatQuantity,
  formatBucket,
  buildViolationsQuery,
  appendViolationsPage,
  hasMoreViolations,
  isViolationOpen,
  formatPeriod,
  overagePercent,
  EMPTY_VIOLATIONS,
  DEFAULT_USAGE_FORM,
} from "@web-console-next/components/usage/usage";
import type { PublicUsageRollup, PublicQuotaViolation } from "@saas/contracts/metering";

const rollup = (over: Partial<PublicUsageRollup>): PublicUsageRollup => ({
  id: "rol_1",
  orgId: "org_1",
  projectId: null,
  environmentId: null,
  metric: "api_requests",
  bucketType: "day",
  bucketStart: "2026-06-01T00:00:00.000Z",
  quantity: 10,
  recordCount: 2,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  ...over,
});

const violation = (over: Partial<PublicQuotaViolation>): PublicQuotaViolation => ({
  id: "qv_1",
  orgId: "org_1",
  projectId: null,
  environmentId: null,
  resourceId: null,
  quotaId: "quo_1",
  metric: "api_requests",
  limitValue: 100,
  actualValue: 150,
  period: "month",
  enforcement: "hard",
  violatedAt: "2026-06-01T00:00:00.000Z",
  resolvedAt: null,
  metadata: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  ...over,
});

describe("canQueryUsage", () => {
  it("requires a non-blank metric", () => {
    expect(canQueryUsage(DEFAULT_USAGE_FORM)).toBe(false);
    expect(canQueryUsage({ ...DEFAULT_USAGE_FORM, metric: "  " })).toBe(false);
    expect(canQueryUsage({ ...DEFAULT_USAGE_FORM, metric: "api_requests" })).toBe(true);
  });
});

describe("buildUsageQuery", () => {
  const now = new Date("2026-06-10T00:00:00.000Z");

  it("computes the start/end window from the preset relative to now", () => {
    const q = buildUsageQuery({ metric: "api_requests", bucketType: "day", range: "7d" }, now);
    expect(q.metric).toBe("api_requests");
    expect(q.bucketType).toBe("day");
    expect(q.endTime).toBe("2026-06-10T00:00:00.000Z");
    expect(q.startTime).toBe("2026-06-03T00:00:00.000Z");
  });

  it("trims the metric and honors the hourly bucket", () => {
    const q = buildUsageQuery({ metric: "  build_minutes ", bucketType: "hour", range: "24h" }, now);
    expect(q.metric).toBe("build_minutes");
    expect(q.bucketType).toBe("hour");
    expect(q.startTime).toBe("2026-06-09T00:00:00.000Z");
  });
});

describe("sortRollups / usageBarPercents", () => {
  it("sorts oldest→newest by bucketStart", () => {
    const out = sortRollups([
      rollup({ id: "b", bucketStart: "2026-06-02T00:00:00.000Z" }),
      rollup({ id: "a", bucketStart: "2026-06-01T00:00:00.000Z" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("normalizes bars to the max quantity", () => {
    const bars = usageBarPercents([rollup({ quantity: 50 }), rollup({ quantity: 100 }), rollup({ quantity: 0 })]);
    expect(bars).toEqual([50, 100, 0]);
  });

  it("yields all-zero bars when every quantity is zero (no divide-by-zero)", () => {
    expect(usageBarPercents([rollup({ quantity: 0 }), rollup({ quantity: 0 })])).toEqual([0, 0]);
  });
});

describe("formatQuantity", () => {
  it("formats with k/M suffixes and strips trailing .0", () => {
    expect(formatQuantity(950)).toBe("950");
    expect(formatQuantity(1000)).toBe("1k");
    expect(formatQuantity(1500)).toBe("1.5k");
    expect(formatQuantity(2_000_000)).toBe("2M");
  });
  it("returns an em dash for non-finite input", () => {
    expect(formatQuantity(Number.NaN)).toBe("—");
  });
});

describe("formatBucket", () => {
  it("returns the raw value for an unparseable date", () => {
    expect(formatBucket("not-a-date", "day")).toBe("not-a-date");
  });
  it("produces a non-empty label for a valid date", () => {
    expect(formatBucket("2026-06-01T00:00:00.000Z", "day").length).toBeGreaterThan(0);
  });
});

describe("buildViolationsQuery", () => {
  it("omits metric and cursor when unset", () => {
    expect(buildViolationsQuery("")).toEqual({});
  });
  it("includes a trimmed metric and a cursor when provided", () => {
    const cur = { createdAt: "2026-06-01T00:00:00.000Z", id: "qv_9" };
    expect(buildViolationsQuery("  api_requests ", cur)).toEqual({ metric: "api_requests", cursor: cur });
  });
});

describe("appendViolationsPage", () => {
  it("replaces on reset and carries the next cursor", () => {
    const next = { createdAt: "x", id: "y" };
    const s = appendViolationsPage(EMPTY_VIOLATIONS, { violations: [violation({ id: "a" })], nextCursor: next }, true);
    expect(s.violations.map((v) => v.id)).toEqual(["a"]);
    expect(s.cursor).toBe(next);
    expect(hasMoreViolations(s)).toBe(true);
  });

  it("appends and de-dupes by id; null cursor ends pagination", () => {
    const first = appendViolationsPage(EMPTY_VIOLATIONS, { violations: [violation({ id: "a" })], nextCursor: { createdAt: "x", id: "y" } }, true);
    const second = appendViolationsPage(first, { violations: [violation({ id: "a" }), violation({ id: "b" })], nextCursor: null });
    expect(second.violations.map((v) => v.id)).toEqual(["a", "b"]);
    expect(hasMoreViolations(second)).toBe(false);
  });
});

describe("violation view helpers", () => {
  it("isViolationOpen reflects resolvedAt", () => {
    expect(isViolationOpen(violation({ resolvedAt: null }))).toBe(true);
    expect(isViolationOpen(violation({ resolvedAt: "2026-06-02T00:00:00.000Z" }))).toBe(false);
  });
  it("formatPeriod maps known periods", () => {
    expect(formatPeriod("month")).toBe("per month");
    expect(formatPeriod("billing_cycle")).toBe("per billing cycle");
  });
  it("overagePercent guards a non-positive limit", () => {
    expect(overagePercent({ actualValue: 150, limitValue: 100 })).toBe(150);
    expect(overagePercent({ actualValue: 5, limitValue: 0 })).toBeNull();
  });
});
