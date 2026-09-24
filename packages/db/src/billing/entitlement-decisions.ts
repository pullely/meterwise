import type { SqlExecutor } from "../d1/executor.js";
import type { BillingResult } from "./types.js";

// ---------------------------------------------------------------------------
// Entitlement-decision observability (B9)
//
// A narrow, counts-only repository over billing_entitlement_decision_observations
// (migration 150). Owned by the billing bounded context. Two operations:
//
//   * recordDecisionObservation — append one secret-free observation per
//     entitlement decision (best-effort; the billing-worker swallows failures so
//     a recording problem never alters the entitlement response).
//   * aggregateDecisions       — narrow time-windowed GROUP BY for the admin
//     support read: counts per (entitlementKey, outcome, denialReason).
//
// This module deliberately does NOT extend the broad BillingRepository surface:
// the observation concern is separable, kept narrow, and never exposes value
// fields (limit values, subscription IDs, sources, payloads, secrets).
// ---------------------------------------------------------------------------

export type EntitlementDecisionOutcome = "allowed" | "denied";

// Mirrors the frozen CheckBillingEntitlementResponse denial reason vocabulary.
export type EntitlementDenialReason = "not_configured" | "disabled";

export interface RecordDecisionObservationInput {
  id: string;
  orgId: string;
  entitlementKey: string;
  outcome: EntitlementDecisionOutcome;
  // Required iff outcome === "denied"; must be null/absent when allowed.
  denialReason?: EntitlementDenialReason | null;
  occurredAt: Date;
}

export interface DecisionAggregateQuery {
  // Inclusive lower bound of the observation window (decisions at/after this).
  since: Date;
  // Optional exclusive upper bound (decisions strictly before this). Defaults
  // to "now" semantics at the DB if omitted (no upper bound clause).
  until?: Date | null;
  // Defensive cap on the number of distinct (key, outcome, reason) groups
  // returned. Bounds the result set; aggregation never streams raw rows.
  maxGroups: number;
}

// One aggregated bucket: a count of decisions for a (key, outcome, reason)
// tuple over the queried window. `denialReason` is null for allowed buckets.
export interface DecisionAggregateBucket {
  entitlementKey: string;
  outcome: EntitlementDecisionOutcome;
  denialReason: EntitlementDenialReason | null;
  count: number;
}

export interface EntitlementDecisionRepository {
  recordDecisionObservation(
    input: RecordDecisionObservationInput,
  ): Promise<BillingResult<void>>;

  aggregateDecisions(
    orgId: string,
    query: DecisionAggregateQuery,
  ): Promise<BillingResult<DecisionAggregateBucket[]>>;
}

function safeError(message: string): BillingResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

export function createEntitlementDecisionRepository(
  executor: SqlExecutor,
): EntitlementDecisionRepository {
  return {
    async recordDecisionObservation(
      input: RecordDecisionObservationInput,
    ): Promise<BillingResult<void>> {
      try {
        const denialReason =
          input.outcome === "denied" ? (input.denialReason ?? null) : null;
        await executor.execute(
          `INSERT INTO billing_entitlement_decision_observations (
             id, org_id, entitlement_key, outcome, denial_reason, occurred_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6
           )
           ON CONFLICT (id) DO NOTHING`,
          [
            input.id,
            input.orgId,
            input.entitlementKey,
            input.outcome,
            denialReason,
            input.occurredAt.toISOString(),
          ],
        );
        return { ok: true, value: undefined };
      } catch {
        return safeError("Failed to record entitlement-decision observation");
      }
    },

    async aggregateDecisions(
      orgId: string,
      query: DecisionAggregateQuery,
    ): Promise<BillingResult<DecisionAggregateBucket[]>> {
      try {
        const params: unknown[] = [orgId, query.since.toISOString()];
        let upperClause = "";
        if (query.until) {
          params.push(query.until.toISOString());
          upperClause = ` AND occurred_at < $${params.length}`;
        }
        params.push(query.maxGroups);
        const limitParam = `$${params.length}`;

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT entitlement_key, outcome, denial_reason, count(*) AS decision_count
             FROM billing_entitlement_decision_observations
            WHERE org_id = $1
              AND occurred_at >= $2${upperClause}
            GROUP BY entitlement_key, outcome, denial_reason
            ORDER BY decision_count DESC, entitlement_key ASC, outcome ASC
            LIMIT ${limitParam}`,
          params,
        );

        const buckets = result.rows.map((row) => ({
          entitlementKey: row.entitlement_key as string,
          outcome: row.outcome as EntitlementDecisionOutcome,
          denialReason: (row.denial_reason as EntitlementDenialReason | null) ?? null,
          count: Number(row.decision_count ?? 0),
        }));
        return { ok: true, value: buckets };
      } catch {
        return safeError("Failed to aggregate entitlement-decision observations");
      }
    },
  };
}
