import type { Env } from "./env.js";
import type { ProxyActor } from "./auth.js";

// proxy-worker → ledger-worker, over the LEDGER_WORKER service binding. These
// requests carry the resolved actor and structured fields only: no header or
// body from the customer's request is copied into them (design §7.2, test 5).

export interface Tags {
  tenant: string;
  feature: string | null;
  user: string | null;
}

export interface CheckAnswer {
  decision: "allow" | "warn" | "deny" | "downgrade";
  model: string;
}

function actorHeaders(actor: ProxyActor, requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-request-id": requestId,
    "x-actor-subject-id": actor.subjectId,
    "x-actor-subject-type": actor.subjectType,
  };
}

/** MW2's pre-flight check. Null when the ledger could not answer (the proxy then forwards: availability over enforcement). */
export async function checkBudget(env: Env, actor: ProxyActor, tags: Tags, model: string, requestId: string): Promise<CheckAnswer | null> {
  if (!env.LEDGER_WORKER) return null;
  try {
    const res = await env.LEDGER_WORKER.fetch(`https://ledger.internal/v1/organizations/${actor.org}/llm-check`, {
      method: "POST",
      headers: actorHeaders(actor, requestId),
      body: JSON.stringify({ tenant: tags.tenant, feature: tags.feature, user: tags.user, provider: "openai", model }),
    });
    if (!res.ok) return null;
    const data = ((await res.json()) as { data?: { decision?: unknown; model?: unknown } }).data;
    if (!data || typeof data.model !== "string") return null;
    if (data.decision === "allow" || data.decision === "warn" || data.decision === "deny" || data.decision === "downgrade") {
      return { decision: data.decision, model: data.model };
    }
    return null;
  } catch {
    return null;
  }
}

export interface MeteredCall {
  eventId: string;
  tags: Tags;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  occurredAt: string;
  usageComplete: boolean;
}

/** Report one call to ledger-worker's internal proxy route. True when the ledger stored it. */
export async function reportCall(env: Env, actor: ProxyActor, call: MeteredCall, requestId: string): Promise<boolean> {
  if (!env.LEDGER_WORKER) return false;
  try {
    const res = await env.LEDGER_WORKER.fetch(`https://ledger.internal/v1/internal/organizations/${actor.org}/proxy-events`, {
      method: "POST",
      headers: { ...actorHeaders(actor, requestId), "x-internal-caller": "proxy-worker" },
      body: JSON.stringify({
        usageComplete: call.usageComplete,
        event: {
          eventId: call.eventId,
          tenant: call.tags.tenant,
          feature: call.tags.feature,
          user: call.tags.user,
          provider: "openai",
          model: call.model,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          latencyMs: call.latencyMs,
          occurredAt: call.occurredAt,
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
