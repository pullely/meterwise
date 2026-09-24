// Branded UUID identifier shared by all repository inputs.
//
// Public ids cross the API boundary as `<prefix>_<32 hex>` (a UUID with dashes
// stripped); most DB columns store a bare UUID. Both are `string`, so passing
// the public form into a UUID column compiles but fails at runtime
// (`invalid input syntax for type uuid`). `Uuid` is a nominal/branded string:
// repository inputs bound to UUID columns are typed `Uuid`, so a caller can only
// satisfy them by going through `uuidFromPublicId` / `asUuid`, which makes a
// missing decode a *compile error* rather than a runtime crash.

declare const uuidBrand: unique symbol;
export type Uuid = string & { readonly [uuidBrand]: true };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;

/** Type guard: true when `value` is a canonical UUID. */
export function isUuid(value: string): value is Uuid {
  return UUID_RE.test(value);
}

/** Assert that a string is a UUID and brand it. Throws on a non-UUID. */
export function asUuid(value: string): Uuid {
  if (!UUID_RE.test(value)) throw new Error("asUuid: value is not a canonical UUID");
  return value as Uuid;
}

/**
 * Decode a public id of the form `<prefix>_<32 hex>` (e.g. `org_7c82…`,
 * `usr_…`) into a branded `Uuid`. Returns null if the prefix or hex body is
 * malformed. Pass the expected prefix to enforce the id kind, or omit it to
 * accept any `<prefix>_<32 hex>` (handy for actor ids that may be `usr_`/`sp_`).
 */
export function uuidFromPublicId(publicId: string, prefix?: string): Uuid | null {
  const sep = publicId.indexOf("_");
  if (sep < 1) return null;
  if (prefix !== undefined && publicId.slice(0, sep) !== prefix) return null;
  return hexToUuid(publicId.slice(sep + 1)) as Uuid | null;
}

// ── Public-id ⇄ UUID conversion primitives ──────────────────
// Shared so the 10 workers stop each carrying an identical private copy.

/** Strip the dashes from a UUID to form the hex body of a public id. */
export function uuidToHex(uuid: string): string {
  return uuid.replace(/-/g, "");
}

/** Re-insert dashes into a 32-char hex body; null if not 32 hex chars. */
export function hexToUuid(hex: string): string | null {
  if (!HEX32_RE.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
