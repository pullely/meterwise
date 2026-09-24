/**
 * Pure helpers for the org-scoped Usage & quota surface (Task 0127 / U11).
 *
 * Dependency-free (no React, no `next/*`, no DOM) so query building, the time
 * preset → ISO window math, the cursor "Load more" accumulation, and the
 * display shapers can be unit-tested in isolation. The React wiring lives in
 * `app/(app)/orgs/[orgSlug]/usage/page.tsx`. All wire I/O goes through
 * `@saas/sdk` (`metering.getUsageSummary` / `listQuotaViolations`).
 *
 * API reality this surface honors: there is no "list metrics" endpoint, so the
 * usage summary requires the operator to name a metric key (we offer common
 * suggestions). Quota violations need no metric and load immediately.
 */

import type {
  GetUsageSummaryRequest,
  ListQuotaViolationsRequest,
  PublicUsageRollup,
  PublicQuotaViolation,
} from "@saas/contracts/metering";

// ---------------------------------------------------------------------------
// Usage summary query
// ---------------------------------------------------------------------------

export type BucketType = "hour" | "day";
export type RangePreset = "24h" | "7d" | "30d" | "90d";

export const RANGE_PRESETS: { value: RangePreset; label: string; hours: number }[] = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "30d", label: "Last 30 days", hours: 24 * 30 },
  { value: "90d", label: "Last 90 days", hours: 24 * 90 },
];

/** Common metric keys offered as suggestions (no list-metrics API exists). */
export const METRIC_SUGGESTIONS = [
  "api_requests",
  "build_minutes",
  "bandwidth_gb",
  "storage_gb",
  "seats",
] as const;

export interface UsageFormValues {
  metric: string;
  bucketType: BucketType;
  range: RangePreset;
}

export const DEFAULT_USAGE_FORM: UsageFormValues = {
  metric: "",
  bucketType: "day",
  range: "7d",
};

/** Trim; treat empty/whitespace-only as unset. */
function clean(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Whether a usage-summary fetch is meaningful (metric is required by the API). */
export function canQueryUsage(values: UsageFormValues): boolean {
  return clean(values.metric) !== undefined;
}

/**
 * Build the `getUsageSummary` request for a metric + bucket + relative window.
 * `now` is injectable so the window math is deterministic in tests.
 */
export function buildUsageQuery(
  values: UsageFormValues,
  now: Date = new Date(),
): GetUsageSummaryRequest {
  const preset = RANGE_PRESETS.find((p) => p.value === values.range) ?? RANGE_PRESETS[1]!;
  const end = now;
  const start = new Date(end.getTime() - preset.hours * 3600 * 1000);
  return {
    metric: clean(values.metric) ?? "",
    bucketType: values.bucketType,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

/** Sort rollups oldest→newest by bucketStart for stable chart/table rendering. */
export function sortRollups(rollups: ReadonlyArray<PublicUsageRollup>): PublicUsageRollup[] {
  return rollups.slice().sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
}

/**
 * Bar percentages (0–100) for each rollup quantity, normalized to the max in
 * the set. An all-zero set yields all-zero bars (no divide-by-zero). Used by
 * the dependency-free CSS bar chart.
 */
export function usageBarPercents(rollups: ReadonlyArray<PublicUsageRollup>): number[] {
  const max = rollups.reduce((m, r) => Math.max(m, r.quantity), 0);
  if (max <= 0) return rollups.map(() => 0);
  return rollups.map((r) => Math.round((r.quantity / max) * 100));
}

/** Compact number formatting (1.2k, 3.4M) for totals and axis labels. */
export function formatQuantity(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** Short local label for a bucket start, granularity-aware. */
export function formatBucket(value: string, bucketType: BucketType): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return bucketType === "hour"
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Quota violations (cursor-paginated)
// ---------------------------------------------------------------------------

export type ViolationCursor = { createdAt: string; id: string } | null;

export interface ViolationsState {
  violations: ReadonlyArray<PublicQuotaViolation>;
  cursor: ViolationCursor;
}

export const EMPTY_VIOLATIONS: ViolationsState = { violations: [], cursor: null };

/** Build the `listQuotaViolations` request with an optional metric filter + cursor. */
export function buildViolationsQuery(
  metricFilter: string,
  cursor?: ViolationCursor,
): ListQuotaViolationsRequest {
  const metric = clean(metricFilter);
  return {
    ...(metric !== undefined ? { metric } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** Fold a fetched violations page into the accumulated state (reset or append). */
export function appendViolationsPage(
  prev: ViolationsState,
  page: { violations: ReadonlyArray<PublicQuotaViolation>; nextCursor: ViolationCursor },
  reset = false,
): ViolationsState {
  if (reset) return { violations: page.violations.slice(), cursor: page.nextCursor };
  const seen = new Set(prev.violations.map((v) => v.id));
  const merged = prev.violations.slice();
  for (const v of page.violations) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      merged.push(v);
    }
  }
  return { violations: merged, cursor: page.nextCursor };
}

export function hasMoreViolations(state: ViolationsState): boolean {
  return state.cursor !== null;
}

/** Whether a violation is still open (unresolved). */
export function isViolationOpen(v: Pick<PublicQuotaViolation, "resolvedAt">): boolean {
  return v.resolvedAt === null;
}

/** Human period label. */
export function formatPeriod(period: PublicQuotaViolation["period"]): string {
  switch (period) {
    case "hour":
      return "per hour";
    case "day":
      return "per day";
    case "month":
      return "per month";
    case "billing_cycle":
      return "per billing cycle";
    default:
      return period;
  }
}

/** Overage ratio (actual / limit) as a percentage, guarding limit<=0. */
export function overagePercent(
  v: Pick<PublicQuotaViolation, "actualValue" | "limitValue">,
): number | null {
  if (v.limitValue <= 0) return null;
  return Math.round((v.actualValue / v.limitValue) * 100);
}
