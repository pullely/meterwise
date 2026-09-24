import { hexToUuid, uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";


export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `req_${hex}`;
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function parseOrgPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "org");
}

export function projectPublicId(uuid: string): string {
  return `prj_${uuidToHex(uuid)}`;
}

export function parseProjectPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "prj");
}

export function environmentPublicId(uuid: string): string {
  return `env_${uuidToHex(uuid)}`;
}

export function parseEnvironmentPublicId(publicId: string): string | null {
  if (!publicId.startsWith("env_")) return null;
  return hexToUuid(publicId.slice(4));
}
