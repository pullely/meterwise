import type { SqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";

export interface AuditActor {
  type: string;
  id: string;
}

export interface AuditInput {
  type: "ledger.budget.set" | "ledger.budget.removed" | "ledger.alert.raised";
  orgId: string;
  actor: AuditActor;
  requestId: string;
  subjectKind: "ledger_budget" | "ledger_alert";
  subjectId: string;
  subjectName: string;
  description: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/**
 * Append a domain event and its audit row as two plain statements (design §8):
 * `appendEvent` (portable SQL) and an `INSERT … SELECT` copying the audit row
 * from it, which SQLite, so D1, runs. Deliberately not the baseline's
 * one-statement `appendEventWithAudit`, whose Postgres CTE form D1 rejects
 * (runbook trap 16).
 *
 * Best-effort: the write it describes has already committed (D1 has no
 * interactive transactions), so a failure is logged as a fixed-shape line and
 * swallowed rather than turned into a 5xx that would invite a retry of a
 * write that succeeded. Payloads carry ids, tenants and amounts only.
 */
export async function recordAudit(executor: SqlExecutor, input: AuditInput): Promise<boolean> {
  const eventId = crypto.randomUUID();
  try {
    const appended = await createEventsRepository(executor).appendEvent({
      id: eventId,
      type: input.type,
      version: 1,
      source: "ledger-worker",
      occurredAt: new Date(input.occurredAt),
      actorType: input.actor.type,
      actorId: input.actor.id,
      orgId: input.orgId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      subjectName: input.subjectName,
      requestId: input.requestId,
      payload: input.payload,
    });
    if (!appended.ok) {
      warn("ledger event append failed", input);
      return false;
    }
    await executor.execute(
      `INSERT INTO events_audit_entries
         (id, event_id, org_id, project_id, environment_id, actor_type, actor_id,
          event_type, event_version, source, subject_kind, subject_id, subject_name,
          category, description, occurred_at, request_id, correlation_id, payload, redact_paths)
       SELECT $2, id, org_id, project_id, environment_id, actor_type, actor_id,
              type, version, source, subject_kind, subject_id, subject_name,
              'ledger', $3, occurred_at, request_id, correlation_id, payload, redact_paths
         FROM events_event_log WHERE id = $1`,
      [eventId, crypto.randomUUID(), input.description],
    );
    return true;
  } catch {
    warn("ledger audit append threw", input);
    return false;
  }
}

function warn(msg: string, input: AuditInput): void {
  // eslint-disable-next-line no-console -- one fixed-shape line; no payload, no error text
  console.warn(JSON.stringify({ level: "warn", msg, type: input.type, requestId: input.requestId }));
}
