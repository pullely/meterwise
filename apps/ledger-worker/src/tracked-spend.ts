import type { SqlExecutor } from "@saas/db/d1";
import { createMeteringRepository } from "@saas/db/metering";

/** The baseline metering metric that carries Meterwise's tracked LLM spend (MW-J). */
export const TRACKED_SPEND_METRIC = "ledger.tracked_spend_nanousd";

/**
 * MW-J, decided in MW2: tracked spend reaches the baseline metering context
 * through the metering REPOSITORY, on the same D1 database, not through
 * metering-worker's HTTP route. The route authorizes a member (membership +
 * policy on `organization.metering.write`), and the ingesting actor is an API
 * key's service principal with the `builder` role, which does not hold it; a
 * system-actor path into metering-worker would be a new trust edge for no
 * gain, since both workers own nothing of the other's and share one database.
 *
 * One usage record per ingest request that accepted priced events: quantity
 * = the nano-USD those accepted events cost, idempotency key = the first
 * accepted event's id. An event is accepted exactly once (design §3), so the
 * spend is recorded exactly once, and a replay of the same write is a
 * metering-side conflict, not a second count. `checkQuota(org, metric)` reads
 * it against any quota definition the plan sets for the metric.
 *
 * Best-effort: the ledger row is the record. A failure here is swallowed
 * (the metering total then under-counts that request), never turned into a
 * 5xx that would make the SDK retry an ingest that succeeded.
 */
export async function reportTrackedSpend(
  executor: SqlExecutor,
  orgId: string,
  firstAcceptedEventId: string,
  costNanoUsd: number,
  now: string,
): Promise<boolean> {
  try {
    const result = await createMeteringRepository(executor).recordUsage({
      id: crypto.randomUUID(),
      orgId,
      metric: TRACKED_SPEND_METRIC,
      quantity: costNanoUsd,
      idempotencyKey: `ledger:${firstAcceptedEventId}`,
      recordedAt: new Date(now),
      metadata: { source: "ledger-worker" },
    });
    return result.ok;
  } catch {
    return false;
  }
}
