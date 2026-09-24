import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import type {
  CostAggregateRow,
  CostGroupBy,
  LedgerEvent,
  LedgerRepository,
  ListEventsFilter,
  ModelPrice,
  NewLedgerEvent,
  PriceVersion,
} from "./types.js";

type Row = SqlRow & Record<string, unknown>;

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapVersion(row: Row): PriceVersion {
  return {
    version: row.version as string,
    effectiveFrom: row.effective_from as string,
    publishedOn: row.published_on as string,
    description: row.description as string,
  };
}

function mapPrice(row: Row): ModelPrice {
  return {
    version: row.version as string,
    provider: row.provider as string,
    model: row.model as string,
    displayName: row.display_name as string,
    inputMicrosPerMtok: Number(row.input_micros_per_mtok),
    outputMicrosPerMtok: Number(row.output_micros_per_mtok),
    sourceUrl: row.source_url as string,
    checkedOn: row.checked_on as string,
  };
}

function mapEvent(row: Row): LedgerEvent {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    eventKey: row.event_key as string,
    fingerprint: row.fingerprint as string,
    tenant: row.tenant as string,
    feature: str(row.feature),
    endUser: str(row.end_user),
    provider: row.provider as string,
    model: row.model as string,
    pricedModel: str(row.priced_model),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    latencyMs: num(row.latency_ms),
    occurredAt: row.occurred_at as string,
    receivedAt: row.received_at as string,
    priceStatus: row.price_status as LedgerEvent["priceStatus"],
    priceVersion: str(row.price_version),
    inputPriceMicros: num(row.input_price_micros),
    outputPriceMicros: num(row.output_price_micros),
    costNanoUsd: num(row.cost_nanousd),
    source: row.source as LedgerEvent["source"],
    recordedBy: str(row.recorded_by),
  };
}

/** The GROUP BY column for each dimension: a fixed map, never caller text in SQL. */
const GROUP_COLUMN: Record<CostGroupBy, string> = {
  tenant: "tenant",
  feature: "feature",
  user: "end_user",
  provider: "provider",
  model: "model",
};

export function createLedgerRepository(executor: SqlExecutor): LedgerRepository {
  return {
    async listPriceVersions() {
      const { rows } = await executor.execute<Row>(
        `SELECT version, effective_from, published_on, description
           FROM ledger_price_versions ORDER BY effective_from DESC`,
      );
      return rows.map(mapVersion);
    },

    async listModelPrices(version) {
      const { rows } = await executor.execute<Row>(
        `SELECT version, provider, model, display_name, input_micros_per_mtok, output_micros_per_mtok,
                source_url, checked_on
           FROM ledger_model_prices WHERE version = $1 ORDER BY provider, model`,
        [version],
      );
      return rows.map(mapPrice);
    },

    async claimEvent(e: NewLedgerEvent) {
      const { rows } = await executor.execute<Row>(
        `INSERT INTO ledger_events
           (id, org_id, event_key, fingerprint, tenant, feature, end_user, provider, model, priced_model,
            input_tokens, output_tokens, latency_ms, occurred_at, received_at, price_status, price_version,
            input_price_micros, output_price_micros, cost_nanousd, source, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         ON CONFLICT (org_id, event_key) DO NOTHING
         RETURNING id`,
        [
          e.id,
          e.orgId,
          e.eventKey,
          e.fingerprint,
          e.tenant,
          e.feature,
          e.endUser,
          e.provider,
          e.model,
          e.pricedModel,
          e.inputTokens,
          e.outputTokens,
          e.latencyMs,
          e.occurredAt,
          e.receivedAt,
          e.priceStatus,
          e.priceVersion,
          e.inputPriceMicros,
          e.outputPriceMicros,
          e.costNanoUsd,
          e.source,
          e.recordedBy,
        ],
      );
      return rows.length === 1 ? (rows[0]!.id as string) : null;
    },

    async getEventByKey(orgId, eventKey) {
      const { rows } = await executor.execute<Row>(
        `SELECT * FROM ledger_events WHERE org_id = $1 AND event_key = $2`,
        [orgId, eventKey],
      );
      return rows.length ? mapEvent(rows[0]!) : null;
    },

    async listEvents(orgId, f: ListEventsFilter) {
      const where = ["org_id = $1"];
      const params: unknown[] = [orgId];
      const add = (sql: string, value: unknown): void => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (f.tenant !== undefined) add("tenant = ?", f.tenant);
      if (f.feature !== undefined) add("feature = ?", f.feature);
      if (f.model !== undefined) add("model = ?", f.model);
      if (f.before !== undefined) {
        params.push(f.before.at, f.before.id);
        where.push(`(received_at < $${params.length - 1} OR (received_at = $${params.length - 1} AND id < $${params.length}))`);
      }
      params.push(f.limit);
      const { rows } = await executor.execute<Row>(
        `SELECT * FROM ledger_events WHERE ${where.join(" AND ")}
          ORDER BY received_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(mapEvent);
    },

    async aggregateCosts(orgId, by, fromIso, toIso, tenant) {
      const col = GROUP_COLUMN[by];
      const params: unknown[] = [orgId, fromIso, toIso];
      let tenantSql = "";
      if (tenant !== undefined) {
        params.push(tenant);
        tenantSql = ` AND tenant = $${params.length}`;
      }
      const providerSelect = by === "model" ? "provider" : "NULL";
      const groupBy = by === "model" ? "provider, model" : col;
      const { rows } = await executor.execute<Row>(
        `SELECT ${col} AS k, ${providerSelect} AS p,
                COUNT(*) AS events,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_nanousd), 0) AS cost,
                SUM(CASE WHEN price_status = 'priced' THEN 0 ELSE 1 END) AS unpriced,
                AVG(latency_ms) AS avg_latency
           FROM ledger_events
          WHERE org_id = $1 AND occurred_at >= $2 AND occurred_at < $3${tenantSql}
          GROUP BY ${groupBy}
          ORDER BY cost DESC, events DESC, k
          LIMIT 500`,
        params,
      );
      return rows.map(
        (r): CostAggregateRow => ({
          key: str(r.k),
          provider: str(r.p),
          events: Number(r.events),
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          costNanoUsd: Number(r.cost),
          unpricedEvents: Number(r.unpriced),
          avgLatencyMs: r.avg_latency === null || r.avg_latency === undefined ? null : Math.round(Number(r.avg_latency)),
        }),
      );
    },

    async priceVersionsUsed(orgId, fromIso, toIso, tenant) {
      const params: unknown[] = [orgId, fromIso, toIso];
      let tenantSql = "";
      if (tenant !== undefined) {
        params.push(tenant);
        tenantSql = ` AND tenant = $${params.length}`;
      }
      const { rows } = await executor.execute<Row>(
        `SELECT DISTINCT price_version AS v FROM ledger_events
          WHERE org_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND price_version IS NOT NULL${tenantSql}
          ORDER BY v`,
        params,
      );
      return rows.map((r) => r.v as string);
    },
  };
}
