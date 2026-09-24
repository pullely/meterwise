import type { Env } from "./env.js";
import type { EventsRepository } from "@saas/db/events";
import type { SupportActor } from "./support-auth.js";
import { createEventsRepository } from "@saas/db/events";
import type { SqlExecutor } from "@saas/db/d1";

// Shared event-emit seam for the admin-worker. Mirrors the events-audit pattern
// used by peer workers (EventsRepository.appendEventWithAudit) — does NOT fork a
// new publish mechanism. Every support event lands in events_event_log with a
// matching events_audit_entries projection, in the same write.

export interface SupportEventInput {
  type: "support.action_recorded" | "support.access_denied";
  actor: SupportActor;
  orgId: string;
  subjectKind: string;
  subjectId: string;
  requestId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  auditDescription: string;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export type AppendEventWithAudit = Pick<EventsRepository, "appendEventWithAudit">["appendEventWithAudit"];

// Append a support event + its audit projection through the given events repo.
// Returns false if the underlying append failed (caller decides whether to roll
// back). `genId` is injectable for deterministic tests.
export async function appendSupportEvent(
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit">,
  input: SupportEventInput,
  genId: () => string = () => randomHex(16),
): Promise<boolean> {
  const result = await eventsRepo.appendEventWithAudit({
    event: {
      id: genId(),
      type: input.type,
      version: 1,
      source: "admin-worker",
      occurredAt: input.occurredAt,
      actorType: input.actor.subjectType,
      actorId: input.actor.subjectId,
      orgId: input.orgId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      requestId: input.requestId,
      payload: input.payload,
    },
    audit: {
      id: genId(),
      category: "support",
      description: input.auditDescription,
    },
  });
  return result.ok;
}

// Build an events repository bound to a (possibly transactional) executor.
export function eventsRepoFor(executor: SqlExecutor): Pick<EventsRepository, "appendEventWithAudit"> {
  return createEventsRepository(executor);
}

export function isDbConfigured(env: Env): boolean {
  return Boolean(env.PLATFORM_DB);
}
