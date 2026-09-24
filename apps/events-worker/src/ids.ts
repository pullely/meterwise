import { hexToUuid, uuidToHex } from "@saas/db/ids";


export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `req_${hex}`;
}

export function parseOrgPublicId(publicId: string): string | null {
  if (!publicId.startsWith("org_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function projectPublicId(uuid: string): string {
  return `prj_${uuidToHex(uuid)}`;
}

export function environmentPublicId(uuid: string): string {
  return `env_${uuidToHex(uuid)}`;
}

export function invitationPublicId(uuid: string): string {
  return `inv_${uuidToHex(uuid)}`;
}

export function memberPublicId(uuid: string): string {
  return `mem_${uuidToHex(uuid)}`;
}

const SUBJECT_KIND_PREFIX: Record<string, (uuid: string) => string> = {
  organization: orgPublicId,
  project: projectPublicId,
  environment: environmentPublicId,
  invitation: invitationPublicId,
  member: memberPublicId,
};

export function toPublicId(kind: string, rawId: string): string {
  const fn = SUBJECT_KIND_PREFIX[kind];
  if (fn) return fn(rawId);
  return rawId;
}

export function toPublicScopeId(prefix: string, rawId: string | null): string | null {
  if (!rawId) return null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(rawId)) return rawId;
  return `${prefix}${uuidToHex(rawId)}`;
}
