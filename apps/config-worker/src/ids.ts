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

export function parseProjectPublicId(publicId: string): string | null {
  if (!publicId.startsWith("prj_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function parseEnvironmentPublicId(publicId: string): string | null {
  if (!publicId.startsWith("env_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function settingPublicId(uuid: string): string {
  return `stg_${uuidToHex(uuid)}`;
}

export function featureFlagPublicId(uuid: string): string {
  return `flg_${uuidToHex(uuid)}`;
}

export function secretMetadataPublicId(uuid: string): string {
  return `sec_${uuidToHex(uuid)}`;
}

export function parseSettingPublicId(publicId: string): string | null {
  if (!publicId.startsWith("stg_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function parseFeatureFlagPublicId(publicId: string): string | null {
  if (!publicId.startsWith("flg_")) return null;
  return hexToUuid(publicId.slice(4));
}

export function parseSecretMetadataPublicId(publicId: string): string | null {
  if (!publicId.startsWith("sec_")) return null;
  return hexToUuid(publicId.slice(4));
}
