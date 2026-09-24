import { hexToUuid, uuidToHex, uuidFromPublicId, type Uuid } from "@saas/db/ids";
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}



export function generateRequestId(): string {
  return `req_${randomHex(12)}`;
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function parseOrgPublicId(id: string): Uuid | null {
  return uuidFromPublicId(id, "org");
}

export function memberPublicId(uuid: string): string {
  return `mem_${uuidToHex(uuid)}`;
}

export function parseMemberPublicId(publicId: string): string | null {
  if (!publicId.startsWith("mem_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function invitationPublicId(uuid: string): string {
  return `inv_${uuidToHex(uuid)}`;
}

export function parseInvitationPublicId(publicId: string): string | null {
  if (!publicId.startsWith("inv_")) return null;
  return hexToUuid(publicId.slice(4));
}

export async function hashToken(raw: string): Promise<string> {
  const encoded = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  let hash = "";
  for (let i = 0; i < hashArray.length; i++) {
    hash += hashArray[i]!.toString(16).padStart(2, "0");
  }
  return hash;
}

export async function generateInvitationToken(): Promise<{ raw: string; hash: string }> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let raw = "";
  for (let i = 0; i < buf.length; i++) {
    raw += buf[i]!.toString(16).padStart(2, "0");
  }
  const hash = await hashToken(raw);
  return { raw, hash };
}
