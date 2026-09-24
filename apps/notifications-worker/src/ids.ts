import { hexToUuid, uuidToHex, uuidFromPublicId, asUuid, type Uuid } from "@saas/db/ids";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function notificationPublicId(uuid: string): string {
  return `ntf_${uuidToHex(uuid)}`;
}

export function parseNotificationPublicId(publicId: string): string | null {
  if (publicId.startsWith("ntf_")) {
    return hexToUuid(publicId.slice(4));
  }
  // Accept raw UUIDs too — internal callers may pass either shape.
  if (UUID_RE.test(publicId)) return publicId.toLowerCase();
  return null;
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function parseOrgIdInput(value: string): Uuid | null {
  if (value.startsWith("org_")) {
    return uuidFromPublicId(value, "org");
  }
  if (UUID_RE.test(value)) return asUuid(value.toLowerCase());
  return null;
}
