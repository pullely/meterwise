import { asUuid, type Uuid } from "@saas/db/ids";

// Deterministic id fixtures.
//
// Tests historically used human-readable fake ids (`org-001`, `usr_aabbccdd`)
// that are NOT valid UUIDs / `<prefix>_<32 hex>` public ids. That both masked
// the public-id↔UUID-column bug class and blocks the `Uuid` brand (a fake id
// can't satisfy a `Uuid`-typed repo input). These helpers mint *valid*,
// *deterministic* ids from a seed label so fixtures are stable across runs and
// the public form always decodes to the matching UUID.

/** Deterministic 32-char hex derived from a seed (dependency-free mixer). */
function hex32(seed: string): string {
  let h1 = (0x9e3779b9 ^ seed.length) >>> 0;
  let h2 = 0x85ebca6b;
  let h3 = 0xc2b2ae35;
  let h4 = 0x27d4eb2f;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
    h3 = Math.imul(h3 ^ c, 374761393);
    h4 = Math.imul(h4 ^ c, 3266489917);
  }
  const part = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return part(h1) + part(h2) + part(h3) + part(h4);
}

function format(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A stable, valid (branded) UUID derived from a seed label. */
export function testUuid(seed: string): Uuid {
  return asUuid(format(hex32(seed)));
}

/** The matching public id `<prefix>_<32 hex>` whose decoded form === testUuid(seed). */
export function testPublicId(prefix: string, seed: string): string {
  return `${prefix}_${hex32(seed)}`;
}

/** Both representations for one seed — `{ uuid, publicId }`. */
export function testId(prefix: string, seed: string): { uuid: Uuid; publicId: string } {
  return { uuid: testUuid(seed), publicId: testPublicId(prefix, seed) };
}
