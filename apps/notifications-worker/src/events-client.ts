import type { Env } from "./env.js";

/**
 * Audit-safe event payload as emitted on the events seam.
 *
 * Payload bodies MUST be redaction-safe — they may carry orgId, notification
 * id, category, templateKey, recipient channel/address, and bounded status
 * data. They MUST NOT carry template substitutions, magic-link codes,
 * tokens, or any raw provider response.
 */
export interface NotificationEventInput {
  type: string;
  notificationId: string;
  orgId: string;
  subjectKind: string;
  subjectId: string;
  actorType: string;
  actorId: string;
  requestId: string;
  correlationId?: string | null;
  payload: Record<string, unknown>;
  category: string;
  description: string;
  occurredAt: Date;
}

/**
 * Forward an audit-safe event to events-worker over the internal binding.
 *
 * Best-effort: failures do NOT propagate to the caller. The events seam is
 * an audit sink, not a critical path for the enqueue/send happy path; the
 * caller has already persisted the lifecycle row authoritatively.
 *
 * In environments where EVENTS_WORKER is not bound (local, tests) this
 * function is a no-op.
 */
export async function emitEvent(env: Env, input: NotificationEventInput): Promise<void> {
  if (!env.EVENTS_WORKER) return;

  const url = "https://events.internal/v1/internal/events";
  const body = {
    event: {
      id: cryptoRandomEventId(),
      type: input.type,
      version: 1,
      source: "notifications-worker",
      occurredAt: input.occurredAt.toISOString(),
      actor: { type: input.actorType, id: input.actorId },
      tenant: { orgId: input.orgId },
      subject: { kind: input.subjectKind, id: input.subjectId },
      trace: {
        requestId: input.requestId,
        correlationId: input.correlationId ?? null,
      },
      payload: input.payload,
    },
    audit: {
      category: "notifications",
      description: input.description,
    },
  };

  try {
    await env.EVENTS_WORKER.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": input.requestId,
        "x-actor-subject-id": input.actorId,
        "x-actor-subject-type": input.actorType,
        "x-internal-actor": "notifications-worker",
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Audit sink failures must not break the call site.
  }
}

function cryptoRandomEventId(): string {
  // Hex random — events-worker accepts any opaque event id; this avoids
  // leaking provider message ids into the envelope.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i]!.toString(16).padStart(2, "0");
  return `evt_${hex}`;
}
