import { hexToUuid, uuidToHex } from "@saas/db/ids";
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

// support-action record public IDs (sa_<hex>).
export function supportActionPublicId(uuid: string): string {
  return `sa_${uuidToHex(uuid)}`;
}

export function parseSupportActionPublicId(publicId: string): string | null {
  if (!publicId.startsWith("sa_")) return null;
  return hexToUuid(publicId.slice(3));
}

// Organization public IDs (org_<hex>) — mirrors membership-worker.
export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function parseOrgPublicId(publicId: string): string | null {
  if (!publicId.startsWith("org_")) return null;
  return hexToUuid(publicId.slice(4));
}

// User public IDs (usr_<hex>) — mirrors identity-worker.
export function userPublicId(uuid: string): string {
  return `usr_${uuidToHex(uuid)}`;
}

export function parseUserPublicId(publicId: string): string | null {
  if (!publicId.startsWith("usr_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function generateSupportActionUuid(): string {
  // RFC-4122 v4 from getRandomValues; crypto.randomUUID may be unavailable in
  // some Workers contexts so we hand-roll for determinism in tests via deps.
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
