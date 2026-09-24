// Cursor pagination for support-action reads. Mirrors the membership-worker
// pagination shape but keys off (occurred_at, id) since the support ledger
// orders by occurrence time. The encoded cursor is an opaque base64 token.

const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SupportPageParams {
  limit: number;
  cursor: { occurredAt: string; id: string } | null;
}

export type ParsePageResult =
  | { ok: true; value: SupportPageParams }
  | { ok: false; field: string; reason: string };

export function parseSupportPageParams(url: URL): ParsePageResult {
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

  let cursor: { occurredAt: string; id: string } | null = null;
  if (cursorParam !== null) {
    cursor = decodeSupportCursor(cursorParam);
    if (!cursor) {
      return { ok: false, field: "cursor", reason: "Invalid cursor" };
    }
  }

  return { ok: true, value: { limit, cursor } };
}

export function encodeSupportCursor(occurredAt: string, id: string): string {
  return btoa(JSON.stringify({ v: CURSOR_VERSION, t: occurredAt, i: id }));
}

export function decodeSupportCursor(raw: string): { occurredAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(atob(raw)) as Record<string, unknown>;
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
    return { occurredAt: parsed.t as string, id: parsed.i as string };
  } catch {
    return null;
  }
}
