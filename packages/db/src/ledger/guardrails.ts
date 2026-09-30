import type { SqlExecutor, SqlRow } from "../d1/executor.js";

// MW2 — budgets, month-to-date spend rollups and alerts (design §1.4, §6).
// Every write reads its outcome from RETURNING, never from rowCount: the D1
// executor reports rows.length, so a write without RETURNING always says 0
// (runbook trap 22).

type Row = SqlRow & Record<string, unknown>;

export interface Budget {
  id: string;
  orgId: string;
  /** A tenant, or "*" for the org-wide default. */
  tenant: string;
  softLimitNanoUsd: number | null;
  hardLimitNanoUsd: number | null;
  /** requested model → cheaper model, both lower-cased. */
  downgrade: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SpendRollup {
  orgId: string;
  tenant: string;
  period: string;
  costNanoUsd: number;
  events: number;
  updatedAt: string;
}

export type AlertKind = "runaway_loop" | "abusive_user" | "budget_soft" | "budget_hard";
export type AlertStatus = "claimed" | "notified" | "no_recipients";

export interface LedgerAlert {
  id: string;
  orgId: string;
  kind: AlertKind;
  subject: string;
  windowStart: string;
  windowEnd: string;
  detail: Record<string, unknown>;
  status: AlertStatus;
  recipients: number;
  accepted: number;
  createdAt: string;
  notifiedAt: string | null;
}

export interface RunawayCandidate {
  orgId: string;
  tenant: string;
  /** "" when the events carry no feature. */
  feature: string;
  events: number;
  firstAt: string;
}

export interface AbusiveUserCandidate {
  orgId: string;
  tenant: string;
  user: string;
  userCostNanoUsd: number;
  tenantCostNanoUsd: number;
  firstAt: string;
}

export interface BudgetCrossing {
  orgId: string;
  tenant: string;
  budgetTenant: string;
  spentNanoUsd: number;
  softLimitNanoUsd: number | null;
  hardLimitNanoUsd: number | null;
}

export interface GuardrailsRepository {
  /**
   * Add one accepted, priced event to its (org, tenant, month) rollup in ONE
   * statement: INSERT … ON CONFLICT DO UPDATE SET cost = cost + excluded.cost.
   * SQLite applies it atomically, so concurrent ingests lose no increment.
   * Returns the month-to-date total after the add.
   */
  addSpend(orgId: string, tenant: string, period: string, costNanoUsd: number, now: string, events?: number): Promise<number>;
  getSpend(orgId: string, tenant: string, period: string): Promise<SpendRollup | null>;
  /**
   * Recompute every (org, tenant) rollup of `period` from ledger_events in ONE
   * INSERT … SELECT … ON CONFLICT DO UPDATE statement, writing only rows that
   * differ. Returns how many rows it had to insert or correct (0 when the
   * ingest-time upserts were all applied).
   */
  reconcileRollups(period: string, now: string): Promise<number>;
  listSpend(orgId: string, period: string): Promise<SpendRollup[]>;

  listBudgets(orgId: string): Promise<Budget[]>;
  getBudget(orgId: string, tenant: string): Promise<Budget | null>;
  /** The tenant's own budget, else the org-wide "*" default, else null. */
  getEffectiveBudget(orgId: string, tenant: string): Promise<Budget | null>;
  /** Create or replace (org, tenant)'s budget. `created` is false when a row already existed. */
  putBudget(b: Budget): Promise<{ budget: Budget; created: boolean }>;
  /** Delete and return the removed row, or null when there was none. */
  deleteBudget(orgId: string, tenant: string): Promise<Budget | null>;

  /** Claim (org, kind, subject, window_start): the new id, or null when another tick already did. */
  claimAlert(a: Omit<LedgerAlert, "status" | "recipients" | "accepted" | "notifiedAt">): Promise<string | null>;
  finishAlert(id: string, status: Exclude<AlertStatus, "claimed">, recipients: number, accepted: number, now: string): Promise<boolean>;
  /** Give a claim back (nothing was accepted), so the next tick retries it. */
  releaseAlert(id: string): Promise<boolean>;
  listAlerts(orgId: string, limit: number): Promise<LedgerAlert[]>;

  /** (org, tenant, feature) with more than `floor` events in [fromIso, toIso). */
  runawayCandidates(fromIso: string, toIso: string, floor: number): Promise<RunawayCandidate[]>;
  /** Event counts per UTC hour ("YYYY-MM-DDTHH") for one (org, tenant, feature) in [fromIso, toIso). */
  hourlyCounts(orgId: string, tenant: string, feature: string, fromIso: string, toIso: string): Promise<Map<string, number>>;
  /** Named end-users whose priced spend in [fromIso, toIso) exceeds `minCostNanoUsd`, with their tenant's total. */
  abusiveUserCandidates(fromIso: string, toIso: string, minCostNanoUsd: number): Promise<AbusiveUserCandidate[]>;
  /** Every (org, tenant) whose `period` spend has reached its effective budget's soft or hard limit. */
  budgetCrossings(period: string): Promise<BudgetCrossing[]>;
  /** Active owners' and admins' emails (membership stores usr_<hex>, identity a UUID: runbook trap 39). */
  listAdminEmails(orgId: string): Promise<string[]>;
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapBudget(row: Row): Budget {
  const map = parseObject(row.downgrade);
  const downgrade: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) if (typeof v === "string") downgrade[k] = v;
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    tenant: row.tenant as string,
    softLimitNanoUsd: num(row.soft_limit_nanousd),
    hardLimitNanoUsd: num(row.hard_limit_nanousd),
    downgrade,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    updatedBy: (row.updated_by as string | null) ?? null,
  };
}

function mapRollup(row: Row): SpendRollup {
  return {
    orgId: row.org_id as string,
    tenant: row.tenant as string,
    period: row.period as string,
    costNanoUsd: Number(row.cost_nanousd),
    events: Number(row.events),
    updatedAt: row.updated_at as string,
  };
}

function mapAlert(row: Row): LedgerAlert {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    kind: row.kind as AlertKind,
    subject: row.subject as string,
    windowStart: row.window_start as string,
    windowEnd: row.window_end as string,
    detail: parseObject(row.detail),
    status: row.status as AlertStatus,
    recipients: Number(row.recipients),
    accepted: Number(row.accepted),
    createdAt: row.created_at as string,
    notifiedAt: (row.notified_at as string | null) ?? null,
  };
}

export function createGuardrailsRepository(executor: SqlExecutor): GuardrailsRepository {
  return {
    async addSpend(orgId, tenant, period, costNanoUsd, now, events = 1) {
      const { rows } = await executor.execute<Row>(
        `INSERT INTO ledger_spend_rollups (org_id, tenant, period, cost_nanousd, events, updated_at)
         VALUES ($1, $2, $3, $4, $6, $5)
         ON CONFLICT (org_id, tenant, period) DO UPDATE
           SET cost_nanousd = ledger_spend_rollups.cost_nanousd + excluded.cost_nanousd,
               events = ledger_spend_rollups.events + excluded.events,
               updated_at = excluded.updated_at
         RETURNING cost_nanousd`,
        [orgId, tenant, period, costNanoUsd, now, events],
      );
      return Number(rows[0]?.cost_nanousd ?? 0);
    },

    async getSpend(orgId, tenant, period) {
      const { rows } = await executor.execute<Row>(
        `SELECT * FROM ledger_spend_rollups WHERE org_id = $1 AND tenant = $2 AND period = $3`,
        [orgId, tenant, period],
      );
      return rows.length ? mapRollup(rows[0]!) : null;
    },

    async reconcileRollups(period, now) {
      const from = `${period}-01T00:00:00.000Z`;
      const y = Number(period.slice(0, 4));
      const m = Number(period.slice(5, 7));
      const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString();
      const { rows } = await executor.execute<Row>(
        `INSERT INTO ledger_spend_rollups (org_id, tenant, period, cost_nanousd, events, updated_at)
         SELECT org_id, tenant, $1, SUM(cost_nanousd), COUNT(*), $2
           FROM ledger_events
          WHERE price_status = 'priced' AND occurred_at >= $3 AND occurred_at < $4
          GROUP BY org_id, tenant
         ON CONFLICT (org_id, tenant, period) DO UPDATE
           SET cost_nanousd = excluded.cost_nanousd,
               events = excluded.events,
               updated_at = excluded.updated_at
         WHERE ledger_spend_rollups.cost_nanousd <> excluded.cost_nanousd
            OR ledger_spend_rollups.events <> excluded.events
         RETURNING org_id`,
        [period, now, from, to],
      );
      return rows.length;
    },

    async listSpend(orgId, period) {
      const { rows } = await executor.execute<Row>(
        `SELECT * FROM ledger_spend_rollups WHERE org_id = $1 AND period = $2
          ORDER BY cost_nanousd DESC, tenant LIMIT 500`,
        [orgId, period],
      );
      return rows.map(mapRollup);
    },

    async listBudgets(orgId) {
      const { rows } = await executor.execute<Row>(
        `SELECT * FROM ledger_budgets WHERE org_id = $1 ORDER BY CASE WHEN tenant = '*' THEN 0 ELSE 1 END, tenant LIMIT 500`,
        [orgId],
      );
      return rows.map(mapBudget);
    },

    async getBudget(orgId, tenant) {
      const { rows } = await executor.execute<Row>(
        `SELECT * FROM ledger_budgets WHERE org_id = $1 AND tenant = $2`,
        [orgId, tenant],
      );
      return rows.length ? mapBudget(rows[0]!) : null;
    },

    async getEffectiveBudget(orgId, tenant) {
      const { rows } = await executor.execute<Row>(
        `SELECT * FROM ledger_budgets WHERE org_id = $1 AND tenant IN ($2, '*')
          ORDER BY CASE WHEN tenant = '*' THEN 1 ELSE 0 END LIMIT 1`,
        [orgId, tenant],
      );
      return rows.length ? mapBudget(rows[0]!) : null;
    },

    async putBudget(b) {
      const { rows } = await executor.execute<Row>(
        `INSERT INTO ledger_budgets
           (id, org_id, tenant, soft_limit_nanousd, hard_limit_nanousd, downgrade, created_at, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
         ON CONFLICT (org_id, tenant) DO UPDATE
           SET soft_limit_nanousd = excluded.soft_limit_nanousd,
               hard_limit_nanousd = excluded.hard_limit_nanousd,
               downgrade = excluded.downgrade,
               updated_at = excluded.updated_at,
               updated_by = excluded.updated_by
         RETURNING *`,
        [b.id, b.orgId, b.tenant, b.softLimitNanoUsd, b.hardLimitNanoUsd, JSON.stringify(b.downgrade), b.updatedAt, b.updatedBy],
      );
      const budget = mapBudget(rows[0]!);
      return { budget, created: budget.id === b.id };
    },

    async deleteBudget(orgId, tenant) {
      const { rows } = await executor.execute<Row>(
        `DELETE FROM ledger_budgets WHERE org_id = $1 AND tenant = $2 RETURNING *`,
        [orgId, tenant],
      );
      return rows.length ? mapBudget(rows[0]!) : null;
    },

    async claimAlert(a) {
      const { rows } = await executor.execute<Row>(
        `INSERT INTO ledger_alerts (id, org_id, kind, subject, window_start, window_end, detail, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (org_id, kind, subject, window_start) DO NOTHING
         RETURNING id`,
        [a.id, a.orgId, a.kind, a.subject, a.windowStart, a.windowEnd, JSON.stringify(a.detail), a.createdAt],
      );
      return rows.length === 1 ? (rows[0]!.id as string) : null;
    },

    async finishAlert(id, status, recipients, accepted, now) {
      const { rows } = await executor.execute<Row>(
        `UPDATE ledger_alerts SET status = $2, recipients = $3, accepted = $4, notified_at = $5
          WHERE id = $1 RETURNING id`,
        [id, status, recipients, accepted, now],
      );
      return rows.length === 1;
    },

    async releaseAlert(id) {
      const { rows } = await executor.execute<Row>(
        `DELETE FROM ledger_alerts WHERE id = $1 AND status = 'claimed' RETURNING id`,
        [id],
      );
      return rows.length === 1;
    },

    async listAlerts(orgId, limit) {
      // rowid is the final tiebreak: two alerts claimed in one millisecond
      // have random UUIDs, and ORDER BY created_at, id alone is not stable
      // (runbook trap 48).
      const { rows } = await executor.execute<Row>(
        `SELECT * FROM ledger_alerts WHERE org_id = $1 ORDER BY created_at DESC, rowid DESC LIMIT $2`,
        [orgId, limit],
      );
      return rows.map(mapAlert);
    },

    async runawayCandidates(fromIso, toIso, floor) {
      const { rows } = await executor.execute<Row>(
        `SELECT org_id, tenant, COALESCE(feature, '') AS feature, COUNT(*) AS events, MIN(occurred_at) AS first_at
           FROM ledger_events
          WHERE occurred_at >= $1 AND occurred_at < $2
          GROUP BY org_id, tenant, COALESCE(feature, '')
         HAVING COUNT(*) > $3
          ORDER BY org_id, tenant, feature
          LIMIT 1000`,
        [fromIso, toIso, floor],
      );
      return rows.map((r) => ({
        orgId: r.org_id as string,
        tenant: r.tenant as string,
        feature: r.feature as string,
        events: Number(r.events),
        firstAt: r.first_at as string,
      }));
    },

    async hourlyCounts(orgId, tenant, feature, fromIso, toIso) {
      const { rows } = await executor.execute<Row>(
        `SELECT substr(occurred_at, 1, 13) AS hour, COUNT(*) AS n
           FROM ledger_events
          WHERE org_id = $1 AND tenant = $2 AND COALESCE(feature, '') = $3
            AND occurred_at >= $4 AND occurred_at < $5
          GROUP BY substr(occurred_at, 1, 13)`,
        [orgId, tenant, feature, fromIso, toIso],
      );
      return new Map(rows.map((r) => [r.hour as string, Number(r.n)]));
    },

    async abusiveUserCandidates(fromIso, toIso, minCostNanoUsd) {
      const { rows } = await executor.execute<Row>(
        `WITH per_user AS (
           SELECT org_id, tenant, end_user, SUM(cost_nanousd) AS cost, MIN(occurred_at) AS first_at
             FROM ledger_events
            WHERE occurred_at >= $1 AND occurred_at < $2 AND price_status = 'priced' AND end_user IS NOT NULL
            GROUP BY org_id, tenant, end_user
           HAVING SUM(cost_nanousd) > $3
         ),
         per_tenant AS (
           SELECT org_id, tenant, SUM(cost_nanousd) AS cost
             FROM ledger_events
            WHERE occurred_at >= $1 AND occurred_at < $2 AND price_status = 'priced'
            GROUP BY org_id, tenant
         )
         SELECT u.org_id, u.tenant, u.end_user, u.cost AS user_cost, t.cost AS tenant_cost, u.first_at
           FROM per_user u JOIN per_tenant t ON t.org_id = u.org_id AND t.tenant = u.tenant
          ORDER BY u.org_id, u.tenant, u.end_user
          LIMIT 1000`,
        [fromIso, toIso, minCostNanoUsd],
      );
      return rows.map((r) => ({
        orgId: r.org_id as string,
        tenant: r.tenant as string,
        user: r.end_user as string,
        userCostNanoUsd: Number(r.user_cost),
        tenantCostNanoUsd: Number(r.tenant_cost),
        firstAt: r.first_at as string,
      }));
    },

    async budgetCrossings(period) {
      // The effective budget: the tenant's own row, else the org's "*" row.
      const { rows } = await executor.execute<Row>(
        `SELECT r.org_id, r.tenant, b.tenant AS budget_tenant, r.cost_nanousd,
                b.soft_limit_nanousd, b.hard_limit_nanousd
           FROM ledger_spend_rollups r
           JOIN ledger_budgets b
             ON b.org_id = r.org_id
            AND b.tenant = COALESCE(
                  (SELECT own.tenant FROM ledger_budgets own WHERE own.org_id = r.org_id AND own.tenant = r.tenant),
                  '*')
          WHERE r.period = $1
            AND ((b.soft_limit_nanousd IS NOT NULL AND r.cost_nanousd >= b.soft_limit_nanousd)
              OR (b.hard_limit_nanousd IS NOT NULL AND r.cost_nanousd >= b.hard_limit_nanousd))
          ORDER BY r.org_id, r.tenant
          LIMIT 1000`,
        [period],
      );
      return rows.map((r) => ({
        orgId: r.org_id as string,
        tenant: r.tenant as string,
        budgetTenant: r.budget_tenant as string,
        spentNanoUsd: Number(r.cost_nanousd),
        softLimitNanoUsd: num(r.soft_limit_nanousd),
        hardLimitNanoUsd: num(r.hard_limit_nanousd),
      }));
    },

    async listAdminEmails(orgId) {
      const { rows } = await executor.execute<Row>(
        `SELECT DISTINCT u.email_lower AS email
           FROM membership_role_assignments ra
           JOIN membership_organization_members m
             ON m.org_id = ra.org_id AND m.subject_id = ra.subject_id AND m.status = 'active'
           -- Membership stores the PUBLIC subject id ("usr_<32 hex>") on D1,
           -- identity_users the UUID: match either form (runbook trap 39).
           JOIN identity_users u
             ON u.id IN (
                  ra.subject_id,
                  lower(substr(ra.subject_id, 5, 8) || '-' || substr(ra.subject_id, 13, 4) || '-' ||
                        substr(ra.subject_id, 17, 4) || '-' || substr(ra.subject_id, 21, 4) || '-' ||
                        substr(ra.subject_id, 25, 12))
                )
            AND u.status = 'active'
          WHERE ra.org_id = $1 AND ra.role IN ('owner', 'admin') AND ra.scope_kind = 'organization'
            AND ra.revoked_at IS NULL
          ORDER BY email
          LIMIT 50`,
        [orgId],
      );
      return rows.map((r) => r.email as string).filter((e) => typeof e === "string" && e.length > 0);
    },
  };
}
