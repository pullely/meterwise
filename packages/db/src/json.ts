// Column decoding for D1.
//
// SQLite stores fewer types than the schema names. Two of them need a decoder
// on every read, and both live here so the rules are stated once.
//
// JSON columns on D1.
//
// SQLite has no JSON type: the JSON-shaped columns in this schema are TEXT
// holding a serialized document, so every read has to parse and every write
// has to stringify. Repositories write with `JSON.stringify`; this is the
// matching read side, in one place so that "what does a malformed value do"
// has exactly one answer.
//
// Malformed content falls back rather than throwing. A row whose metadata blob
// cannot be parsed is still a row the caller asked for — losing the whole read
// (and, through it, a login or an invoice list) over an unreadable side-car
// document is the worse failure.

export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    const parsed: unknown = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** Nullable variant: an absent document stays `null` instead of collapsing to
 *  an empty object, which callers use to distinguish "never set" from "set to
 *  {}" (billing/metering metadata both rely on it). */
export function parseNullableJsonColumn<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Boolean columns on D1.
 *
 * SQLite has no boolean type — the schema declares INTEGER and stores 0 or 1,
 * so a raw read yields a number that is truthy for 0 only in the sense JS
 * disagrees with. Every boolean column read goes through here.
 *
 * The string forms ("1"/"true"/"t") are accepted because a value that made a
 * round trip through JSON or a text-typed expression arrives as text, and
 * failing that quietly to `false` is the kind of bug that only shows up on one
 * code path in production.
 */
export function parseBooleanColumn(value: unknown, fallback = false): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "t") return true;
    if (v === "0" || v === "false" || v === "f" || v === "") return false;
  }
  return fallback;
}
