import {
  COST_DIMENSIONS,
  EVENT_ID_RE,
  LEDGER_MAX_AGE_DAYS,
  LEDGER_MAX_BATCH,
  LEDGER_MAX_FUTURE_MS,
  LEDGER_MAX_LATENCY_MS,
  LEDGER_MAX_TOKENS,
  LEDGER_MAX_WINDOW_DAYS,
  PROVIDER_RE,
  normalizeModel,
  type CostDimension,
} from "@saas/contracts/ledger";

export type Fields = Record<string, string[]>;
export type Validated<T> = { valid: true; value: T } | { valid: false; fields: Fields };

/** An event after validation, normalised: lower-cased provider and model, ISO occurredAt. */
export interface CleanEvent {
  eventId: string;
  tenant: string;
  feature: string | null;
  user: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number | null;
  occurredAt: string;
}

const DAY_MS = 86_400_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function attribution(v: unknown, max: number, required: boolean, out: string[]): string | null {
  if (v === undefined || v === null) {
    if (required) out.push("Required");
    return null;
  }
  if (typeof v !== "string") {
    out.push("Must be a string");
    return null;
  }
  const s = v.trim();
  if (s.length === 0) {
    if (required) out.push("Required");
    return null;
  }
  if (s.length > max) out.push(`At most ${max} characters`);
  // Control characters would corrupt the console's tables and CSV exports.
  if (/[\u0000-\u001f\u007f]/.test(s)) out.push("Must not contain control characters");
  return s;
}

function tokens(v: unknown, out: string[]): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > LEDGER_MAX_TOKENS) {
    out.push(`An integer from 0 to ${LEDGER_MAX_TOKENS}`);
    return 0;
  }
  return v;
}

/**
 * Validate a whole ingest batch before anything is written (design §3): any
 * invalid event makes the batch 422, naming `events[i].field`.
 */
export function validateIngestBody(body: unknown, now: Date): Validated<CleanEvent[]> {
  const fields: Fields = {};
  if (!isObject(body) || !Array.isArray(body.events)) {
    return { valid: false, fields: { events: ["Required: an array of 1 to 100 events"] } };
  }
  const events = body.events as unknown[];
  if (events.length < 1 || events.length > LEDGER_MAX_BATCH) {
    return { valid: false, fields: { events: [`Between 1 and ${LEDGER_MAX_BATCH} events`] } };
  }
  const clean: CleanEvent[] = [];
  events.forEach((raw, i) => {
    const at = (k: string): string[] => (fields[`events[${i}].${k}`] ??= []);
    if (!isObject(raw)) {
      (fields[`events[${i}]`] ??= []).push("Must be an object");
      return;
    }
    let eventId = "";
    if (typeof raw.eventId !== "string" || !EVENT_ID_RE.test(raw.eventId)) {
      at("eventId").push("1 to 128 characters of A-Z a-z 0-9 . _ : -");
    } else eventId = raw.eventId;

    const tenant = attribution(raw.tenant, 128, true, at("tenant")) ?? "";
    const feature = attribution(raw.feature, 64, false, at("feature"));
    const user = attribution(raw.user, 128, false, at("user"));

    let provider = "";
    if (typeof raw.provider !== "string" || !PROVIDER_RE.test(raw.provider.trim().toLowerCase())) {
      at("provider").push("A provider id such as openai or anthropic");
    } else provider = raw.provider.trim().toLowerCase();

    let model = "";
    if (typeof raw.model !== "string" || normalizeModel(raw.model).length === 0 || normalizeModel(raw.model).length > 128) {
      at("model").push("1 to 128 characters");
    } else if (/[\s\u0000-\u001f\u007f]/.test(normalizeModel(raw.model))) {
      at("model").push("Must not contain whitespace or control characters");
    } else model = normalizeModel(raw.model);

    const inputTokens = tokens(raw.inputTokens, at("inputTokens"));
    const outputTokens = tokens(raw.outputTokens, at("outputTokens"));

    let latencyMs: number | null = null;
    if (raw.latencyMs !== undefined && raw.latencyMs !== null) {
      if (typeof raw.latencyMs !== "number" || !Number.isInteger(raw.latencyMs) || raw.latencyMs < 0 || raw.latencyMs > LEDGER_MAX_LATENCY_MS) {
        at("latencyMs").push(`An integer from 0 to ${LEDGER_MAX_LATENCY_MS}`);
      } else latencyMs = raw.latencyMs;
    }

    let occurredAt = now.toISOString();
    if (raw.occurredAt !== undefined && raw.occurredAt !== null) {
      const t = typeof raw.occurredAt === "string" ? Date.parse(raw.occurredAt) : NaN;
      if (Number.isNaN(t)) at("occurredAt").push("An ISO-8601 timestamp");
      else if (t > now.getTime() + LEDGER_MAX_FUTURE_MS) at("occurredAt").push("At most 5 minutes in the future");
      else if (t < now.getTime() - LEDGER_MAX_AGE_DAYS * DAY_MS) at("occurredAt").push(`At most ${LEDGER_MAX_AGE_DAYS} days in the past`);
      else occurredAt = new Date(t).toISOString();
    }
    clean.push({ eventId, tenant, feature, user, provider, model, inputTokens, outputTokens, latencyMs, occurredAt });
  });
  for (const k of Object.keys(fields)) if (fields[k]!.length === 0) delete fields[k];
  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, value: clean };
}

export interface CostQuery {
  by: CostDimension;
  from: string;
  to: string;
  /** [fromIso, toIso) */
  fromIso: string;
  toIso: string;
  tenant?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s: string): number | null {
  if (!DATE_RE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? null : t;
}

/** `by`, `from`, `to` (inclusive UTC dates; default: the month to date) and an optional tenant filter. */
export function validateCostQuery(params: URLSearchParams, now: Date): Validated<CostQuery> {
  const fields: Fields = {};
  const by = (params.get("by") ?? "tenant") as CostDimension;
  if (!(COST_DIMENSIONS as readonly string[]).includes(by)) fields.by = [`One of ${COST_DIMENSIONS.join(", ")}`];
  const today = now.toISOString().slice(0, 10);
  const from = params.get("from") ?? `${today.slice(0, 7)}-01`;
  const to = params.get("to") ?? today;
  const f = parseDate(from);
  const t = parseDate(to);
  if (f === null) fields.from = ["A date, YYYY-MM-DD"];
  if (t === null) fields.to = ["A date, YYYY-MM-DD"];
  if (f !== null && t !== null) {
    if (t < f) fields.to = ["Must not be before from"];
    else if ((t - f) / DAY_MS + 1 > LEDGER_MAX_WINDOW_DAYS) fields.to = [`The window is at most ${LEDGER_MAX_WINDOW_DAYS} days`];
  }
  const tenantRaw = params.get("tenant");
  let tenant: string | undefined;
  if (tenantRaw !== null) {
    const errs: string[] = [];
    tenant = attribution(tenantRaw, 128, true, errs) ?? undefined;
    if (errs.length) fields.tenant = errs;
  }
  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return {
    valid: true,
    value: {
      by,
      from,
      to,
      fromIso: new Date(f!).toISOString(),
      toIso: new Date(t! + DAY_MS).toISOString(),
      ...(tenant !== undefined ? { tenant } : {}),
    },
  };
}

export interface EventsQuery {
  tenant?: string;
  feature?: string;
  model?: string;
  /** Paging cursor from the previous page: `<receivedAt>~<uuid>`. */
  before?: { at: string; id: string };
  limit: number;
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([0-9a-f-]{36})$/;

export function eventsCursor(receivedAt: string, id: string): string {
  return `${receivedAt}~${id}`;
}

export function validateEventsQuery(params: URLSearchParams): Validated<EventsQuery> {
  const fields: Fields = {};
  const q: EventsQuery = { limit: 50 };
  for (const k of ["tenant", "feature", "model"] as const) {
    const v = params.get(k);
    if (v === null) continue;
    const errs: string[] = [];
    const s = attribution(v, 128, true, errs);
    if (errs.length) fields[k] = errs;
    else if (s !== null) q[k] = k === "model" ? normalizeModel(s) : s;
  }
  const before = params.get("before");
  if (before !== null) {
    const m = before.match(CURSOR_RE);
    if (!m) fields.before = ["A cursor from a previous page's nextBefore"];
    else q.before = { at: m[1]!, id: m[2]! };
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) fields.limit = ["An integer from 1 to 200"];
    else q.limit = n;
  }
  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, value: q };
}
