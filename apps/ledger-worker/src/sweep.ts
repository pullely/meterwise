import { budgetPeriod, formatUsd, type AlertKind } from "@saas/contracts/ledger";
import type { EnqueueNotificationRequest } from "@saas/contracts/notifications";
import type { SqlExecutor } from "@saas/db/d1";
import type { GuardrailsRepository } from "@saas/db/ledger";
import { buildIdempotencyKey, type EnqueueNotificationResult } from "@saas/notifications-client";
import { recordAudit } from "./audit.js";
import { alertPublicId, orgPublicId } from "./ids.js";

// MW2 — the */15 anomaly cron (design §6). One tick:
//   1. reconciles the month-to-date rollups from ledger_events (self-heals a
//      rollup upsert lost after its event committed);
//   2. finds runaway loops and abusive end-users over the trailing hour;
//   3. finds tenants whose spend reached their soft or hard budget;
//   4. claims each alert ONCE (INSERT … ON CONFLICT DO NOTHING RETURNING on
//      (org, kind, subject, window_start)) and only then emails the org's
//      owners and admins through notifications-worker.
// A burst is inside the trailing hour for four consecutive ticks; each alert's
// window_start is the UTC hour of the burst's first event, so every one of
// those ticks derives the same key and only the first claims it.

export const TICK_MS = 15 * 60 * 1000;
export const WINDOW_MS = 60 * 60 * 1000;
export const BASELINE_HOURS = 7 * 24;
/** Runaway loop: over 10 × the 7-day hourly median and over this floor (design §6). */
export const RUNAWAY_FLOOR = 200;
export const RUNAWAY_FACTOR = 10;
/** Abusive end-user: over half the tenant's spend and over $5 in the hour. */
export const ABUSIVE_MIN_NANOUSD = 5_000_000_000;

export const TEMPLATE_ANOMALY = "ledger.anomaly.detected";
export const TEMPLATE_BUDGET = "ledger.budget.crossed";

export type Enqueue = (request: EnqueueNotificationRequest, requestId: string) => Promise<EnqueueNotificationResult>;

export interface SweepDeps {
  guard: GuardrailsRepository;
  executor: SqlExecutor;
  /** Absent without a NOTIFICATIONS_WORKER binding: nothing is claimed, the next tick retries. */
  enqueue: Enqueue | null;
}

export interface SweepReport {
  windowStart: string;
  windowEnd: string;
  reconciled: number;
  candidates: number;
  raised: number;
  alreadyRaised: number;
  deferred: number;
  emailsAccepted: number;
}

interface Found {
  orgId: string;
  kind: AlertKind;
  subject: string;
  windowStart: string;
  detail: Record<string, string | number | null>;
  templateKey: string;
  templateData: Record<string, string | number | boolean | null>;
}

/**
 * An alert's subject, the claim key's third part: a JSON array of the
 * customer's attribution strings, [tenant] or [tenant, feature|user]. (Not a
 * NUL-joined string: SQLite hands TEXT back through C strings and a NUL
 * truncates it.)
 */
export function alertSubject(...parts: string[]): string {
  return JSON.stringify(parts);
}

export function parseAlertSubject(subject: string): string[] {
  try {
    const v = JSON.parse(subject) as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  } catch {
    // fall through
  }
  return [subject];
}

/** The UTC hour a timestamp falls in, as an ISO instant. */
export function hourOf(iso: string): string {
  return `${iso.slice(0, 13)}:00:00.000Z`;
}

/** The tick this run belongs to: now, floored to the quarter hour. */
export function tickOf(now: Date): Date {
  return new Date(Math.floor(now.getTime() / TICK_MS) * TICK_MS);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Hourly counts for the BASELINE_HOURS before `beforeIso`, with every empty hour counted as 0. */
function baselineSeries(counts: Map<string, number>, beforeIso: string): number[] {
  const start = Date.parse(hourOf(beforeIso));
  const out: number[] = [];
  for (let h = 1; h <= BASELINE_HOURS; h++) {
    const key = new Date(start - h * 3_600_000).toISOString().slice(0, 13);
    out.push(counts.get(key) ?? 0);
  }
  return out;
}

async function findAnomalies(guard: GuardrailsRepository, windowStart: string, windowEnd: string): Promise<Found[]> {
  const found: Found[] = [];
  const baselineFrom = new Date(Date.parse(hourOf(windowStart)) - BASELINE_HOURS * 3_600_000).toISOString();
  for (const c of await guard.runawayCandidates(windowStart, windowEnd, RUNAWAY_FLOOR)) {
    const counts = await guard.hourlyCounts(c.orgId, c.tenant, c.feature, baselineFrom, hourOf(windowStart));
    const m = median(baselineSeries(counts, windowStart));
    if (c.events <= RUNAWAY_FACTOR * m) continue;
    const detail = { events: c.events, baselineMedian: m, windowStart, windowEnd };
    found.push({
      orgId: c.orgId,
      kind: "runaway_loop",
      subject: alertSubject(c.tenant, c.feature),
      windowStart: hourOf(c.firstAt),
      detail,
      templateKey: TEMPLATE_ANOMALY,
      templateData: { kind: "runaway_loop", tenant: c.tenant, feature: c.feature || null, ...detail },
    });
  }
  for (const u of await guard.abusiveUserCandidates(windowStart, windowEnd, ABUSIVE_MIN_NANOUSD)) {
    if (u.userCostNanoUsd * 2 <= u.tenantCostNanoUsd) continue;
    const detail = {
      userCostNanoUsd: u.userCostNanoUsd,
      tenantCostNanoUsd: u.tenantCostNanoUsd,
      userCostUsd: formatUsd(u.userCostNanoUsd),
      tenantCostUsd: formatUsd(u.tenantCostNanoUsd),
      windowStart,
      windowEnd,
    };
    found.push({
      orgId: u.orgId,
      kind: "abusive_user",
      subject: alertSubject(u.tenant, u.user),
      windowStart: hourOf(u.firstAt),
      detail,
      templateKey: TEMPLATE_ANOMALY,
      templateData: { kind: "abusive_user", tenant: u.tenant, user: u.user, ...detail },
    });
  }
  return found;
}

async function findBudgetCrossings(guard: GuardrailsRepository, period: string): Promise<Found[]> {
  const found: Found[] = [];
  for (const x of await guard.budgetCrossings(period)) {
    const levels: ["soft" | "hard", number | null][] = [
      ["soft", x.softLimitNanoUsd],
      ["hard", x.hardLimitNanoUsd],
    ];
    for (const [level, limit] of levels) {
      if (limit === null || x.spentNanoUsd < limit) continue;
      const detail = {
        level,
        period,
        budgetTenant: x.budgetTenant,
        spentNanoUsd: x.spentNanoUsd,
        limitNanoUsd: limit,
        spentUsd: formatUsd(x.spentNanoUsd),
        limitUsd: formatUsd(limit),
      };
      found.push({
        orgId: x.orgId,
        kind: level === "hard" ? "budget_hard" : "budget_soft",
        subject: alertSubject(x.tenant),
        windowStart: `${period}-01T00:00:00.000Z`,
        detail,
        templateKey: TEMPLATE_BUDGET,
        templateData: { tenant: x.tenant, ...detail },
      });
    }
  }
  return found;
}

/**
 * One tick. `now` is the scheduled time; the window is the trailing hour
 * ending at the quarter-hour tick.
 */
export async function runSweep(deps: SweepDeps, now: Date, requestId = `sweep_${tickOf(now).toISOString()}`): Promise<SweepReport> {
  const tick = tickOf(now);
  const windowEnd = tick.toISOString();
  const windowStart = new Date(tick.getTime() - WINDOW_MS).toISOString();
  const nowIso = now.toISOString();
  const report: SweepReport = {
    windowStart,
    windowEnd,
    reconciled: 0,
    candidates: 0,
    raised: 0,
    alreadyRaised: 0,
    deferred: 0,
    emailsAccepted: 0,
  };

  const period = budgetPeriod(windowEnd);
  report.reconciled = await deps.guard.reconcileRollups(period, nowIso);

  const found = [...(await findAnomalies(deps.guard, windowStart, windowEnd)), ...(await findBudgetCrossings(deps.guard, period))];
  report.candidates = found.length;
  if (!deps.enqueue) {
    report.deferred = found.length;
    return report;
  }

  const admins = new Map<string, string[]>();
  for (const f of found) {
    const id = await deps.guard.claimAlert({
      id: crypto.randomUUID(),
      orgId: f.orgId,
      kind: f.kind,
      subject: f.subject,
      windowStart: f.windowStart,
      windowEnd,
      detail: f.detail,
      createdAt: nowIso,
    });
    if (id === null) {
      report.alreadyRaised++;
      continue;
    }
    let recipients = admins.get(f.orgId);
    if (!recipients) {
      recipients = await deps.guard.listAdminEmails(f.orgId);
      admins.set(f.orgId, recipients);
    }
    if (recipients.length === 0) {
      await deps.guard.finishAlert(id, "no_recipients", 0, 0, nowIso);
      await audit(deps.executor, f, id, requestId, nowIso, 0, 0);
      report.raised++;
      continue;
    }
    let accepted = 0;
    for (const to of recipients) {
      let result: EnqueueNotificationResult;
      try {
        result = await deps.enqueue(
          {
            orgId: orgPublicId(f.orgId),
            category: "product",
            templateKey: f.templateKey,
            templateData: f.templateData,
            recipient: { channel: "email", address: to },
            idempotencyKey: buildIdempotencyKey(f.templateKey, alertPublicId(id), to),
            correlationId: alertPublicId(id),
          },
          requestId,
        );
      } catch {
        result = { ok: false, reason: "network_error" };
      }
      if (result.ok) accepted++;
    }
    if (accepted === 0) {
      // Nothing landed: give the claim back so the next tick retries; the
      // notification idempotency key makes that retry safe.
      await deps.guard.releaseAlert(id);
      report.deferred++;
      continue;
    }
    await deps.guard.finishAlert(id, "notified", recipients.length, accepted, nowIso);
    await audit(deps.executor, f, id, requestId, nowIso, recipients.length, accepted);
    report.raised++;
    report.emailsAccepted += accepted;
  }
  return report;
}

function audit(executor: SqlExecutor, f: Found, id: string, requestId: string, now: string, recipients: number, accepted: number): Promise<boolean> {
  const [tenant] = parseAlertSubject(f.subject);
  return recordAudit(executor, {
    type: "ledger.alert.raised",
    orgId: f.orgId,
    actor: { type: "system", id: "ledger-worker" },
    requestId,
    subjectKind: "ledger_alert",
    subjectId: id,
    subjectName: `${f.kind} — ${tenant}`,
    description: `Raised a ${f.kind.replace("_", " ")} alert for tenant "${tenant}" and emailed ${accepted} of ${recipients} owners and admins`,
    payload: { alertId: alertPublicId(id), kind: f.kind, tenant, windowStart: f.windowStart, recipients, accepted, ...f.detail },
    occurredAt: now,
  });
}
