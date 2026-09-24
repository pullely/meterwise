const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DecodedCursor {
  version: number;
  occurredAt: string;
  id: string;
}

export interface PageParams {
  limit: number;
  cursor: DecodedCursor | null;
}

export type ParsePageResult =
  | { ok: true; value: PageParams }
  | { ok: false; field: string; reason: string };

export function parsePageParams(url: URL): ParsePageResult {
  const limitParam = url.searchParams.get("limit");
  const cursorParam = url.searchParams.get("cursor");

  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return { ok: false, field: "limit", reason: "Must be an integer between 1 and 100" };
    }
    limit = parsed;
  }

  let cursor: DecodedCursor | null = null;
  if (cursorParam !== null) {
    cursor = decodeCursor(cursorParam);
    if (!cursor) {
      return { ok: false, field: "cursor", reason: "Invalid cursor" };
    }
  }

  return { ok: true, value: { limit, cursor } };
}

export function encodeCursor(occurredAt: string, id: string): string {
  const payload = JSON.stringify({ v: CURSOR_VERSION, t: occurredAt, i: id });
  return btoa(payload);
}

export function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const decoded = atob(raw);
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.v !== CURSOR_VERSION ||
      typeof parsed.t !== "string" ||
      typeof parsed.i !== "string" ||
      !ISO_TS_RE.test(parsed.t) ||
      !UUID_RE.test(parsed.i)
    ) {
      return null;
    }
    return { version: parsed.v as number, occurredAt: parsed.t, id: parsed.i };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit filters (Task 0121 — actor / resource / action / time-range)
// ---------------------------------------------------------------------------

/** Conservative identifier charset, mirroring CATEGORY_RE bounds. */
const FILTER_VALUE_RE = /^[A-Za-z0-9_.:\-]{1,128}$/;

/** Closed actor-type set (EventActorType in @saas/contracts/events). */
const ACTOR_TYPES = new Set(["user", "service_principal", "workflow", "system"]);

export interface AuditFilterParams {
  actorId?: string;
  actorType?: string;
  subjectKind?: string;
  subjectId?: string;
  eventType?: string;
  from?: string;
  to?: string;
}

export type ParseAuditFiltersResult =
  | { ok: true; value: AuditFilterParams }
  | { ok: false; field: string; reason: string };

/**
 * Parse + validate the optional org-audit filter query params.
 *
 * Rules:
 *  - empty / missing params are ignored (not errors),
 *  - `from`/`to` MUST match the ISO ms Z shape (same as the cursor timestamp),
 *  - `actorType` MUST be a known EventActorType,
 *  - `actorId`/`subjectKind`/`subjectId`/`eventType` MUST match a bounded,
 *    safe identifier charset.
 *
 * Validation only — no SQL is constructed here; the repository builds the
 * parameterized clauses from the returned, already-validated values.
 */
export function parseAuditFilters(url: URL): ParseAuditFiltersResult {
  const value: AuditFilterParams = {};

  const ident: Array<[keyof AuditFilterParams, string]> = [
    ["actorId", "actorId"],
    ["subjectKind", "subjectKind"],
    ["subjectId", "subjectId"],
    ["eventType", "eventType"],
  ];
  for (const [key, param] of ident) {
    const raw = url.searchParams.get(param);
    if (raw === null || raw === "") continue;
    if (!FILTER_VALUE_RE.test(raw)) {
      return {
        ok: false,
        field: param,
        reason: "Must be 1-128 chars of letters, numbers, underscore, dot, colon, or hyphen",
      };
    }
    value[key] = raw;
  }

  const actorType = url.searchParams.get("actorType");
  if (actorType !== null && actorType !== "") {
    if (!ACTOR_TYPES.has(actorType)) {
      return {
        ok: false,
        field: "actorType",
        reason: "Must be one of: user, service_principal, workflow, system",
      };
    }
    value.actorType = actorType;
  }

  for (const param of ["from", "to"] as const) {
    const raw = url.searchParams.get(param);
    if (raw === null || raw === "") continue;
    if (!ISO_TS_RE.test(raw)) {
      return {
        ok: false,
        field: param,
        reason: "Must be an ISO-8601 timestamp with milliseconds (e.g. 2026-01-01T00:00:00.000Z)",
      };
    }
    value[param] = raw;
  }

  return { ok: true, value };
}
