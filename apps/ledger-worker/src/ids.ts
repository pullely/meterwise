import { isUuid, uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i]!.toString(16).padStart(2, "0");
  return `req_${hex}`;
}

export const orgPublicId = (uuid: string): string => `org_${uuidToHex(uuid)}`;
export const parseOrgPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "org");

/** An LLM event in the ledger. */
export const eventPublicId = (uuid: string): string => `mwe_${uuidToHex(uuid)}`;
export const parseEventPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "mwe");

/** The reporting actor as stored: a UUID passes through, a public id (usr_/sp_) is kept verbatim. */
export function actorRef(subjectId: string): string {
  return isUuid(subjectId) ? subjectId : subjectId.slice(0, 64);
}
