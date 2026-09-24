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

export function webhookEndpointPublicId(uuid: string): string {
  return `whe_${uuidToHex(uuid)}`;
}

export function parseWebhookEndpointPublicId(publicId: string): string | null {
  if (!publicId.startsWith("whe_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function webhookSubscriptionPublicId(uuid: string): string {
  return `whs_${uuidToHex(uuid)}`;
}

export function parseWebhookSubscriptionPublicId(publicId: string): string | null {
  if (!publicId.startsWith("whs_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function webhookDeliveryAttemptPublicId(uuid: string): string {
  return `whd_${uuidToHex(uuid)}`;
}

export function parseWebhookDeliveryAttemptPublicId(publicId: string): string | null {
  if (!publicId.startsWith("whd_")) return null;
  return hexToUuid(publicId.slice(4));
}
