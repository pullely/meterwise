import { hexToUuid, uuidToHex, uuidFromPublicId, type Uuid } from "@saas/db/ids";

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `req_${hex}`;
}

/** RFC-4122 v4 UUID for new rows and event ids. */
export function generateUuid(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  buf[6] = (buf[6]! & 0x0f) | 0x40;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseOrgPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "org");
}

export function parseProjectPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "prj");
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function projectPublicId(uuid: string): string {
  return `prj_${uuidToHex(uuid)}`;
}

export function connectionPublicId(uuid: string): string {
  return `int_${uuidToHex(uuid)}`;
}

export function parseConnectionPublicId(publicId: string): string | null {
  if (!publicId.startsWith("int_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function repoLinkPublicId(uuid: string): string {
  return `repl_${uuidToHex(uuid)}`;
}

export function parseRepoLinkPublicId(publicId: string): string | null {
  if (!publicId.startsWith("repl_")) return null;
  return hexToUuid(publicId.slice(5));
}

export function inboundDeliveryPublicId(uuid: string): string {
  return `igd_${uuidToHex(uuid)}`;
}

export function parseInboundDeliveryPublicId(publicId: string): string | null {
  if (!publicId.startsWith("igd_")) return null;
  return hexToUuid(publicId.slice(4));
}
