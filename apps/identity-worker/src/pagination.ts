/**
 * Pagination helpers for identity-worker security-event listing.
 * Follows the same cursor semantics as events-worker/src/pagination.ts
 * but is a local copy to avoid cross-app dependencies.
 */

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
