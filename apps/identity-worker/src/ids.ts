import { hexToUuid, uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}



export function generateUserId(): string {
  return crypto.randomUUID();
}

export function generateSessionId(): string {
  return crypto.randomUUID();
}

export function generateChallengeId(): string {
  return crypto.randomUUID();
}

export function generateRequestId(): string {
  return `req_${randomHex(12)}`;
}

export function generateAuthIdentityId(): string {
  return crypto.randomUUID();
}

export function generateSecurityEventId(): string {
  return crypto.randomUUID();
}

export function generateCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const num = ((buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!) >>> 0;
  return String(num % 1000000).padStart(6, "0");
}

export function generateTokenSecret(): string {
  return randomHex(32);
}

export function userPublicId(uuid: string): string {
  return `usr_${uuidToHex(uuid)}`;
}

export function sessionPublicId(uuid: string): string {
  return `ses_${uuidToHex(uuid)}`;
}

export function challengePublicId(uuid: string): string {
  return `chl_${uuidToHex(uuid)}`;
}

export function parseChallengePublicId(publicId: string): string | null {
  if (!publicId.startsWith("chl_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function parseSessionToken(token: string): { sessionId: string; secret: string } | null {
  if (!token.startsWith("sps_ses_")) return null;
  const payload = token.slice(8);
  const dotIndex = payload.indexOf(".");
  if (dotIndex < 1) return null;
  const hexId = payload.slice(0, dotIndex);
  const secret = payload.slice(dotIndex + 1);
  if (!hexId || !secret) return null;
  const uuid = hexToUuid(hexId);
  if (!uuid) return null;
  return { sessionId: uuid, secret };
}

export function buildSessionToken(sessionUuid: string, secret: string): string {
  return `sps_ses_${uuidToHex(sessionUuid)}.${secret}`;
}

export function parseUserPublicId(publicId: string): string | null {
  if (!publicId.startsWith("usr_")) return null;
  return hexToUuid(publicId.slice(4));
}

/** Decode a public org id (`org_<32 hex>`) to the bare UUID used by UUID columns. */
export function parseOrgPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "org");
}

/** Decode a public project id (`prj_<32 hex>`) to the bare UUID used by the
 *  service_principals.project_id UUID column. */
export function parseProjectPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "prj");
}

/**
 * Decode any public subject id (`usr_<hex>`, service-principal subject id, …)
 * into the bare UUID used by identity UUID columns (`created_by`, `revoked_by`,
 * `security_events.user_id`). Returns null if there is no `<prefix>_<32 hex>`
 * shape. TEXT columns (event_log.actor_id, role_assignments.subject_id) keep the
 * public form, so callers only use this for the UUID-typed fields.
 */
export function parseSubjectUuid(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId);
}
