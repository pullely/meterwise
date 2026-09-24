// Service-principal subject-ID helpers.
// The canonical subject-ID shape for service_principal actors is `sp_<hex32>`
// where <hex32> is the UUID of the service_principal row with dashes removed.
// This matches the format produced by identity-worker's bearer resolution
// (Task 0048) and forwarded via x-actor-subject-id.

const SP_PREFIX = "sp_";
const SP_ID_RE = /^sp_[0-9a-f]{32}$/;

/** Validate that a string matches the canonical sp_ subject-ID shape. */
export function isServicePrincipalSubjectId(id: string): boolean {
  return SP_ID_RE.test(id);
}

/** Build a canonical sp_ subject-ID from a raw UUID (with or without dashes). */
export function servicePrincipalSubjectId(uuid: string): string {
  return `${SP_PREFIX}${uuid.replace(/-/g, "")}`;
}

/** Extract the raw hex (no dashes) from a validated sp_ subject-ID, or null. */
export function parseServicePrincipalSubjectId(id: string): string | null {
  if (!SP_ID_RE.test(id)) return null;
  return id.slice(SP_PREFIX.length);
}
