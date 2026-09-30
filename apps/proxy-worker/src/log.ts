// Rule 2 (design §7.4): the ONLY log call in this Worker. Its fields are
// numbers, fixed enums, or strings this Worker generated or resolved and then
// checked against a strict shape (a request id, an org id, a model name).
// Nothing from a header or a body reaches it unchecked; the object is built
// field by field, never spread, so no extra property can ride along.

export type Route = "chat_completions" | "health" | "other";
export type Outcome =
  | "ok"
  | "upstream_error"
  | "invalid_request"
  | "unauthenticated"
  | "budget_exceeded"
  | "upstream_unreachable"
  | "upstream_timeout"
  | "unavailable"
  | "not_found";

export interface LogFields {
  requestId: string;
  org: string | null;
  route: Route;
  outcome: Outcome;
  status: number;
  upstreamStatus: number | null;
  latencyMs: number;
  model: string | null;
  tokens: { input: number; output: number } | null;
  metered: boolean;
}

export const LOG_KEYS = ["requestId", "org", "route", "outcome", "status", "upstreamStatus", "latencyMs", "model", "tokens", "metered"] as const;

const REQUEST_ID_RE = /^px_[0-9a-f]{24}$/;
const ORG_RE = /^org_[0-9a-f]{32}$/;
const MODEL_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

const int = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/** Shaped like a secret key rather than a model: never logged, never forwarded (defence in depth). */
export const KEY_SHAPED_RE = /^(sk|rk|pk)[-_]/i;

export function safeModel(model: unknown): string | null {
  return typeof model === "string" && MODEL_RE.test(model) && !KEY_SHAPED_RE.test(model) ? model : null;
}

export function logEvent(f: LogFields): void {
  const line = {
    requestId: REQUEST_ID_RE.test(f.requestId) ? f.requestId : "invalid",
    org: f.org !== null && ORG_RE.test(f.org) ? f.org : null,
    route: f.route,
    outcome: f.outcome,
    status: int(f.status),
    upstreamStatus: f.upstreamStatus === null ? null : int(f.upstreamStatus),
    latencyMs: int(f.latencyMs),
    model: safeModel(f.model),
    tokens: f.tokens === null ? null : { input: int(f.tokens.input), output: int(f.tokens.output) },
    metered: f.metered === true,
  };
  console.log(JSON.stringify(line));
}
